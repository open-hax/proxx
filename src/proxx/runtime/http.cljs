(ns proxx.runtime.http
  "JS edge for request helpers (src/lib/request-utils.ts, provider-utils.ts).
  Parsed JSON is returned as the original JS value, never round-tripped through
  Clojure data, so key order and nulls are untouched."
  (:require [proxx.http.request :as request]))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

(defn read-cookie-token-js [cookie-header name]
  (or-undefined (request/read-cookie-token cookie-header name)))

(defn parse-json-if-possible-js [body]
  (if-let [{:keys [value]} (request/parse-json-if-possible #(js/JSON.parse %) body)]
    value
    js/undefined))

(defn read-single-header-js [headers name]
  (or-undefined (request/single-header-value (js->clj (aget headers name)))))

(defn escape-html-js [value] (request/escape-html value))

(defn normalize-requested-model-js [value]
  (or-undefined (request/normalize-requested-model value)))

(defn is-trusted-local-bridge-address-js [remote-address]
  (request/trusted-local-bridge-address? remote-address))

(defn has-bearer-token-js [header expected-token]
  (request/bearer-token? header expected-token))

(defn queue-error-response-js
  "{statusCode, message, type, code, retryAfterSeconds?} for a queue failure, else undefined.
  `error` is the thrown value; its `data` is read through the CLJS runtime's ex-data
  conversion (an object with `code` / `retry-after-ms` / `retryAfterMs`)."
  [error]
  (let [raw (when error (aget error "data"))
        data (when (and (some? raw) (= "object" (js* "typeof ~{}" raw)))
               {"code" (js->clj (aget raw "code"))
                "retry-after-ms" (aget raw "retry-after-ms")
                "retryAfterMs" (aget raw "retryAfterMs")})
        {:keys [status message type code retry-after-seconds]} (request/queue-error-response data)]
    (if status
      (clj->js (cond-> {:statusCode status :message message :type type :code code}
                 retry-after-seconds (assoc :retryAfterSeconds retry-after-seconds)))
      js/undefined)))
