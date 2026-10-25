(ns proxx.runtime.auto-model
  "JS edge for auto-model selection (src/lib/auto-model-selector.ts).

  The edge owns the effects: it reads the request-log and account-health stores
  and the pricing function it is handed, turns them into plain facts, and calls
  the pure ranking. Signatures differ from TS in two deliberate ways: policy
  functions take the manifest path first, and `getModelPricing` (a TS module the
  CLJS runtime cannot import) is passed in as the last argument."
  (:require [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.auto-model :as auto]))

(defonce ^:private profiles (atom {}))

(defn- profile-for [manifest-path]
  (or (get @profiles manifest-path)
      (let [profile (or (->> (loader/load-policy-contracts! manifest-path)
                             (some #(when (= :auto-model-profile (:contract/kind %)) %)))
                        (throw (ex-info "Missing auto-model profile" {:error/type :policy/missing-auto-model-profile})))]
        (swap! profiles assoc manifest-path profile)
        profile)))

(defn is-auto-model-js [model] (auto/auto-model? model))

(defn parse-auto-model-type-js [model] (some-> (auto/parse-auto-type model) name))

(defn- number-field [obj k] (let [v (aget obj k)] (when (number? v) v)))

(defn- pricing-facts [get-model-pricing provider-id model-id]
  (let [p (get-model-pricing provider-id model-id)]
    {:input (aget p "inputPer1MTokens")
     :output (aget p "outputPer1MTokens")
     :found? (aget p "pricingFound")}))

(defn- ttft-ms [request-log-store provider-id model-id]
  (when request-log-store
    (some-> (js-invoke request-log-store "getModelPerfSummary" provider-id model-id "chat")
            (number-field "ewmaTtftMs"))))

(defn- health-score [account-health-store provider-id]
  (if account-health-store
    (auto/aggregate-health
     (map (fn [entry] {"providerId" (aget entry "providerId") "score" (aget entry "score")})
          (array-seq (js-invoke account-health-store "getAllHealthScores")))
     provider-id)
    auto/default-health-score))

(defn- score->js [{:keys [model-id provider-id score cost-score speed-score intelligence-score health-score
                          pricing-found? observed-speed?]}]
  #js {:modelId model-id :providerId provider-id :score score :costScore cost-score
       :speedScore speed-score :intelligenceScore intelligence-score :healthScore health-score
       :pricingFound pricing-found? :observedSpeed observed-speed?})

(defn rank-auto-models-js
  [manifest-path model request-body available-models provider-id request-log-store account-health-store get-model-pricing]
  (let [profile (profile-for manifest-path)]
    (to-array
     (map score->js
          (auto/rank-auto-models
           profile model (js->clj request-body)
           (some-> available-models js->clj)
           provider-id
           (health-score account-health-store provider-id)
           (fn [model-id]
             {:pricing (pricing-facts get-model-pricing provider-id model-id)
              :ttft-ms (ttft-ms request-log-store provider-id model-id)}))))))

(defn select-auto-model-js
  [manifest-path model request-body available-models provider-id request-log-store account-health-store get-model-pricing]
  (let [best (aget (rank-auto-models-js manifest-path model request-body available-models provider-id
                                        request-log-store account-health-store get-model-pricing)
                   0)]
    (if best (aget best "modelId") nil)))
