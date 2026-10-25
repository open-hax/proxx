(ns proxx.keypool.pool-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.keypool.pool :as pool]))

(defn- cred
  ([pid aid] (cred pid aid {}))
  ([pid aid extra] (merge {:provider-id pid :account-id aid :token (str "tok-" aid) :auth-type :api-key} extra)))

(defn- state-with
  ([accounts] (state-with accounts {}))
  ([accounts extra]
   (merge pool/empty-state
          {:providers {"p" {:auth-type :api-key :accounts accounts :next-offset 0}}}
          extra)))

(def now 1700000000000)
(def a (cred "p" "a"))
(def b (cred "p" "b"))
(def c (cred "p" "c"))

(defn- ids [creds] (mapv :account-id creds))

(deftest park-miller-is-portable-and-bounded
  (let [draws (take 1000 (map first (rest (iterate (fn [[_ s]] (pool/next-double s)) [0 42]))))]
    (is (every? #(and (> % 0) (< % 1)) draws))
    (is (= (take 5 draws) (take 5 (map first (rest (iterate (fn [[_ s]] (pool/next-double s)) [0 42])))))
        "deterministic for a seed"))
  (is (= [0.25 [0.5]] (pool/next-double [0.25 0.5])) "tapes replay in order")
  (is (thrown? js/Error (pool/next-double []))))

(deftest weighted-shuffle-is-a-permutation
  (doseq [seed [1 7 99 12345]]
    (let [[out _] (pool/weighted-shuffle [1 2 3 4 5] seed)]
      (is (= [1 2 3 4 5] (sort out)))))
  (is (= [[:x] 5] (pool/weighted-shuffle [:x] 5)) "singletons consume no randomness")
  (testing "tape semantics: weights first, then one pick per round"
    ;; weights .5+r: [0.5 1.5]; total 2; target .5*2=1 -> first cumulative>=1 is index 1
    (is (= [[:b :a] []] (pool/weighted-shuffle [:a :b] [0.0 1.0 0.5 0.0])))))

(deftest request-order-rotates-and-groups
  (let [state (state-with [a b c])
        [o1 s1] (pool/request-order state "p" now {})
        [o2 s2] (pool/request-order s1 "p" now {})
        [o3 _] (pool/request-order s2 "p" now {})]
    (is (= ["a" "b" "c"] (ids o1)))
    (is (= ["b" "c" "a"] (ids o2)) "offset advances each call")
    (is (= ["c" "a" "b"] (ids o3)))
    (is (= 1 (get-in s1 [:providers "p" :next-offset])))))

(deftest request-order-filters-by-facts
  (let [state (state-with [(cred "p" "disabled") (cred "p" "expired" {:expires-at (+ now 1000)})
                           (cred "p" "cool") (cred "p" "busy") (cred "p" "idle")]
                          {:disabled #{["p" "disabled"]}
                           :cooldowns {["p" "cool"] (+ now 5000)}
                           :in-flight {["p" "busy"] 2}})
        [order _] (pool/request-order state "p" now {})]
    (is (= ["idle" "busy"] (ids order)) "idle before busy; cooling excluded unless random-walk")
    (is (= ["busy" "idle"] (ids (first (pool/request-order (assoc-in state [:in-flight] {}) "p" now {}))))
        "with nothing in flight, rotation order decides")
    (testing "expiry buffer is configurable"
      (is (some #{"expired"} (ids (first (pool/request-order state "p" now {:expiry-buffer-ms 0}))))))
    (testing "an unknown or empty provider is an error"
      (is (thrown-with-msg? js/Error #"No accounts configured for provider: nope" (pool/request-order state "nope" now {})))
      (is (thrown-with-msg? js/Error #"provider: default" (pool/request-order state "  " now {}))))))

(deftest random-walk-admits-expired-cooldowns-only
  (let [state (state-with [a b (cred "p" "cool")] {:cooldowns {["p" "cool"] (+ now 10000)} :rng 3})
        [order s'] (pool/request-order state "p" now {:random-walk? true :jitter-factor 0.4})]
    (is (= #{"a" "b"} (set (ids order))) "cooling account jittered into the future stays out")
    (is (not= (:rng state) (:rng s')) "randomness was consumed and threaded"))
  (testing "with an overwhelming jitter a cooling account can come back"
    (let [state (state-with [(cred "p" "cool")] {:cooldowns {["p" "cool"] (+ now 10000)}
                                                  :rng [0.0]})
          [order _] (pool/request-order state "p" now {:random-walk? true :jitter-factor 2})]
      (is (= ["cool"] (ids order))))))

(deftest refresh-plan-separates-refreshable-expired
  (let [expired (+ now 1000)
        state (state-with [(cred "p" "ok") (cred "p" "exp" {:expires-at expired :refresh-token "r"})
                           (cred "p" "exp-no-refresh" {:expires-at expired})
                           (cred "p" "cool-exp" {:expires-at expired :refresh-token "r"})]
                          {:cooldowns {["p" "cool-exp"] (+ now 9000)}})
        [{:keys [ready refresh]} s'] (pool/refresh-plan state "p" now {})]
    (is (= ["ok"] (ids ready)))
    (is (= ["exp"] (ids refresh)) "cooling accounts are not worth refreshing; refresh-less ones are unusable")
    (is (= state s') "no rotation, no randomness")))

(deftest in-flight-accounting
  (let [s (-> pool/empty-state (pool/mark-in-flight a) (pool/mark-in-flight a))]
    (is (= 2 (get-in s [:in-flight ["p" "a"]])))
    (is (= 1 (get-in (pool/release-in-flight s a) [:in-flight ["p" "a"]])))
    (is (= {} (:in-flight (-> s (pool/release-in-flight a) (pool/release-in-flight a)))))
    (is (= {} (:in-flight (pool/release-in-flight pool/empty-state a))) "releasing the unheld is a no-op")))

(deftest rate-limiting
  (let [opts {:default-cooldown-ms 30000 :jitter-factor 0.4}
        ;; r=0.5 -> zero jitter
        [until s] (pool/mark-rate-limited (assoc pool/empty-state :rng [0.5 0.5]) a nil now opts)]
    (is (= (+ now 30000) until))
    (is (= until (get-in s [:cooldowns ["p" "a"]])))
    (is (= 1 (get-in s [:streaks ["p" "a"]])))
    (let [[until2 s2] (pool/mark-rate-limited s a 500 now opts)]
      (is (= (+ now 1000) until2) "cooldowns have a one second floor")
      (is (= 2 (get-in s2 [:streaks ["p" "a"]])))))
  (testing "jitter spans +-factor around the base"
    (let [lo (first (pool/mark-rate-limited (assoc pool/empty-state :rng [0.0]) a 10000 now {:jitter-factor 0.4}))
          hi (first (pool/mark-rate-limited (assoc pool/empty-state :rng [1.0]) a 10000 now {:jitter-factor 0.4}))]
      (is (= (+ now 6000) lo))
      (is (= (+ now 14000) hi)))))

(deftest model-unsupported-marks
  (let [[until s] (pool/mark-model-unsupported (assoc pool/empty-state :rng [0.5]) a "  GPT-5 " nil now {:default-cooldown-ms 5000})]
    (is (= (+ now 5000) until))
    (is (pool/model-unsupported? s "p" "a" "gpt-5" now))
    (is (not (pool/model-unsupported? s "p" "a" "gpt-5" (+ until 1))) "marks lapse by time alone")
    (is (not (pool/model-unsupported? s "p" "b" "gpt-5" now)))
    (is (not (pool/model-unsupported? (pool/clear-model-unsupported s "p" "a" "GPT-5") "p" "a" "gpt-5" now))))
  (is (= [nil pool/empty-state] (pool/mark-model-unsupported pool/empty-state a "  " nil now {})))
  (is (not (pool/model-unsupported? pool/empty-state "p" "a" "" now))))

(deftest cooldown-editing
  (let [[persisted s] (pool/set-account-cooldown-until pool/empty-state " p " "a" (+ now 5000) now)]
    (is (= (+ now 5000) persisted))
    (is (= {["p" "a"] (+ now 5000)} (:cooldowns s)) "provider ids are normalized")
    (let [[persisted2 s2] (pool/set-account-cooldown-until s "p" "a" (- now 1) now)]
      (is (= 0 persisted2))
      (is (= {} (:cooldowns s2))))
    (testing "seconds-since-epoch deadlines are understood"
      (let [[persisted3 _] (pool/set-account-cooldown-until pool/empty-state "p" "a" 1900000000 now)]
        (is (= 1900000000000 persisted3))))
    (let [s3 (assoc s :streaks {["p" "a"] 3})]
      (is (= {:cooldowns {} :streaks {}} (select-keys (pool/clear-account-cooldown s3 "p" "a") [:cooldowns :streaks]))))
    (let [s4 (assoc pool/empty-state :cooldowns {["p" "a"] 1 ["p" "b"] 2 ["q" "z"] 3} :streaks {["p" "a"] 1 ["q" "z"] 1})
          [cleared s5] (pool/clear-provider-cooldowns s4 "p")]
      (is (= #{"a" "b"} (set cleared)))
      (is (= {["q" "z"] 3} (:cooldowns s5)))
      (is (= {["q" "z"] 1} (:streaks s5))))))

(deftest disabling-and-credential-swap
  (let [s (pool/disable-account pool/empty-state " p " "a")]
    (is (pool/account-disabled? s "p" "a"))
    (is (not (pool/account-disabled? (pool/enable-account s "p" "a") "p" "a"))))
  (let [s (state-with [a b])
        a2 (assoc a :token "rotated")]
    (is (= "rotated" (-> (pool/update-account-credential s "p" a a2) (get-in [:providers "p" :accounts 0 :token]))))
    (is (= s (pool/update-account-credential s "p" (cred "p" "zzz") a2)))
    (is (= s (pool/update-account-credential s "nope" a a2)))))

(deftest replacing-providers-preserves-and-prunes
  (let [old (-> (state-with [a b c] {:cooldowns {["p" "a"] (+ now 1) ["p" "gone"] (+ now 1)}
                                      :in-flight {["p" "gone"] 1}
                                      :streaks {["p" "gone"] 1 ["p" "b"] 1}
                                      :unsupported {["p" "a" "m"] (+ now 100) ["p" "b" "m"] (- now 1) ["p" "gone" "m"] (+ now 100)}})
                (assoc-in [:providers "p" :next-offset] 2))
        fresh {"p" {:auth-type :api-key :accounts [a b] :next-offset 0}
               "q" {:auth-type :oauth-bearer :accounts [(cred "q" "z")] :next-offset 0}}
        s (pool/replace-providers old fresh now)]
    (is (= 0 (get-in s [:providers "p" :next-offset])) "offset 2 wraps over 2 accounts")
    (is (= 0 (get-in s [:providers "q" :next-offset])))
    (is (= {["p" "a"] (+ now 1)} (:cooldowns s)))
    (is (= {} (:in-flight s)))
    (is (= {["p" "b"] 1} (:streaks s)))
    (is (= {["p" "a" "m"] (+ now 100)} (:unsupported s)))))

(deftest restoring-persisted-state
  (let [s (-> pool/empty-state
              (pool/restore-cooldowns {(pool/key->string ["p" "a"]) (+ now 5) (pool/key->string ["p" "b"]) (- now 5) "garbage" (+ now 5)} now)
              (pool/restore-disabled [(pool/key->string ["p" "c"]) "garbage"]))]
    (is (= {["p" "a"] (+ now 5)} (:cooldowns s)))
    (is (= #{["p" "c"]} (:disabled s)))
    (is (= ["p" "a"] (pool/string->key (pool/key->string ["p" "a"]))))))

(deftest expiry-queries
  (let [s (state-with [(cred "p" "past" {:expires-at (- now 1) :refresh-token "r"})
                       (cred "p" "past-no-refresh" {:expires-at (- now 1)})
                       (cred "p" "soon" {:expires-at (+ now 500) :refresh-token "r"})
                       (cred "p" "later" {:expires-at (+ now 5000) :refresh-token "r"})
                       (cred "p" "forever")])]
    (is (= ["past"] (ids (pool/expired-with-refresh-tokens s "p" now))))
    (is (= ["past"] (ids (pool/all-expired-with-refresh-tokens s now))))
    (is (= ["soon"] (ids (pool/expiring-accounts s now 1000))))
    (is (pool/credential-expired? (cred "p" "x" {:expires-at now}) now))
    (is (not (pool/credential-expired? (cred "p" "x") now)))))

(deftest statuses
  (let [s (state-with [(cred "p" "disabled") (cred "p" "expired" {:expires-at (+ now 10)})
                       (cred "p" "cool-busy") (cred "p" "cool") (cred "p" "free")]
                      {:disabled #{["p" "disabled"]}
                       :cooldowns {["p" "cool-busy"] (+ now 9000) ["p" "cool"] (+ now 4000)}
                       :in-flight {["p" "cool-busy"] 1}})]
    (is (= {:provider-id "p" :auth-type :api-key :total-accounts 5 :available-accounts 1 :cooldown-accounts 2
            :disabled-accounts 1 :expired-accounts 1 :in-flight-accounts 1 :next-ready-in-ms 0}
           (pool/provider-status s "p" now {})))
    (is (= 4000 (:next-ready-in-ms (pool/provider-status (update s :providers update-in ["p" :accounts] #(vec (butlast %))) "p" now {}))))
    (is (= {:provider-id "nope" :auth-type :unknown :total-accounts 0 :available-accounts 0 :cooldown-accounts 0
            :disabled-accounts 0 :expired-accounts 0 :in-flight-accounts 0 :next-ready-in-ms 0}
           (pool/provider-status s "nope" now {})))
    (let [by-id (into {} (map (juxt :account-id identity)) (get (pool/account-statuses s now {}) "p"))]
      (is (= {:provider-id "p" :account-id "cool" :auth-type :api-key :available? false :disabled? false :expired? false
              :in-flight? false :next-ready-in-ms 4000 :cooldown-until (+ now 4000)}
             (by-id "cool")))
      (is (true? (:expired? (by-id "expired"))))
      (is (true? (:disabled? (by-id "disabled")))))))
