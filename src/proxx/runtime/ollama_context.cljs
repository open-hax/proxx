(ns proxx.runtime.ollama-context
  "JS edge for Ollama context budgeting: the /api/show fetch and its cache (an
  immutable map in one atom) around the pure decisions in
  proxx.compat.ollama-context.

    ollamaContextLengthFromShow(manifestPath, showPayload) -> number | null
    ollamaContextBudget(kind, requestBody, contextLength)   -> OllamaContextBudget | null
    fetchOllamaModelContextLength(manifestPath, baseUrl, model, timeoutMs, signal?)
                                                            -> Promise<number | null>
    ensureOllamaContextFits(manifestPath, kind, baseUrl, requestBody, timeoutMs, signal?)
                                                            -> Promise<OllamaContextBudget | null>
      kind: \"chat\" | \"nativeChat\" | \"embed\""
  (:require [proxx.compat.ollama-context :as ctx]
            [proxx.policy.loader :as loader]
            [proxx.runtime.http :as http]))

(defonce ^:private context-keys (atom {}))

(defn- keys-for [manifest-path]
  (or (get @context-keys manifest-path)
      (let [ks (or (some #(when (and (= :provider-wire-profile (:contract/kind %))
                                     (= "ollama" (:wire/provider-id %)))
                            (:wire/context-length-keys %))
                         (loader/load-policy-contracts! manifest-path))
                   (throw (ex-info "Missing ollama wire profile" {:error/type :policy/missing-wire-profile})))]
        (swap! context-keys assoc manifest-path ks)
        ks)))

(defn ollama-context-length-from-show-js [manifest-path payload]
  (ctx/context-length-from-show (keys-for manifest-path) (js->clj payload)))

(def ^:private kinds {"chat" :chat "nativeChat" :native-chat "embed" :embed})

(defn ollama-context-budget-js [kind request-body context-length]
  (when-let [{:keys [model context-length estimated-input-tokens requested-output-tokens
                     required-context-tokens available-context-tokens recommended-num-ctx]}
             (ctx/context-budget (or (kinds kind) (throw (js/Error. (str "Unknown context budget kind: " kind))))
                                 (js->clj request-body) context-length)]
    #js {:model model :contextLength context-length :estimatedInputTokens estimated-input-tokens
         :requestedOutputTokens requested-output-tokens :requiredContextTokens required-context-tokens
         :availableContextTokens available-context-tokens :recommendedNumCtx recommended-num-ctx}))

(defonce ^:private context-cache (atom {}))

(defn- object-payload? [payload]
  (and (some? payload) (= "object" (js* "typeof ~{}" payload))))

(defn ^:async show-payload
  "The parsed /api/show body, or nil when the request or the parse failed."
  [base-url model timeout-ms signal]
  (try
    (let [^js response (await (http/fetch-with-response-timeout-js
                                (ctx/show-url base-url)
                                #js {:method "POST"
                                     :headers #js {"content-type" "application/json"}
                                     :body (js/JSON.stringify #js {:model model})
                                     :signal signal}
                                timeout-ms))]
      (when (.-ok response) (await (.json response))))
    (catch :default _ nil)))

(defn ^:async fetch-ollama-model-context-length-js
  "A model's context window from /api/show; nil when unknown. A fresh cache hit
  skips the request; a failed request falls back to a stale entry, else nil."
  [manifest-path base-url model timeout-ms signal]
  (let [k (ctx/cache-key base-url model)]
    (if-some [fresh (ctx/cached-length @context-cache k (js/Date.now) false)]
      fresh
      (let [payload (await (show-payload base-url model timeout-ms signal))]
        (if-not (object-payload? payload)
          ;; request failed or the body was not an object: a stale entry still answers
          (ctx/cached-length @context-cache k (js/Date.now) true)
          ;; a well-formed payload that names no length is authoritative: unknown
          (let [length (ollama-context-length-from-show-js manifest-path payload)]
            (when (some? length)
              (swap! context-cache ctx/remember k length (js/Date.now)))
            length))))))

(defn ^:async ensure-ollama-context-fits-js [manifest-path kind base-url request-body timeout-ms signal]
  (let [model (aget request-body "model")]
    (when (and (string? model) (seq model))
      (let [length (await (fetch-ollama-model-context-length-js manifest-path base-url model timeout-ms signal))]
        (when (and length (pos? length))
          (ollama-context-budget-js kind request-body length))))))
