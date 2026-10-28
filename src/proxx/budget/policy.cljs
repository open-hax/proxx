(ns proxx.budget.policy
  (:require [clojure.string :as str]
            [proxx.policy.contracts :as contracts]))

(defn request-budget [contracts auth]
  (when (= "tenant_api_key" (:kind auth))
    (some #(when (and (= :paid-budget (:contract/kind %))
                     (= (:match/key-id %) (:keyId auth))) %)
          contracts)))

(defn route-plan [contracts auth model-id]
  (when-let [budget (request-budget contracts auth)]
    (if (contracts/pattern-matches? (:budget/routing-model-pattern budget) model-id)
      {:managed true
       :totalFirstUsableMs (:budget/first-output-total-ms budget)
       :maxBootstrapBytes (:budget/max-bootstrap-bytes budget)
       :maxRetries (:budget/max-retries budget)
       :needsReasoningTrace false
       :orderedRoutes (mapv (fn [route]
                              {:providerId (:provider-id route)
                               :upstreamModel (:model-id route)
                               :firstUsableOffsetMs (if (= :free (:billing route))
                                                      (:budget/free-cutoff-ms budget)
                                                      (:budget/first-output-total-ms budget))})
                            (filter #(not= false (:plan? %)) (:budget/routes budget)))}
      {:managed true})))

(defn inspect-attempt
  "Identity comes from server-resolved auth, never request metadata. Matching
   callers cannot escape their allowance by changing a model or provider."
  [contracts auth {:keys [providerId model mode payload]}]
  (if-let [budget (request-budget contracts auth)]
    (let [route (some #(when (and (= (:provider-id %) (str/lower-case providerId))
                                 (= (str/lower-case (:model-id %)) (str/lower-case model))) %)
                      (:budget/routes budget))
          requested-output (or (:max_tokens payload) (:max_completion_tokens payload)
                               (:budget/max-output-tokens budget))
          output-cap (:budget/max-output-tokens budget)
          completions (or (:n payload) 1)
          best-of (or (:best_of payload) 1)]
      (if (and route (contains? (:budget/allowed-modes budget) mode)
               (integer? requested-output) (pos? requested-output)
               (= 1 completions) (= 1 best-of))
        {:status (name (:billing route))
         :quotaScope (some-> (:quota/scope route) name)
         :quotaDisable (:quota/disable? route)
         :policy {:scopeId (:budget/scope-id budget)
                  :dailyMicrousd (:budget/daily-microusd budget)
                  :monthlyMicrousd (:budget/monthly-microusd budget)}
         :inputBound (:budget/max-input-tokens budget)
         :outputBound (min requested-output output-cap)
         :payload (-> payload
                      (dissoc :max_completion_tokens)
                      (assoc :max_tokens (min requested-output output-cap)))}
        {:status "denied"}))
    {:status "unmanaged"}))


(defn snapshot-selection [contracts auth requested-key-id]
  (let [own? (= "tenant_api_key" (:kind auth))
        admin? (= "legacy_admin" (:kind auth))
        key-id (if own? (:keyId auth) requested-key-id)]
    (if (or (not (or own? admin?))
            (and own? requested-key-id (not= requested-key-id (:keyId auth))))
      {:status "forbidden"}
      {:status "ok"
       :policies (mapv (fn [c]
                         {:scopeId (:budget/scope-id c)
                          :keyId (:match/key-id c)
                          :calendar "utc"
                          :dailyMicrousd (:budget/daily-microusd c)
                          :monthlyMicrousd (:budget/monthly-microusd c)
                          :freeCutoffMs (:budget/free-cutoff-ms c)
                          :totalFirstUsableMs (:budget/first-output-total-ms c)
                          :routes (mapv #(hash-map :providerId (:provider-id %)
                                                   :upstreamModel (:model-id %)
                                                   :billing (name (:billing %)))
                                        (:budget/routes c))})
                       (filter #(and (= :paid-budget (:contract/kind %))
                                     (or (and admin? (nil? key-id)) (= key-id (:match/key-id %))))
                               contracts))})))

(defn snapshot-usage [policy row]
  (let [daily (:dailyChargedMicrousd row)
        monthly (:monthlyChargedMicrousd row)
        held (:heldMicrousd row)]
    (assoc policy :status "ok" :usage row
           :dailyRemainingMicrousd (max 0 (- (:dailyMicrousd policy) daily held))
           :monthlyRemainingMicrousd (max 0 (- (:monthlyMicrousd policy) monthly held)))))


(defn zero-charge-refusal?
  "Only declared pre-inference refusals with an explicit error and no usage or
   generated-output evidence may release a hold. Unknown/partial results retain it."
  [contracts auth {:keys [providerId model status body]}]
  (boolean
    (when-let [budget (request-budget contracts auth)]
      (let [route (some #(when (and (= :paid (:billing %))
                                   (= (:provider-id %) providerId)
                                   (= (:model-id %) model)) %) (:budget/routes budget))]
        (and route (contains? (:billing/no-charge-statuses route) status)
             (map? body) (some? (:error body))
             (not-any? #(contains? body %) [:usage :usageMetadata :choices :output]))))))
