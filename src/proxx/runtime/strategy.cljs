(ns proxx.runtime.strategy
  "JS edge for the provider-strategy kernels (src/lib/provider-strategy/**).

  Decisions live in pure `proxx.strategy.*` namespaces; this namespace converts
  JS <-> string-keyed data, reads the clock, and owns the few stateful objects
  (stream accumulators). Property writes use `aset`; host objects are `^js`."
  (:require [proxx.strategy.gemini :as gemini]))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn- now [] (js/Date.now))

(defn- undefined-if-nil [x] (if (nil? x) js/undefined x))

(defn- plain->clj
  "String-keyed data for a JS value. SDK responses are class instances whose own
  properties are plain data, which `js->clj` would otherwise leave untouched."
  [x]
  (if (and (some? x) (identical? "object" (js* "typeof ~{}" x)) (not (array? x)) (not (identical? (type x) js/Object)))
    (js->clj (js/Object.assign #js {} x))
    (js->clj x)))

;; ---------------------------------------------------------------------------
;; Gemini
;; ---------------------------------------------------------------------------

(defn normalize-gemini-reasoning-effort-js [value]
  (undefined-if-nil (gemini/normalize-reasoning-effort value)))

(defn open-ai-messages-to-gemini-contents-js [messages]
  (clj->js (gemini/openai-messages->gemini-contents (js->clj messages))))

(defn extract-system-instructions-js [messages]
  (clj->js (gemini/system-instructions (js->clj messages))))

(defn build-gemini-payload-js [upstream-body routed-model]
  (clj->js (gemini/build-payload (js->clj upstream-body) routed-model)))

(defn gemini-response-to-chat-completion-js [response routed-model]
  (clj->js (gemini/response->chat-completion (plain->clj response) routed-model (now))))

(defn gemini-payload-to-sdk-request-js [model payload]
  (clj->js (gemini/payload->sdk-request model (js->clj payload))))

(defn gemini-upstream-path-js [alias routed-model]
  (gemini/upstream-path (when (some? alias) alias) routed-model))

(defn is-local-gemini-base-url-js [base-url] (gemini/local-base-url? base-url))

(defn is-gemini-sdk-model-js [model] (gemini/sdk-eligible-model? model))

(defn- flags->js [flags]
  (let [o #js {"kind" "continue"}]
    (doseq [[k v] flags]
      (aset o (case k
                :rate-limit "rateLimit"
                :model-not-found "modelNotFound"
                :model-not-supported-for-account "modelNotSupportedForAccount"
                :request-error "requestError"
                :upstream-invalid-request "upstreamInvalidRequest")
            v))
    o))

(defn classify-gemini-sdk-error-js
  "The `continue` attempt outcome for a failure message thrown by the Gemini SDK."
  [message]
  (flags->js (gemini/classify-sdk-error message)))

(defn create-gemini-stream-accumulator-js
  "A stateful accumulator for streamed SDK chunks: `push(chunk)`, then
  `completion(routedModel)` for the final chat completion."
  []
  (let [state (atom gemini/initial-stream)]
    #js {"push" (fn [chunk] (swap! state gemini/stream-step (plain->clj chunk)) nil)
         "completion" (fn [routed-model]
                        (clj->js (gemini/stream->completion @state routed-model (now))))}))
