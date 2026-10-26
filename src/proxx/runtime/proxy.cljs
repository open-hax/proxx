(ns proxx.runtime.proxy
  "JS edge for src/lib/proxy.ts. Headers cross as plain objects (the TS shim wraps
  them in `Headers`); decisions live in proxx.http.proxy."
  (:require [proxx.http.proxy :as proxy]
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

(defn classify-rate-limit-kind-js [error-body retry-after-ms threshold-ms]
  (proxy/classify-rate-limit-kind (interop/js->data error-body)
                                  (when (number? retry-after-ms) retry-after-ms)
                                  (if (number? threshold-ms) threshold-ms 30000)))

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
