(ns proxx.http.v1
  "Decisions shared by the /v1 inference routes (chat completions, responses,
  images): typed OpenAI errors as data, the route-set derivations around the
  policy filters, the catalog gate, the context-window verdict and the
  responses-route model/candidate rules. Pure over plain data; every effect
  (strategy selection, queueing, upstream attempts, the reply) is the edge's.

  Errors are `{:status :message :type :code :meta}`."
  (:require [clojure.string :as str]
            [proxx.jsval :as jv]))

(defn err
  ([status message type code] (err status message type code nil))
  ([status message type code meta]
   (cond-> {:status status :message message :type type :code code} meta (assoc :meta meta))))

(def invalid-body (err 400 "Request body must be a JSON object" "invalid_request_error" "invalid_body"))
(def missing-model (err 400 "Missing required field: model" "invalid_request_error" "missing_model"))

(defn provider-not-allowed [routed-model]
  (err 403 "No allowed providers are available for this tenant and request." "invalid_request_error"
       "provider_not_allowed" {"routedModel" routed-model}))

(defn model-disabled [routed-model]
  (err 403 (str "Model is disabled: " routed-model) "invalid_request_error" "model_disabled" {"routedModel" routed-model}))

(defn model-not-found [routed-model]
  (err 404 (str "Model not found: " routed-model) "invalid_request_error" "model_not_found" {"routedModel" routed-model}))

(defn requested-model-not-found [requested-model]
  (err 404 (str "Model not found: " requested-model) "invalid_request_error" "model_not_found"
       {"requestedModel" requested-model}))

(defn healthy-nodes-unavailable [routed-model]
  (err 503 "No healthy Ollama nodes are currently available." "server_error" "healthy_nodes_unavailable"
       {"routedModel" routed-model}))

(defn invalid-provider-options [message meta]
  (err 400 message "invalid_request_error" "invalid_provider_options" meta))

(defn provider-unavailable
  ([message meta] (err 502 message "server_error" "provider_unavailable" meta)))

(defn ollama-context-overflow [budget routed-model]
  (err 400
       (str "Request exceeds model context window for " (get budget "model")
            ". Estimated input tokens: " (get budget "estimatedInputTokens")
            ", requested output tokens: " (get budget "requestedOutputTokens")
            ", required total: " (get budget "requiredContextTokens")
            ", available: " (get budget "availableContextTokens")
            ". Reduce input size or request a larger context/model.")
       "invalid_request_error" "ollama_context_overflow" {"routedModel" routed-model "budget" budget}))

(defn context-exceeded?
  "Does the budget need more context than the model offers?"
  [budget]
  (and (some? budget) (> (get budget "requiredContextTokens") (get budget "availableContextTokens"))))

;; ---------------------------------------------------------------------------
;; Route sets
;; ---------------------------------------------------------------------------

(defn initial-provider-filter
  "Which declared routes a chat request considers: factory-prefixed models only
  the factory provider, explicit ollama only ollama, everything otherwise.
  Returns the provider id to keep, or nil for all."
  [{:keys [factory-prefixed explicit-ollama]}]
  (cond factory-prefixed "factory" explicit-ollama "ollama"))

(defn prioritize-openai-route
  "OpenAI-prefixed models try the OpenAI provider first (stable otherwise)."
  [provider-ids openai-prefixed? openai-provider-id]
  (if-not openai-prefixed?
    (vec provider-ids)
    (vec (sort-by #(if (= % openai-provider-id) 0 1) provider-ids))))

(defn policy-context-overrides
  "The strategy-context fields the policy decision adds, as a string-keyed map."
  [{:keys [strategy-mode strategy-mode-by-provider]}]
  (cond-> {}
    (jv/truthy? strategy-mode) (assoc "policyPreferredStrategyMode" strategy-mode)
    (jv/truthy? strategy-mode-by-provider) (assoc "policyPreferredStrategyModeByProvider" strategy-mode-by-provider)))

(defn catalog-gate
  "Verdict after the catalog-aware route filter:
    :ok | :continue (try the next model candidate) | {:error e}
  `check-routes?` is true on the chat route, whose non-local requests also need
  at least one healthy route."
  [{:keys [disabled? rejected? routes-empty? local? has-more? routed-model check-routes?]}]
  (let [stop (fn [e] (if has-more? :continue {:error e}))]
    (cond
      disabled? (stop (model-disabled routed-model))
      (and check-routes? (not local?) routes-empty?) (stop (healthy-nodes-unavailable routed-model))
      (and (or (not check-routes?) (not local?)) rejected?) (stop (model-not-found routed-model))
      :else :ok)))

;; ---------------------------------------------------------------------------
;; /v1/responses
;; ---------------------------------------------------------------------------

(defn explicit-ollama-model? [model]
  (let [n (jv/lower (jv/trim model))]
    (or (str/starts-with? n "ollama/") (str/starts-with? n "ollama:"))))

(defn auto-model? [model] (str/starts-with? (jv/lower model) "auto:"))

(defn responses-candidates
  "The model candidates for a responses request: the one routing model, or for an
  `auto:` model the decision's candidates when it said :ok, else every concrete
  responses-capable model."
  [routing-model auto? auto-decision concrete-model-ids]
  (if auto?
    (vec (if (= "ok" (get auto-decision "status"))
           (or (get auto-decision "candidates") [])
           concrete-model-ids))
    [routing-model]))

(defn auto-candidates-header [candidates] (str/join "," (take 12 candidates)))

(defn exhausted [kind requested-model routed-model]
  (case kind
    :chat (provider-unavailable "All allowed providers rejected the request." {"requestedModel" requested-model})
    :responses (provider-unavailable "All allowed providers rejected the request." {"requestedModel" requested-model})
    :images (provider-unavailable "All allowed image providers rejected the request." {"routedModel" routed-model})))

(defn translation-failed [message meta]
  (err 502 message "server_error" "responses_translation_failed" meta))

(defn stream-translation-failed [message meta]
  (err 502 message "server_error" "responses_stream_translation_failed" meta))
