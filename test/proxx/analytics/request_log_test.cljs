(ns proxx.analytics.request-log-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.analytics.request-log :as rl]))

(defn- env []
  (let [u (atom 0)] {:now (fn [] 1000) :uuid (fn [] (str "u" (swap! u inc)))}))

(defn- input [m]
  (merge {"providerId" "p" "accountId" "a" "authType" "api_key" "model" "m" "upstreamMode" "chat"
          "upstreamPath" "/x" "status" 200 "latencyMs" 100 "timestamp" 1700000000000}
         m))

(defn- record-all [inputs max]
  (let [e (env)]
    (reduce (fn [s in] (second (rl/record s (rl/new-entry in e) max))) rl/empty-state inputs)))

(def sample
  [(input {"promptTokens" 10 "completionTokens" 5 "totalTokens" 15 "ttftMs" 50 "tps" 20})
   (input {"status" 500 "timestamp" 1700000100000 "model" "n"})
   (input {"serviceTier" "priority" "timestamp" 1700003700000 "cacheHit" true "promptCacheKeyUsed" true})
   (input {"serviceTierSource" "fast_mode" "accountId" "b" "timestamp" 1700090000000})])

(deftest indexes-are-a-fold-of-the-entries
  (let [s (record-all sample 100)
        rebuilt (rl/rebuild-indexes s)]
    (doseq [k [:hourly :daily :model :account :perf :acc]]
      (is (= (get s k) (get rebuilt k)) (str k " incremental == rebuilt")))
    (is (= [2 1 1] (mapv #(get % "requestCount") (rl/hourly-buckets s 0))))
    (is (= 1 (get (first (rl/hourly-buckets s 0)) "errorCount")) "errors count status >= 400")
    (is (= [2] (mapv #(get % "standardRequestCount") (take 1 (rl/hourly-buckets s 0)))) "tier split")))

(deftest corrections-apply-as-deltas
  (let [e (env)
        s0 (record-all [(input {"promptTokens" 10 "id" "x"})] 100)
        id (get (first (:entries s0)) "id")
        [next s1 i] (rl/update-entry s0 id {"promptTokens" 30 "ttftMs" 80 "cacheHit" true "promptCacheKeyUsed" true})]
    (is (= 0 i))
    (is (= 30 (get next "promptTokens")))
    (is (= 30 (get (first (rl/hourly-buckets s1 0)) "promptTokens")))
    (is (= 1 (get (first (rl/hourly-buckets s1 0)) "cacheHitCount")))
    (is (= 1 (get (first (rl/account-buckets s1 0)) "ttftCount")) "first observation adds a sample")
    (let [[_ s2 _] (rl/update-entry s1 id {"ttftMs" 90})]
      (is (= 1 (get (first (rl/account-buckets s2 0)) "ttftCount")) "later ones do not"))
    (is (nil? (rl/update-entry s0 "missing" {})))
    (is (some? e))))

(deftest retention-and-pruning
  (let [s (record-all (for [i (range 5)] (input {"timestamp" (+ 1700000000000 i)})) 3)]
    (is (= 3 (count (:entries s))))
    (is (= 5 (get (first (rl/hourly-buckets s 0)) "requestCount")) "rollups outlive the retained window"))
  (let [old (input {"timestamp" 1600000000000})
        s (record-all [old (input {"timestamp" 1700000000000})] 10)]
    (is (= [1699920000000] (mapv #(get % "startMs") (rl/daily-buckets s 0))) "buckets > 45 days old are pruned")))

(deftest perf-ewma
  (let [s (record-all [(input {"ttftMs" 100 "tps" 10}) (input {"ttftMs" 200 "tps" 20})] 10)
        p (rl/perf-summary s "p" "a" "m" "chat")]
    (is (= 2 (get p "sampleCount")))
    (is (< (Math/abs (- 120 (get p "ewmaTtftMs"))) 1e-9))
    (is (< (Math/abs (- 12 (get p "ewmaTps"))) 1e-9))
    (is (= "*" (get (rl/model-perf-summary s "p" "m" "chat") "accountId")))
    (is (nil? (rl/model-perf-summary s "p" "zzz" "chat")))))

(deftest queries
  (let [s (record-all sample 100)
        ids (mapv #(get % "id") (:entries s))]
    (is (= (reverse ids) (mapv #(get % "id") (rl/list-entries s {}))) "newest first")
    (is (= [(nth ids 1) (nth ids 0)] (mapv #(get % "id") (rl/list-entries s {"before" (nth ids 2)}))))
    (is (= [] (rl/list-entries s {"before" (first ids)})) "cursor at the oldest entry yields nothing")
    (is (= 1 (count (rl/list-entries s {"accountId" "b"}))))
    (is (= 2 (count (rl/list-entries s {"limit" 2.9}))))
    (is (= 4 (rl/count-since s 0 {})))
    (is (= {"p" {"count" 4 "lastTimestamp" 1700090000000}} (rl/provider-summary s)))
    (testing "pinned upstream quirk: limit 0 still yields the first match"
      (is (= 1 (count (rl/since-with-limit s 0 0 nil)))))))

(deftest intentional-divergence-null-passthrough
  ;; The TypeScript store copied raw `tps`/`endToEndTps`/`error` from the input,
  ;; so an explicit null was persisted as JSON null. Null and undefined are one
  ;; thing in the pure core: the field is absent.
  (let [e (rl/new-entry (input {"tps" nil "error" nil "endToEndTps" nil}) (env))]
    (is (not-any? #(contains? e %) ["tps" "error" "endToEndTps"]))))

(deftest hydration
  (is (nil? (rl/hydrate-entry {"providerId" " "} (env))))
  (let [e (rl/hydrate-entry {"providerId" " p " "accountId" "a" "model" "m" "upstreamMode" "c" "upstreamPath" "/"
                             "status" 200 "latencyMs" 1 "serviceTier" "  " "authType" "weird"}
                            (env))]
    (is (= "p" (get e "providerId")))
    (is (= "u1" (get e "id")) "missing ids are minted")
    (is (= "none" (get e "authType")))
    (is (= "" (get e "serviceTier")) "an all-blank tier stays as the empty string")
    (is (= "none" (get e "serviceTierSource")))))

(deftest journal-policy
  (is (rl/journal-should-compact? true false 0 0 100 0))
  (is (rl/journal-should-compact? false true 0 0 100 0))
  (is (not (rl/journal-should-compact? false false 10 1 100 10)))
  (is (rl/journal-should-compact? false false 5000 0 1000 1000) "stale lines exceed the budget"))
