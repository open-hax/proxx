(ns proxx.runtime.proxy
  "JS edge for src/lib/proxy.ts. Headers cross as plain objects (the TS shim wraps
  them in `Headers`); decisions live in proxx.http.proxy."
  (:require [proxx.http.proxy :as proxy]
            [proxx.policy.contracts :as policy-contracts]
            [proxx.policy.loader :as policy-loader]
            [proxx.queue.policy :as queue-policy]
            [proxx.runtime.http :as http]
            [proxx.runtime.interop :as interop]))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

(defn- headers->js [m] (clj->js m))

(defn forward-headers-js [client-headers]
  (headers->js (proxy/forward-headers (interop/js->data client-headers))))

(defn upstream-headers-js [client-headers api-key]
  (headers->js (proxy/upstream-headers (interop/js->data client-headers) api-key)))

(defn upstream-headers-for-credential-js [client-headers ^js credential options]
  (headers->js
   (proxy/upstream-headers-for-credential
    (interop/js->data client-headers)
    {:token (.-token credential) :chatgpt-account-id (.-chatgptAccountId credential)}
    {:codex-profile? (boolean (when options (aget options "useOpenAiCodexHeaderProfile")))})))

(defn forwardable-response-headers-js
  "`pairs` is an array of [name, value]; returns the pairs worth copying."
  [pairs]
  (clj->js (proxy/forwardable-response-headers (interop/js->data pairs))))

(defn parse-retry-after-ms-js [value]
  (or-undefined (proxy/parse-retry-after-ms value (js/Date.now) #(js/Date.parse %))))

(defonce ^:private compiled-policies (atom {}))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn- compiled-policy [manifest-path]
  (let [manifest-path (or manifest-path default-manifest)]
    (or (get @compiled-policies manifest-path)
        (let [compiled (policy-contracts/compile-contracts
                        (policy-loader/load-policy-contracts! manifest-path))]
          (swap! compiled-policies assoc manifest-path compiled)
          compiled))))

(defn- provider-verdict
  "Provider-specific EDN verdict for this response, or nil (also when the policy
  cannot be loaded: generic heuristics still apply)."
  [status retry-after-ms provider-id manifest-path]
  (when (and (string? provider-id) (seq provider-id))
    (try (queue-policy/classify-rate-limit (compiled-policy manifest-path) provider-id status retry-after-ms)
         (catch :default _ nil))))

(defn classify-rate-limit-kind-js
  [status error-body retry-after-ms threshold-ms provider-id manifest-path]
  (let [retry-after-ms (when (number? retry-after-ms) retry-after-ms)]
    (proxy/classify-rate-limit-kind (interop/js->data error-body)
                                    retry-after-ms
                                    (if (number? threshold-ms) threshold-ms 30000)
                                    (provider-verdict status retry-after-ms provider-id manifest-path))))

(defn detect-ollama-limit-kind-js [error-body]
  (proxy/ollama-limit-kind (interop/js->data error-body)))

(defn parse-wait-time-from-message-js [message]
  (or-undefined (proxy/parse-wait-time-from-message message)))

(defn ^:async extract-rate-limit-cooldown-ms-js
  "Retry-After header first, then the wait time named in the response body."
  [^js response]
  (let [header (parse-retry-after-ms-js (.get (.-headers response) "retry-after"))]
    (if (and (some? header) (pos? header))
      header
      (if-not (proxy/readable-error-content-type? (.get (.-headers response) "content-type"))
        js/undefined
        (let [body (try (interop/js->data (await (.json (.clone response))))
                        (catch :default _ nil))]
          (or-undefined (proxy/cooldown-from-error-body body)))))))

(defn openai-error-js [message type code]
  (clj->js (proxy/openai-error message type (when (some? code) code))))

(defn send-open-ai-error-js
  "Answer a Fastify reply with an OpenAI-shaped error (src/lib/provider-utils.ts)."
  [^js reply status-code message type code]
  (when (some? code) (.header reply "x-open-hax-error-code" code))
  (.send (.code reply status-code) (openai-error-js message type code)))

(defn send-queue-error-js
  "Answer a queue failure (full, dropped, timed out) with its OpenAI-shaped error;
  false when `error` is not one. Which failures those are is
  proxx.http.request/queue-error-response."
  [^js reply error]
  (let [^js response (http/queue-error-response-js error)]
    (if (nil? response)
      false
      (do (when (some? (.-retryAfterSeconds response))
            (.header reply "retry-after" (str (.-retryAfterSeconds response))))
          (send-open-ai-error-js reply (.-statusCode response) (.-message response) (.-type response) (.-code response))
          true))))
