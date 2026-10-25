(ns proxx.runtime.ollama-context
  "JS edge for Ollama context budgeting. src/lib/ollama-context.ts keeps the
  network fetch of /api/show and its cache; these functions take over the
  decisions. Names are new (the TS exports are the async fetching wrappers):

    ollamaContextLengthFromShow(manifestPath, showPayload) -> number | null
    ollamaContextBudget(kind, requestBody, contextLength)   -> OllamaContextBudget | null
      kind: \"chat\" | \"nativeChat\" | \"embed\""
  (:require [proxx.compat.ollama-context :as ctx]
            [proxx.policy.loader :as loader]))

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
