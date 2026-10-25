(ns proxx.strategy.build
  "Upstream request payloads and paths per strategy.

  Each strategy id from the registry (78-strategy-registry.edn) names a payload
  recipe here: which translation to apply to the normalised OpenAI body, which
  provider-specific fields to add or strip. Recipes are pure value-to-value
  functions over string-keyed payloads; the registry holds the facts they read
  (paths, the parameters Codex rejects, default models, token defaults)."
  (:require [clojure.string :as str]
            [proxx.compat.factory :as factory]
            [proxx.compat.messages :as messages]
            [proxx.compat.ollama :as ollama]
            [proxx.compat.responses :as responses]
            [proxx.strategy.payload :as payload]))

;; ---------------------------------------------------------------------------
;; Paths
;; ---------------------------------------------------------------------------

(defn upstream-path
  "The upstream path of strategy `entry` (a registry entry). `facts`:
  `{:provider-paths {kind path} :config {key value} :model s}`; the entry's
  `:strategy/path` says whether the path is fixed, taken from a provider override
  or the configuration, or a template over the model. Nil when the path is owned
  elsewhere (Factory endpoints, Gemini)."
  [entry {:keys [provider-paths config model]}]
  (let [{:keys [static config-key provider-path-key template model-default]} (:strategy/path entry)]
    (cond
      static static
      template (str/replace template "{model}"
                            #?(:cljs (js/encodeURIComponent (if (string? model) model model-default))
                               :clj (if (string? model) model model-default)))
      config-key (or (when provider-path-key (get provider-paths provider-path-key))
                     (get config config-key)))))

;; ---------------------------------------------------------------------------
;; Small recipe steps
;; ---------------------------------------------------------------------------

(defn- without-open-hax [request-body] (dissoc request-body "open_hax"))

(defn- strip-keys [payload ks] (apply dissoc payload ks))

(defn- default-instructions [payload]
  (cond-> payload (nil? (get payload "instructions")) (assoc "instructions" "")))

(defn- store-and-stream [payload] (assoc payload "store" false "stream" true))

(defn normalize-llamacpp-model
  "llama.cpp aliases use hyphens where Ollama-style names use colons."
  [model]
  (str/replace model ":" "-"))

(defn- with-llamacpp-model [payload]
  (cond-> payload (string? (get payload "model")) (update "model" normalize-llamacpp-model)))

(defn- developer-instructions
  "Factory rejects non-empty `instructions`: they move into the input array as a
  developer message."
  [payload]
  (let [instructions (if (string? (get payload "instructions")) (str/trim (get payload "instructions")) "")
        input (get payload "input")]
    (-> (if (and (seq instructions) (sequential? input))
          (assoc payload "input" (into [{"role" "developer" "content" [{"type" "input_text" "text" instructions}]}] input))
          payload)
        (dissoc "instructions"))))

(defn- parameters-for-hf [request-body]
  (cond-> nil
    (contains? request-body "instruction") (assoc "prompt" (get request-body "instruction"))
    (contains? request-body "dimensions") (assoc "truncate_dim" (get request-body "dimensions"))))

(defn- embedding-inputs [request-body]
  (let [input (get request-body "input")] (if (sequential? input) input [input])))

;; ---------------------------------------------------------------------------
;; Recipes
;; ---------------------------------------------------------------------------

(defn build-payload
  "The upstream payload for strategy `id`.
  `inputs`: `{:upstream-body` the normalised chat body, `:request-body` the client's
  raw body, `:headers` client headers, `:rules` the registry's payload rules,
  `:ollama-prefixes`, `:sanitize-system` (fn of the system text; Factory's wire
  profile)`}`."
  [id {:keys [upstream-body request-body headers rules ollama-prefixes sanitize-system]}]
  (let [tier #(payload/apply-requested-service-tier % request-body headers)
        codex-strip #(strip-keys % (:codex-unsupported-params rules))]
    (case id
      :messages (messages/chat-request->messages-request upstream-body)
      :responses (-> (responses/chat-request->responses-request upstream-body) tier payload/strip-trailing-assistant-prefill)
      (:chat-completions :zai-chat :blaze-chat) (payload/ensure-usage-in-stream upstream-body)
      :llamacpp-chat (-> upstream-body with-llamacpp-model payload/ensure-usage-in-stream)
      (:blaze-images :images-passthrough) (without-open-hax request-body)
      :factory-responses-passthrough (-> request-body without-open-hax payload/strip-trailing-assistant-prefill)
      :responses-passthrough (payload/strip-trailing-assistant-prefill upstream-body)
      :responses-via-chat (-> (responses/responses-request->chat-request upstream-body)
                              payload/ensure-usage-in-stream
                              payload/strip-trailing-assistant-prefill)
      (:openai-responses :openai-chat) (-> (responses/chat-request->responses-request upstream-body)
                                           tier codex-strip default-instructions store-and-stream
                                           payload/strip-trailing-assistant-prefill)
      :openai-responses-passthrough (-> upstream-body codex-strip store-and-stream default-instructions
                                        payload/strip-trailing-assistant-prefill)
      :factory-messages
      (let [converted (messages/chat-request->messages-request upstream-body)
            raw-system (get converted "system")
            sanitized (if (string? raw-system) (sanitize-system raw-system) raw-system)
            converted (cond-> converted (not= sanitized raw-system) (assoc "system" sanitized))
            converted (cond-> converted
                        (not (contains? converted "max_tokens")) (assoc "max_tokens" (:factory-default-max-tokens rules)))]
        ;; System content is always inlined for Factory so behaviour is the same for every key type.
        (-> converted messages/normalize-messages-thinking-budget factory/inline-system-prompt))
      :factory-responses (-> (responses/chat-request->responses-request upstream-body) tier store-and-stream developer-instructions)
      :factory-chat upstream-body
      (:ollama-cloud :remote-ollama :ollama) (ollama/chat-request->ollama-request upstream-body ollama-prefixes)
      :local-ollama upstream-body
      :openai-compat-embeddings (with-llamacpp-model request-body)
      :ollama-embeddings request-body
      :hf-embeddings (let [parameters (parameters-for-hf request-body)]
                       (cond-> {"inputs" (embedding-inputs request-body)} parameters (assoc "parameters" parameters)))
      :tei-embeddings (cond-> {"inputs" (embedding-inputs request-body)}
                        (contains? request-body "dimensions") (assoc "truncate_dim" (get request-body "dimensions")))
      :ovm-embeddings (cond-> {"model" (if (string? (get request-body "model")) (get request-body "model") (:ovm-default-model rules))
                               "input" (embedding-inputs request-body)}
                        (contains? request-body "dimensions") (assoc "dimensions" (get request-body "dimensions"))))))
