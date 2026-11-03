(ns proxx.runtime.strategy-routes
  "JS edge for the ordering and auto-model glue the provider strategy modules used
  to carry (src/lib/provider-strategy/{shared,strategies/*}.ts).

  The orderings themselves are decided in `proxx.strategy.routing` and
  `proxx.strategy.chains`; these functions only read host objects (credentials,
  the request log store, a ranking callback), ask for the verdict, and hand the
  host's own objects back in the verdict's order, so callers never index arrays."
  (:require [proxx.runtime.auto-model :as auto-model]
            [proxx.runtime.strategy :as strategy]
            [proxx.strategy.chains :as chains]))

(defn- by-order
  "`items` (a JS array) in the order of `indices` (a JS array of positions)."
  [items indices]
  (to-array (map #(aget items %) (array-seq indices))))

(defn- undefined-if-nil [x] (if (nil? x) js/undefined x))

;; ---------------------------------------------------------------------------
;; credential ordering
;; ---------------------------------------------------------------------------

(defn reorder-candidates-for-affinities-js
  "`candidates`: `{providerId, account: {accountId}}`; `preferred`: `{providerId, accountId}`."
  [candidates preferred]
  (by-order candidates
            (strategy/candidate-order-for-affinities-js
             (to-array (map (fn [^js c] #js [(.-providerId c) (.-accountId ^js (.-account c))]) (array-seq candidates)))
             (to-array (map (fn [^js p] #js [(.-providerId p) (.-accountId p)]) (array-seq preferred))))))

(defn provider-accounts-for-request-js
  "`accounts` (credentials) in the order this provider/model should try them."
  [accounts provider-id routed-model]
  (by-order accounts
            (strategy/account-order-for-request-js
             provider-id routed-model (to-array (map (fn [^js a] (.-planType a)) (array-seq accounts))) js/undefined)))

(defn reorder-accounts-for-latency-js
  "Accounts by observed latency; the store is asked for each account's perf summary."
  [^js request-log-store provider-id accounts routed-model upstream-mode]
  (by-order accounts
            (strategy/account-order-for-latency-js
             (to-array (map (fn [^js a]
                              (let [perf (.getPerfSummary request-log-store provider-id (.-accountId a) routed-model upstream-mode)]
                                #js {"planType" (.-planType a)
                                     "ttft" (undefined-if-nil (when perf (.-ewmaTtftMs ^js perf)))
                                     "tps" (undefined-if-nil (when perf (.-ewmaTps ^js perf)))}))
                            (array-seq accounts)))
             js/undefined)))

;; ---------------------------------------------------------------------------
;; auto models
;; ---------------------------------------------------------------------------

(defn- max-candidates []
  (strategy/max-auto-model-candidates-js (aget js/process.env "PROXY_AUTO_MODEL_MAX_CANDIDATES") js/undefined))

(defn resolve-auto-model-js
  "`select` is the host ranking: `(model) => modelId | null`. Non-auto models pass through."
  [model select]
  (if (auto-model/is-auto-model-js model)
    (or (select model) model)
    model))

(defn auto-model-candidates-js
  "Ranked candidates for an `auto:<type>` model, capped; `rank` is `(model) => modelId[]`."
  [model rank]
  (if (auto-model/is-auto-model-js model)
    (let [ranked (array-seq (rank model))]
      (to-array (take (max-candidates) ranked)))
    #js [model]))

(defn resolve-cephalon-auto-model-js
  "`rank` is the host ranking: `(innerModel, candidates) => modelId[]`. null when not cephalon."
  [model available-models rank]
  (if (chains/cephalon-model? model)
    (let [^js plan (strategy/cephalon-plan-js model available-models js/undefined)]
      (strategy/cephalon-choice-js model (rank (.-innerModel plan) (.-candidates plan)) js/undefined))
    nil))

(defn cephalon-model-candidates-js [model available-models rank]
  (if (chains/cephalon-model? model)
    (let [resolved (resolve-cephalon-auto-model-js model available-models rank)]
      (if (seq resolved) #js [resolved] #js []))
    #js [model]))

;; ---------------------------------------------------------------------------
;; vision
;; ---------------------------------------------------------------------------

(defn vision-model-candidates-for-js [model available-models]
  (if (chains/vision-model? model)
    (strategy/vision-model-candidates-js available-models js/undefined)
    #js [model]))

(defn reorder-vision-provider-routes-js
  "`routes`: `{providerId, baseUrl}`; providers favoured for the routed model first."
  [routes routed-model]
  (by-order routes
            (strategy/vision-route-order-js routed-model (to-array (map (fn [^js r] (.-providerId r)) (array-seq routes))) js/undefined)))

;; ---------------------------------------------------------------------------
;; advancing to the next candidate
;; ---------------------------------------------------------------------------

(defn should-advance-model-candidate-js
  "`kind` is `auto`, `vision` or `cephalon`: does the routing accumulator `summary` say to
  try the next candidate of that auto model?"
  [kind model has-more summary]
  (let [auto? (case kind
                "auto" (auto-model/is-auto-model-js model)
                "vision" (chains/vision-model? model)
                "cephalon" (chains/cephalon-model? model)
                false)]
    (strategy/should-advance-auto-candidate-js #js {"hasMore" (true? has-more) "autoModel" (true? auto?)} summary js/undefined)))
