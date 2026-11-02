(ns proxx.runtime.aco
  "JS edge for ant-colony route ordering (src/lib/provider-route-aco.ts) and the
  pheromone store behind it (proxx.runtime.pheromone-store).

  The edge reads the environment, asks the stores what they know, draws the random
  numbers, and hands plain data to proxx.routing.aco."
  (:require [proxx.routing.aco :as aco]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.routing :as routing]))

;; ---------------------------------------------------------------------------
;; ranking
;; ---------------------------------------------------------------------------

(defn- env-float
  "A float from the environment clamped to [min, max]; `fallback` when unset or not a number."
  [env-name fallback]
  (let [raw (some-> (aget (.-env js/process) env-name) str .trim)]
    (if (seq raw)
      (let [n (js/parseFloat raw)]
        (if (js/Number.isFinite n) (js/Math.min 1 (js/Math.max 0 n)) fallback))
      fallback)))

(defn- params-from-env []
  (let [d aco/default-params]
    {:health-min (env-float "ACO_ROUTE_HEALTH_MIN" (:health-min d))
     :alpha (env-float "ACO_ROUTING_ALPHA" (:alpha d))
     :beta (env-float "ACO_ROUTING_BETA" (:beta d))
     :weights {:health (env-float "ACO_HEURISTIC_HEALTH_WEIGHT" (get-in d [:weights :health]))
               :latency (env-float "ACO_HEURISTIC_LATENCY_WEIGHT" (get-in d [:weights :latency]))
               :recency (env-float "ACO_HEURISTIC_RECENCY_WEIGHT" (get-in d [:weights :recency]))
               :confidence (env-float "ACO_HEURISTIC_CONFIDENCE_WEIGHT" (get-in d [:weights :confidence]))}}))

(defn- nullish->nil [x] (if (nil? x) nil x))

(defn- credential-facts [^js health-store ^js credential]
  {:expires-at (.-expiresAt credential)
   :health-score (when health-store
                   (nullish->nil (.getHealthScore health-store (.-providerId credential) (.-accountId credential) (.-expiresAt credential))))
   :quota-exhausted? (when health-store
                       (js* "!!~{}" (.isQuotaExhausted health-store (.-providerId credential) (.-accountId credential))))})

(defn- perf->data [^js perf]
  (when (some? perf)
    {:ewma-ttft-ms (.-ewmaTtftMs perf) :updated-at (.-updatedAt perf) :sample-count (.-sampleCount perf)}))

(defn- candidate-for
  "Promise of the candidate map for one dedicated route, or nil when it has no healthy credential."
  [^js input params now-ms index ^js route]
  (let [provider-id (.-providerId route)]
    (-> (js/Promise.resolve)
        (.then (fn [] (.getRequestOrder ^js (.-keyPool input) provider-id)))
        (.catch (fn [_] #js []))
        (.then (fn [accounts]
                 (let [healthy (->> (array-seq accounts)
                                    (map #(aco/credential-health (credential-facts (.-healthStore input) %) now-ms (:health-min params)))
                                    (filter :healthy?))]
                   (when (seq healthy)
                     {:index index :provider-id provider-id
                      :perf (perf->data (.getModelPerfSummary ^js (.-requestLogStore input) provider-id (.-model input) (.-upstreamMode input)))
                      :health-score (apply max (map :health-score healthy))
                      :healthy-account-count (count healthy)
                      :pheromone (.getPheromone ^js (.-pheromoneStore input) provider-id (.-model input))})))))))

(defn- signal->js
  "A signal as a JS object with its keys in a fixed, documented order (an object literal's
  key order is not preserved by the release compiler)."
  [{:keys [provider-id health-score latency-score recency-score confidence-score heuristic-score
           pheromone combined-score healthy-account-count sample-count]}]
  (let [o #js {}]
    (doseq [[k v] [["providerId" provider-id] ["healthScore" health-score] ["latencyScore" latency-score]
                   ["recencyScore" recency-score] ["confidenceScore" confidence-score]
                   ["heuristicScore" heuristic-score] ["pheromone" pheromone] ["combinedScore" combined-score]
                   ["healthyAccountCount" healthy-account-count] ["sampleCount" sample-count]]]
      (aset o k v))
    o))

(defn rank-provider-routes-with-aco-js
  "Promise of {orderedRoutes, signals}. Dedicated Ollama routes (per the surface facts) are
  ordered by weighted random choice over their scores; every other route follows, untouched."
  [manifest-path ^js input]
  (-> (js/Promise.resolve)
      (.then
       (fn []
         (let [facts (routing/surface-facts manifest-path)
               all-routes (array-seq (.-providerRoutes input))
               dedicated (filterv #(aco/dedicated-route? facts {"providerId" (.-providerId ^js %)}) all-routes)
               passthrough (filterv #(not (aco/dedicated-route? facts {"providerId" (.-providerId ^js %)})) all-routes)]
           (if (<= (count dedicated) 1)
             #js {:orderedRoutes (to-array all-routes)
                  :signals (to-array (map #(signal->js (aco/untouched-signal (.-providerId ^js %)
                                                                              (.getPheromone ^js (.-pheromoneStore input) (.-providerId ^js %) (.-model input))))
                                          dedicated))}
             (let [params (params-from-env)
                   now-ms (js/Date.now)
                   rng (or (.-rng input) js/Math.random)]
               (-> (js/Promise.all (to-array (map-indexed #(candidate-for input params now-ms %1 %2) dedicated)))
                   (.then (fn [found]
                            (let [candidates (vec (remove nil? (array-seq found)))]
                              (if (empty? candidates)
                                #js {:orderedRoutes (to-array passthrough) :signals #js []}
                                (let [{:keys [order signals]}
                                      (aco/rank {:params params :now-ms now-ms :candidates candidates
                                                 :draws (vec (repeatedly (count candidates) rng))})]
                                  #js {:orderedRoutes (to-array (concat (map #(nth dedicated %) order) passthrough))
                                       :signals (to-array (map signal->js signals))})))))))))))))
