(ns proxx.runtime.http
  "JS edge for request helpers (src/lib/request-utils.ts, provider-utils.ts).
  Parsed JSON is returned as the original JS value, never round-tripped through
  Clojure data, so key order and nulls are untouched."
  (:require ["node:crypto" :as crypto]
            [proxx.http.request :as request]
            [proxx.http.request-facts :as facts]))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

;; Request facts (src/lib/openai/request-handling.ts)

(defn- sha256-hex [text]
  (-> (.createHash crypto "sha256") (.update text) (.digest "hex")))

(defn extract-prompt-cache-key-js [body]
  (or-undefined (facts/prompt-cache-key (js->clj body))))

(defn hash-prompt-cache-key-js [prompt-cache-key]
  (facts/hash-prompt-cache-key sha256-hex prompt-cache-key))

(defn append-csv-header-value-js
  "Make `value` part of the CSV header `name` of the web `Headers`, once."
  [^js headers name value]
  (when-some [updated (facts/csv-header-with (.get headers name) value)]
    (.set headers name updated))
  nil)

(defn should-enable-interleaved-thinking-header-js [upstream-payload]
  (facts/interleaved-thinking? (js->clj upstream-payload)))

(defn summarize-responses-request-body-js [body]
  (clj->js (facts/summarize-responses-request (js->clj body))))

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
        data (cond
               ;; what the queue runtime throws: an ex-info whose data is a Clojure map
               (map? raw) raw
               (and (some? raw) (= "object" (js* "typeof ~{}" raw)))
               {"code" (js->clj (aget raw "code"))
                "retry-after-ms" (aget raw "retry-after-ms")
                "retryAfterMs" (aget raw "retryAfterMs")})
        {:keys [status message type code retry-after-seconds]} (request/queue-error-response data)]
    (if status
      (clj->js (cond-> {:statusCode status :message message :type type :code code}
                 retry-after-seconds (assoc :retryAfterSeconds retry-after-seconds)))
      js/undefined)))

;; The transport behind a response, so a body that stalls after the headers can
;; still be torn down (`abort-fetch-response!`).
(defonce ^:private response-controllers (js/WeakMap.))

(defn abort-fetch-response!
  "Abort the transport that produced `response` (a `fetch-with-response-timeout-js`
  result) after its headers were received. No-op for any other response."
  [^js response reason]
  (let [^js controller (.get response-controllers response)]
    (when (and controller (not (.. controller -signal -aborted)))
      (.abort controller reason))
    nil))

(defn ^:async fetch-with-response-timeout-js
  "`fetch` that aborts with a TimeoutError when no response arrives within
  `timeout-ms` (src/lib/http/fetch-utils.ts). A caller's own signal also aborts it."
  [url ^js init timeout-ms]
  (let [controller (js/AbortController.)
        handle (js/setTimeout
                #(.abort controller (js/DOMException. "The operation was aborted due to timeout" "TimeoutError"))
                timeout-ms)
        signal (if (.-signal init)
                 (.any js/AbortSignal #js [(.-signal init) (.-signal controller)])
                 (.-signal controller))]
    (try
      (let [^js response (await (js/fetch url (js/Object.assign #js {} init #js {:signal signal})))]
        (.set response-controllers response controller)
        response)
      (finally (js/clearTimeout handle)))))
