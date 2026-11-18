(ns proxx.runtime.keypool-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.keypool :as kp]))

(defn- credential [pid aid extra]
  (let [o #js {:providerId pid :accountId aid :token (str "tok-" aid) :authType "api_key"}]
    (doseq [[k v] extra] (aset o k v))
    o))

(defn- fake-store [accounts calls]
  #js {:getAllProviders (fn [] (js/Promise.resolve (js/Map. #js [#js ["p" #js {:authType "api_key"}]])))
       :getAllAccounts (fn [] (js/Promise.resolve (js/Map. #js [#js ["p" (to-array accounts)]])))
       :loadCooldowns (fn [] (js/Promise.resolve (js/Map. #js [#js ["p\u0000b" (+ (js/Date.now) 60000)]])))
       :loadDisabledAccounts (fn [] (js/Promise.resolve (js/Set. #js ["p\u0000c"])))
       :persistCooldown (fn [p a u] (swap! calls conj [:set p a u]) (js/Promise.resolve))
       :clearCooldown (fn [p a] (swap! calls conj [:clear p a]) (js/Promise.resolve))
       :setAccountDisabled (fn [p a d] (swap! calls conj [:disabled p a d]) (js/Promise.resolve))})

(defn- make-pool [calls metrics]
  (let [accounts [(credential "p" "a" {}) (credential "p" "b" {}) (credential "p" "c" {})
                  (credential "p" "d" {"expiresAt" (- (js/Date.now) 1000) "refreshToken" "r"})]
        store (fake-store accounts calls)]
    (kp/create-key-pool-js
     #js {:keysFilePath "/nonexistent" :reloadIntervalMs 1e12 :defaultCooldownMs 30000 :defaultProviderId "p"
          :accountStore store :cooldownStore store :disabledStore store :preferAccountStoreProviders true}
     #js {:env #js {} :seedSpecs #js [] :sha256Hex (fn [_] "")
          :rng (let [i (atom 0)] (fn [] (let [x (+ 0.1 (* 0.07 (mod (swap! i inc) 11)))] x)))
          :telemetry #js {:recordMetric (fn [n v a] (swap! metrics conj [n v (js->clj a)]))}})))

(deftest ^:async pool-lifecycle
  (let [calls (atom []) metrics (atom [])
        pool (make-pool calls metrics)]
    (await (.warmup pool))
    (let [ids (fn [order] (mapv #(.-accountId %) (array-seq order)))]
      (is (= ["a"] (ids (await (.getRequestOrder pool "p"))))
          "b is cooling (restored from the store), c is disabled (restored), d is expired")
      (let [rel (.markInFlight pool (credential "p" "a" {}))
            status (await (.getStatus pool "p"))]
        (is (= 1 (.-inFlightAccounts status)))
        (is (= {:totalAccounts 4 :availableAccounts 1 :cooldownAccounts 1 :disabledAccounts 1 :expiredAccounts 1}
               (select-keys (js->clj status :keywordize-keys true)
                            [:totalAccounts :availableAccounts :cooldownAccounts :disabledAccounts :expiredAccounts])))
        (rel) (rel)
        (is (= 0 (.-inFlightAccounts (await (.getStatus pool "p")))) "releasing twice releases once"))
      (.markRateLimited pool (credential "p" "a" {}) 5000)
      (is (= [] (ids (await (.getRequestOrder pool "p")))))
      (is (= [[:set "p" "a"]] (mapv #(vec (take 3 %)) (filter #(= :set (first %)) @calls))) "cooldown persisted")
      (is (= [["proxy.key_pool.rate_limited" 1 {"proxy.provider_id" "p" "proxy.account_id" "a"}]] @metrics))
      (is (> (await (.msUntilAnyKeyReady pool "p")) 0))
      (.clearAccountCooldown pool "p" "a")
      (is (= ["a"] (ids (await (.getRequestOrder pool "p")))))
      (.enableAccount pool "p" "c")
      (is (some #{[:disabled "p" "c" false]} @calls))
      (is (false? (.isModelUnsupported pool "p" "a" "gpt-5")))
      (.markModelUnsupported pool (credential "p" "a" {}) "GPT-5" 5000)
      (is (true? (.isModelUnsupported pool "p" "a" "gpt-5")))
      (let [expired (array-seq (.getExpiredAccountsWithRefreshTokens pool "p"))]
        (is (= ["d"] (mapv #(.-accountId %) expired)))
        (is (= "r" (.-refreshToken (first expired))) "optional fields survive the round trip"))
      (is (thrown-with-msg? js/Error #"No accounts configured for provider: nope"
                            (await (.getRequestOrder pool "nope")))))))

(deftest ^:async refresh-flow
  (let [calls (atom []) pool (make-pool calls (atom []))]
    (await (.warmup pool))
    (let [order (await (.getRequestOrderWithRefresh
                        pool "p"
                        (fn [c] (js/Promise.resolve (credential "p" (.-accountId c) {"token" "fresh" "expiresAt" (+ (js/Date.now) 3600000)})))))
          ids (mapv #(.-accountId %) (array-seq order))]
      (is (= ["a" "d"] ids) "usable accounts first, refreshed ones appended")
      (is (= "fresh" (.-token (nth (array-seq order) 1)))))
    (let [order (await (.getRequestOrderWithRefresh pool "p" (fn [_] (js/Promise.reject (js/Error. "boom")))))]
      (is (= ["a"] (mapv #(.-accountId %) (array-seq order))) "failed refreshes are skipped, not fatal"))))

(deftest ^:async owned-short-cooldown-does-not-clear-or-shorten-newer-quota
  (let [calls (atom []) pool (make-pool calls (atom []))
        account (credential "p" "a" {})]
    (await (.warmup pool))
    (let [^js claim (.markRateLimitedAtLeast pool account 1000)]
      (is (number? (.-version claim)))
      (.markRateLimited pool account 60000)
      (is (false? (.clearAccountCooldownIfUnchanged pool "p" "a" claim)))
      (is (nil? (.markRateLimitedAtLeast pool account 1000)))
      (is (= 0 (alength (await (.getRequestOrder pool "p")))))
      (await (js/Promise. (fn [resolve] (js/setTimeout resolve 0))))
      (is (empty? (filter #(= :clear (first %)) @calls))
          "A superseded short-cooldown claim cannot issue a persistent clear")
      (.clearAccountCooldown pool "p" "a")
      (let [next-claim (.markRateLimitedAtLeast pool account 1000)]
        (is (true? (.clearAccountCooldownIfUnchanged pool "p" "a" next-claim)))
        (is (= ["a"] (mapv #(.-accountId ^js %) (array-seq (await (.getRequestOrder pool "p"))))))))))

(deftest ^:async cooldown-persistence-keeps-clear-before-later-quota
  (let [calls (atom []) release (atom nil)
        first-write (js/Promise. (fn [resolve] (reset! release resolve)))
        writes (atom 0)
        store (fake-store [(credential "p" "a" {})] calls)
        _ (aset store "persistCooldown"
                (fn [_ _ until]
                  (swap! calls conj [:set until])
                  (if (= 1 (swap! writes inc)) first-write (js/Promise.resolve))))
        _ (aset store "clearCooldown" (fn [_ _] (swap! calls conj [:clear]) (js/Promise.resolve)))
        pool (kp/create-key-pool-js
              #js {:keysFilePath "/nonexistent" :defaultProviderId "p" :accountStore store
                   :cooldownStore store :preferAccountStoreProviders true :cooldownJitterFactor 0}
              #js {:env #js {} :seedSpecs #js [] :sha256Hex (fn [_] "") :rng (fn [] 0.5)})
        account (credential "p" "a" {})]
    (await (.warmup pool))
    (let [^js claim (.markRateLimitedAtLeast pool account 1000)]
      (is (true? (.clearAccountCooldownIfUnchanged pool "p" "a" claim)))
      (.markRateLimited pool account 60000)
      (await (js/Promise.resolve))
      (is (= [:set] (mapv first @calls)) "Clear waits for the pending short-cooldown write")
      (@release)
      (await (js/Promise. (fn [resolve] (js/setTimeout resolve 0))))
      (is (= [:set :clear :set] (mapv first @calls)))
      (is (> (second (last @calls)) (.-until claim)))
      (is (= 0 (alength (await (.getRequestOrder pool "p")))))
      (is (false? (.clearAccountCooldownIfUnchanged pool "p" "a" claim))))))
