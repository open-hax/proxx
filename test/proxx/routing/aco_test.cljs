(ns proxx.routing.aco-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.aco :as aco]
            [proxx.routing.pheromone :as ph]
            [proxx.routing.surface :as s]
            [proxx.runtime.aco :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")
(def facts (-> (loader/load-policy-contracts! manifest) contracts/compile-contracts s/facts))

(deftest dedicated-routes
  (is (aco/dedicated-route? facts {"providerId" "ollama-lan"}))
  (is (not (aco/dedicated-route? facts {"providerId" "ollama-cloud"})))
  (is (not (aco/dedicated-route? facts {"providerId" "openai"}))))

(deftest credential-health
  (is (= {:healthy? true :health-score 0.5} (aco/credential-health {} 1000 0.35)) "no store: 0.5")
  (is (= {:healthy? false :health-score 0.1} (aco/credential-health {:expires-at 1000} 1000 0.35)) "expiring now is expired")
  (is (= {:healthy? true :health-score 0.5} (aco/credential-health {:expires-at 1001} 1000 0.35)))
  (is (= {:healthy? false :health-score 0.2} (aco/credential-health {:health-score 0.2} 0 0.35)) "below the minimum")
  (is (= {:healthy? false :health-score 0.9} (aco/credential-health {:health-score 0.9 :quota-exhausted? true} 0 0.35)))
  (is (= {:healthy? false :health-score 0.9} (aco/credential-health {:health-score 0.9 :expires-at 5} 10 0.35)) "a stored score does not rescue an expired credential"))

(deftest weighted-order-consumes-one-draw-per-item
  (let [item (fn [id score] {:id id :combined-score score})
        items [(item :a 1) (item :b 1) (item :c 2)]]
    (is (= [:a :b :c] (mapv :id (aco/weighted-random-order items [0.0 0.0 0.0]))) "target 0 always picks the first")
    (is (= [:c :a :b] (mapv :id (aco/weighted-random-order items [0.99 0.0 0.0]))) "high draw picks the heaviest tail item")
    (is (= [:b :c :a] (mapv :id (aco/weighted-random-order items [0.3 0.9 0.5]))) "hand-worked: 1.2 picks b, then 2.7 of weights 1,2 picks c")
    (is (= [:a] (mapv :id (aco/weighted-random-order [(item :a 0)] [0.5]))) "weights are floored, never zero")
    (is (= [] (aco/weighted-random-order [] [])))))

(deftest rank-scores
  (let [candidate (fn [i ttft samples pher]
                    {:index i :provider-id (str "p" i) :health-score 1 :healthy-account-count 1 :pheromone pher
                     :perf (when ttft {:ewma-ttft-ms ttft :updated-at 1000 :sample-count samples})})
        {:keys [order signals]} (aco/rank {:params aco/default-params :now-ms 1000
                                           :candidates [(candidate 0 100 10 0.5) (candidate 1 300 0 0.5) (candidate 2 nil 0 0.5)]
                                           :draws [0 0 0]})
        by (into {} (map (juxt :provider-id identity)) signals)]
    (is (= [0 1 2] order))
    (is (= [1 0 0.5] (mapv #(:latency-score (by %)) ["p0" "p1" "p2"])) "fastest 1, slowest 0, unknown 0.5")
    (is (= [1 0 0] (mapv #(:confidence-score (by %)) ["p0" "p1" "p2"])))
    (is (= [10 0 0] (mapv #(:sample-count (by %)) ["p0" "p1" "p2"])))
    (is (= 1 (:recency-score (by "p0"))))
    (is (every? #(<= 0 (:combined-score %) 1) signals))))

(deftest equal-latencies-score-one
  (let [{:keys [signals]} (aco/rank {:params aco/default-params :now-ms 0
                                     :candidates (mapv (fn [i] {:index i :provider-id (str i) :health-score 1 :healthy-account-count 1
                                                                :pheromone 0.5 :perf {:ewma-ttft-ms 50 :updated-at 0 :sample-count 1}}) (range 2))
                                     :draws [0 0]})]
    (is (= [1 1] (mapv :latency-score signals)))))

;; ---- pheromone ----------------------------------------------------------------

(deftest hydration-drops-and-defaults
  (is (= [{"providerId" "a" "model" "m" "pheromone" 0.5 "successCount" 0 "failureCount" 0 "updatedAt" 99}]
         (ph/hydrate-db {"records" [{"providerId" " A " "model" " M " "pheromone" "x"} {"providerId" "" "model" "m"} {"model" "m"} nil 5]} 99)))
  (is (= 1 (get (first (ph/hydrate-db {"records" [{"providerId" "a" "model" "m" "pheromone" 5}]} 0)) "pheromone")) "clamped")
  (is (= [3 0] (let [r (first (ph/hydrate-db {"records" [{"providerId" "a" "model" "m" "successCount" 3.9 "failureCount" -2}]} 0))]
                 [(get r "successCount") (get r "failureCount")])))
  (is (= [] (ph/hydrate-db {"records" "x"} 0)))
  (is (= [] (ph/hydrate-db nil 0)))
  (is (= [] (ph/hydrate-db [] 0))))

(deftest updates
  (let [r1 (ph/note-success [] " P " "M" 1 10)
        r2 (ph/note-success r1 "p" " m " 0.5 20)
        r3 (ph/note-failure r2 "p" "m" 30)]
    (is (= [{"providerId" "p" "model" "m" "pheromone" 0.65 "successCount" 1 "failureCount" 0 "updatedAt" 10}] r1))
    (is (= 1 (count r3)) "same normalised key replaces in place")
    (is (= [2 1 30] ((juxt #(get % "successCount") #(get % "failureCount") #(get % "updatedAt")) (first r3))))
    (is (= 0.5 (ph/pheromone [] "p" "m")))
    (is (= (get (first r3) "pheromone") (ph/pheromone r3 " P" "M ")))
    (is (not (ph/key-valid? " " "m")))
    (is (ph/key-valid? "p" "m"))
    (is (= 0.2 (ph/next-on-failure 0.5)) "penalty 0.3")
    (is (= 0 (ph/next-on-failure 0.1)) "floored at 0")
    (is (= 1 (ph/next-on-success 1 5)) "quality is clamped and the result capped")))

(deftest edge-records-keep-persisted-key-order
  (let [records (edge/pheromone-note-success-js #js [] "p" "m" 1)]
    (is (= ["providerId" "model" "pheromone" "successCount" "failureCount" "updatedAt"] (vec (js/Object.keys (aget records 0)))))
    (is (= 0.5 (edge/pheromone-get-js #js [] "x" "y")))
    (is (false? (edge/pheromone-key-valid-js "" "m")))))

(deftest ^:async edge-ranking-keeps-passthrough-and-draws-lazily
  (let [creds {"ollama-a" [#js {:providerId "ollama-a" :accountId "1"}] "ollama-b" [#js {:providerId "ollama-b" :accountId "1"}]}
        draws (atom 0)
        input #js {:providerRoutes #js [#js {:providerId "openai"} #js {:providerId "ollama-a"} #js {:providerId "ollama-b"} #js {:providerId "zai"}]
                   :model "m" :upstreamMode "chat"
                   :keyPool #js {:getRequestOrder (fn [id] (js/Promise.resolve (to-array (creds id))))}
                   :requestLogStore #js {:getModelPerfSummary (fn [] js/undefined)}
                   :healthStore js/undefined
                   :pheromoneStore #js {:getPheromone (fn [] 0.5)}
                   :rng (fn [] (swap! draws inc) 0.0)}
        out (await (edge/rank-provider-routes-with-aco-js manifest input))]
    (is (= ["ollama-a" "ollama-b" "openai" "zai"] (mapv #(.-providerId %) (array-seq (.-orderedRoutes out)))))
    (is (= 2 @draws) "one draw per ordered candidate")
    (is (= 2 (.-length (.-signals out))))))
