(ns proxx.http.embeddings
  "POST /v1/embeddings (src/routes/embeddings.ts): provider hints from the model
  prefix, input-size limits, the context-window verdict, the upstream request
  per candidate and the verdict on each upstream answer. Errors are data
  `{:status :message :type :code :meta}`; the edge raises them as OpenAI errors.
  Fetching, queueing and the route filter are effects at the edge."
  (:require [clojure.string :as str]
            [proxx.jsval :as jv]))

(defn- err
  ([status message type code] (err status message type code nil))
  ([status message type code meta] (cond-> {:status status :message message :type type :code code}
                                     meta (assoc :meta meta))))

(def invalid-body (err 400 "Request body must be a JSON object" "invalid_request_error" "invalid_body"))

(defn auto-model-error [model]
  (when (str/starts-with? (jv/lower model) "auto:")
    (err 400 "Auto models are not supported for embeddings requests." "invalid_request_error"
         "model_not_supported" {"requestedModel" model})))

(defn- has-prefix? [model prefixes]
  (let [m (jv/lower model)]
    (boolean (some #(and (seq %) (str/starts-with? m (jv/lower %))) prefixes))))

(defn- matched-prefix [model prefixes]
  (let [m (jv/lower model)]
    (some #(when (and (seq (jv/trim %)) (str/starts-with? m (jv/lower %))) %) prefixes)))

(defn- provider-id-from-prefix [prefix]
  (str/replace (jv/trim prefix) #"[/:]+$" ""))

(defn provider-hints
  "{:explicit-llamacpp? :explicit-ollama? :requested-provider-ids :explicit-provider-id}
  from the model's prefix. A llama.cpp prefix wins over an ollama one."
  [model llamacpp-prefixes ollama-prefixes]
  (let [llamacpp? (has-prefix? model llamacpp-prefixes)
        ollama-prefix (when-not llamacpp? (matched-prefix model ollama-prefixes))
        provider-id (cond llamacpp? "llamacpp-embed"
                          ollama-prefix (provider-id-from-prefix ollama-prefix))]
    {:explicit-llamacpp? llamacpp?
     :explicit-ollama? (some? ollama-prefix)
     :requested-provider-ids (when provider-id [provider-id])
     :explicit-provider-id provider-id}))

(defn routed-model
  "Routing model with the explicit provider prefix removed (`strip` is
  proxx.routing.model-ids/strip-model-prefix)."
  [routing-model {:keys [explicit-llamacpp? explicit-ollama?]} llamacpp-prefixes ollama-prefixes strip]
  (cond explicit-llamacpp? (strip routing-model llamacpp-prefixes)
        explicit-ollama? (strip routing-model ollama-prefixes)
        :else routing-model))

(defn select-routes
  "Policy-selected routes narrowed to the explicit provider, if any."
  [routes explicit-provider-id]
  (if explicit-provider-id
    (filterv #(= explicit-provider-id (get % "providerId")) routes)
    routes))

(defn no-provider-error [routed explicit-provider-id]
  (err 403 "No allowed embedding provider is available for this model." "invalid_request_error"
       "provider_not_allowed" (cond-> {"routedModel" routed}
                                explicit-provider-id (assoc "explicitProviderId" explicit-provider-id))))

(defn input-summary
  "{:item-count :total-chars} of a string or string-array input."
  [input]
  (if (string? input)
    {:item-count (if (seq input) 1 0) :total-chars (count input)}
    {:item-count (count input) :total-chars (reduce + 0 (map count input))}))

(defn limits-error
  "The 400 for an input over the configured batch or character limit, else nil."
  [{:keys [item-count total-chars]} max-items max-chars]
  (cond
    (> item-count max-items)
    (err 400 (str "Embedding batch is too large. Received " item-count " items, maximum: " max-items ".")
         "invalid_request_error" "embed_batch_too_large" {"itemCount" item-count "maxItems" max-items})
    (> total-chars max-chars)
    (err 400 (str "Embedding input is too large. Received " total-chars " chars, maximum: " max-chars ".")
         "invalid_request_error" "embed_input_too_large" {"totalChars" total-chars "maxChars" max-chars})))

(defn context-verdict
  "Budget check for an Ollama candidate. `budget` is the context-budget map (or
  nil). {:error e} when the estimate exceeds the window, else
  {:max-context-tokens n :num-ctx n-or-nil} (`num-ctx` set only when the model's
  loaded window is too small and a larger one is recommended)."
  [budget embed-max-context-tokens]
  (let [max-context (min embed-max-context-tokens
                         (or (get budget "contextLength") embed-max-context-tokens))]
    (if (and budget (> (get budget "estimatedInputTokens") max-context))
      {:error (err 400 (str "Embedding request exceeds model context window for " (get budget "model") ". "
                            "Estimated: " (get budget "estimatedInputTokens") " tokens, maximum: " max-context ".")
                   "invalid_request_error" "embed_context_overflow"
                   {"model" (get budget "model") "estimatedInputTokens" (get budget "estimatedInputTokens")
                    "maxContextTokens" max-context})}
      {:max-context-tokens max-context
       :num-ctx (when (and budget (> (get budget "requiredContextTokens") (get budget "availableContextTokens")))
                  (min max-context (get budget "recommendedNumCtx")))})))

(defn upstream-failure
  "Verdict on a non-ok upstream answer: :next-provider for 5xx, else {:error e}."
  [candidate-id status text]
  (if (>= status 500)
    :next-provider
    {:error (err status (str "Embedding upstream rejected the request: " text)
                 "invalid_request_error" "embedding_upstream_error"
                 {"providerId" candidate-id "status" status})}))

(defn exhausted-error [requested-model routed]
  (err 502 "All embedding providers failed for this model." "server_error"
       "embedding_upstream_unavailable" {"requestedModel" requested-model "routedModel" routed}))
