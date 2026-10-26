(ns proxx.web.dashboard-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.pages.dashboard :as d]
            [proxx.web.update :as u]))

(defn- boot [& [stored]] (u/init-db {:stored (or stored {}) :token "t" :path "/"}))
(defn- slice [db] (get-in db [:pages :dashboard]))
(defn- paths [fx*] (mapcat #(case (first %) :http-all (map :path (second %)) :http [(:path (second %))] nil) fx*))

(defn- acct [m] (merge {:providerId "openai" :accountId "a" :displayName "A" :authType "oauth_bearer" :status "healthy" :requestCount 12
                        :totalTokens 3400 :cachedPromptTokens 200 :imageCount 2 :imageCostUsd 0.12 :cacheHitCount 1 :cacheKeyUseCount 3
                        :avgTtftMs 420 :avgDecodeTps 18 :avgEndToEndTps 10 :healthScore 0.92 :lastUsedAt nil} m))
(def overview
  {:generatedAt "2026-04-03T00:00:00Z"
   :coverage {:coverageStart nil :hasFullWindowCoverage false}
   :summary {:requests24h 12 :tokens24h 3400 :promptTokens24h 1200 :completionTokens24h 2200 :cachedPromptTokens24h 200
             :imageCount24h 2 :imageCostUsd24h 0.12 :costUsd24h 1.23 :energyJoules24h 12000 :waterEvaporatedMl24h 34
             :cacheHitRate24h 20 :errorRate24h 0 :topModel "gpt" :topProvider "openai" :activeAccounts 1
             :routingRequests24h {:local 10 :federated 1 :bridge 1 :distinctPeers 1 :topPeer "peer-a"}
             :serviceTierRequests24h {:fastMode 1 :priority 2 :standard 9}}
   :trends {:requests [{:t "a" :v 12}] :tokens [{:t "a" :v 3400}] :errors [{:t "a" :v 0}]}
   :accounts [(acct {}) (acct {:providerId "z" :accountId "b" :displayName "B" :totalTokens 100 :status "cooldown"})]})

(deftest enter-loads-three-resources-and-polls
  (let [[_ fx*] (u/handle (boot) [:route/changed "/"])]
    (is (= ["/api/v1/dashboard/overview?sort=health&window=weekly" "/api/v1/credentials" "/api/v1/request-logs?limit=50"]
           (paths fx*)))
    (is (some #(= [:interval/start :dashboard 30000 [:dashboard/load]] %) fx*))))

(deftest controls-persist-and-reload
  (let [db (first (u/handle (boot) [:route/changed "/"]))
        [db1 fx1] (u/handle db [:dashboard/set-window "monthly"])
        [db2 fx2] (u/handle db [:dashboard/set-sort "E2E-TPS"])]
    (is (= "monthly" (d/window db1)))
    (is (some #{"/api/v1/dashboard/overview?sort=health&window=monthly"} (paths fx1)))
    (is (= "e2e-tps" (d/account-sort db2)))
    (is (some #{"/api/v1/dashboard/overview?sort=e2e-tps&window=weekly"} (paths fx2)))))

(deftest load-results-and-provider-filter-reset
  (let [db (first (u/handle (boot {d/ls-account-provider "gone"}) [:route/changed "/"]))
        [db1 fx1] (u/handle db [:dashboard/loaded 1 [overview {:keyPoolStatuses {"openai" {:providerId "openai"}}} (vec (repeat 50 {:id "l"}))]])]
    (is (= d/all-providers (d/provider-filter db1)) "dangling filter reset")
    (is (= [[:storage/write d/ls-account-provider d/all-providers]] fx1))
    (is (true? (:has-more? (slice db1))))
    (is (= 50 (count (:logs (slice db1)))))
    (let [db2 (first (u/handle (boot {d/ls-account-provider "z"}) [:route/changed "/"]))
          [db3 fx3] (u/handle db2 [:dashboard/loaded 1 [overview {:keyPoolStatuses {}} []]])]
      (is (= "z" (d/provider-filter db3)))
      (is (empty? fx3))
      (is (false? (:has-more? (slice db3)))))
    (let [[db3] (u/handle db [:dashboard/load])
          [db4] (u/handle db3 [:dashboard/loaded 1 [overview {} []]])]
      (is (nil? (:overview (slice db4))) "stale result ignored"))
    (let [[db3] (u/handle db [:dashboard/failed 1 "boom"])]
      (is (= "boom" (:error (slice db3)))))))

(deftest infinite-log-list
  (let [db (-> (boot) (u/handle [:route/changed "/"]) first
               (u/handle [:dashboard/loaded 1 [overview {} (mapv (fn [i] {:id (str "l" i)}) (range 50))]]) first)
        [db1 fx1] (u/handle db [:dashboard/load-more-logs])]
    (is (true? (:loading-more? (slice db1))))
    (is (= ["/api/v1/request-logs?limit=50&before=l49"] (paths fx1)))
    (is (= [db1 []] (u/handle db1 [:dashboard/load-more-logs])) "one page at a time")
    (let [[db2] (u/handle db1 [:dashboard/more-logs [{:id "o1"}]])]
      (is (= 51 (count (:logs (slice db2)))))
      (is (false? (:has-more? (slice db2))))
      (is (= [db2 []] (u/handle db2 [:dashboard/load-more-logs])) "no more pages"))
    (let [[db2] (u/handle db1 [:dashboard/more-logs-failed "x"])]
      (is (false? (:loading-more? (slice db2))))
      (is (nil? (:error (slice db2))) "silent"))
    (is (= [(boot) []] (let [b (boot)] [(first (u/handle b [:dashboard/load-more-logs])) []])) "nothing loaded yet")))

(deftest infinite-health-list
  (let [many (mapv (fn [i] (acct {:accountId (str i)})) (range 120))
        db (-> (boot) (assoc-in [:pages :dashboard :overview] (assoc overview :accounts many)))
        vm (d/view-model db)]
    (is (= 50 (count (:accounts vm))))
    (is (true? (:more-health? vm)))
    (let [[db1] (u/handle db [:dashboard/more-health])
          [db2] (u/handle db1 [:dashboard/more-health])
          [db3] (u/handle db2 [:dashboard/more-health])]
      (is (= 100 (:health-visible (slice db1))))
      (is (= 120 (:health-visible (slice db2))))
      (is (= 120 (:health-visible (slice db3))) "capped at the filtered count")
      (is (false? (:more-health? (d/view-model db2)))))
    (let [[db1] (u/handle (assoc-in db [:pages :dashboard :health-visible] 100) [:dashboard/set-provider "z"])]
      (is (= 50 (:health-visible (slice db1))) "filter change resets the window"))))

(deftest tile-variants
  (is (= "default" (d/tile-variant 0)))
  (is (= "success" (d/tile-variant 1)))
  (is (= "default" (d/tile-variant 0.5)))
  (is (= "success" (d/tile-variant 0.5 true)))
  (is (= "warning" (d/tile-variant 1 true)))
  (is (= "error" (d/tile-variant 5 true)))
  (is (= "default" (d/tile-variant -1 true))))

(deftest figures
  (is (= "Standard" (d/format-service-tier {})))
  (is (= "Fast mode" (d/format-service-tier {:serviceTier "priority" :serviceTierSource "fast_mode"})))
  (is (= "Priority" (d/format-service-tier {:serviceTier "priority" :serviceTierSource "explicit"})))
  (is (= "some tier" (d/format-service-tier {:serviceTier "some_tier" :serviceTierSource "explicit"})))
  (is (= "local" (d/format-route-label {:routeKind "local"})))
  (is (= "bridge → unknown-peer" (d/format-route-label {:routeKind "bridge"})))
  (is (= "p/a" (d/format-provider-route-cell {:providerId "p" :accountId "a" :routeKind "local"})))
  (is (= "p/a · federated → X · from tenant t"
         (d/format-provider-route-cell {:providerId "p" :accountId "a" :routeKind "federated" :routedPeerLabel "X" :tenantId "t"})))
  (is (= [{:key "a" :height 100} {:key "b" :height 8}] (mapv #(update % :height (fn [h] (if (= h 100.0) 100 h)))
                                                          (d/spark-bars [{:t "a" :v 10} {:t "b" :v 0.1}]))))
  (is (= [{:key "a" :height 8}] (d/spark-bars [{:t "a" :v 0}])))
  (is (nil? (d/donut-segments [])))
  (is (nil? (d/donut-segments [{:totalTokens 0}])))
  (let [[s1 s2] (d/donut-segments [{:providerId "p" :accountId "1" :totalTokens 75} {:providerId "p" :accountId "2" :totalTokens 25}])]
    (is (= "198 264" (:dasharray s1)))
    (is (zero? (:dashoffset s1)))
    (is (= "66 264" (:dasharray s2)))
    (is (= -198 (:dashoffset s2))))
  (is (nil? (d/tier-bars {:fastMode 0 :priority 0 :standard 0})))
  (is (= ["Fast mode" "Priority" "Standard"] (mapv :label (d/tier-bars {:fastMode 1 :priority 2 :standard 9}))))
  (is (= "6%" (:width (first (d/tier-bars {:fastMode 1 :priority 0 :standard 1000})))) "min 6% when non-zero")
  (is (= "0%" (:width (second (d/tier-bars {:fastMode 1 :priority 0 :standard 1000}))))))

(deftest view-model-shapes
  (let [db (-> (boot) (assoc-in [:pages :dashboard :overview] overview) (assoc-in [:pages :dashboard :loading?] false)
               (assoc-in [:pages :dashboard :statuses] {"b" {:providerId "b" :authType "api_key" :totalAccounts 2 :availableAccounts 1 :cooldownAccounts 1 :nextReadyInMs 1500}
                                                          "a" {:providerId "a" :authType "oauth_bearer" :totalAccounts 1 :availableAccounts 1 :cooldownAccounts 0 :nextReadyInMs 0}})
               (assoc-in [:pages :dashboard :logs] [{:id "1" :timestamp 0 :providerId "p" :accountId "a" :routeKind "local" :model "m" :status 0 :latencyMs 12.4 :serviceTierSource "none"}
                                                    {:id "2" :timestamp 0 :providerId "p" :accountId "a" :routeKind "local" :model "m" :status 200 :latencyMs 1 :upstreamErrorCode "x" :serviceTierSource "fast_mode" :serviceTier "priority"}]))
        vm (d/view-model db)]
    (is (= "7d" (:window-label vm)))
    (is (= "7d window partially covered." (:coverage-note vm)))
    (is (= 8 (count (:tiles vm))))
    (is (= ["Requests / 7d" "Tokens / 7d" "Images / 7d" "Error Rate" "Active Accounts" "Projected / 7d" "Est. Cost / 7d" "Water Evaporated / 7d"]
           (mapv :label (:tiles vm))))
    (is (= "In 1.2K / Out 2.2K · Cached 200 · Cache hit 20%" (get-in vm [:tiles 1 :detail])))
    (is (= "Federated 1 · Bridge 1 · Top peer peer-a" (get-in vm [:tiles 5 :detail])))
    (is (= "12 kJ energy" (get-in vm [:tiles 6 :detail])))
    (is (= [{:value 12 :label "a"}] (get-in vm [:tiles 0 :sparkbar])))
    (is (= ["a" "b"] (mapv :id (:providers vm))) "sorted by provider id")
    (is (= [["Total" "2"] ["Available" "1"] ["Cooling Down" "1"] ["Ready In" "2s"]] (:rows (second (:providers vm)))))
    (is (= "now" (second (last (:rows (first (:providers vm)))))))
    (is (= ["openai" "z"] (:provider-options vm)))
    (let [[l1 l2] (:logs vm)]
      (is (= "ERR" (:status-text l1)))
      (is (= "error" (:status-badge l1)))
      (is (= "12 ms" (:latency l1)))
      (is (= "warning" (:status-badge l2)))
      (is (= "200 x" (:status-text l2)))
      (is (= "info" (:tier-badge l2)))
      (is (= "Fast mode" (:tier l2))))
    (let [[a1 a2] (:accounts vm)]
      (is (= "33% (1/3) · 200 cached" (:cache a1)))
      (is (= "12 · 2 img" (:requests a1)))
      (is (= "3.4K · $0.1200" (:tokens a1)))
      (is (= "Never" (:last-seen a1)))
      (is (= "92%" (:health a1)))
      (is (= "warning" (:badge a2))))
    (testing "provider filter narrows accounts"
      (let [vm2 (d/view-model (assoc-in db [:stored d/ls-account-provider] "nope"))]
        (is (= "No accounts found for provider nope." (:accounts-empty vm2)))))
    (is (= "No request log activity yet." (:accounts-empty (d/view-model (boot)))))))
