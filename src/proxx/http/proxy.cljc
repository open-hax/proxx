(ns proxx.http.proxy
  "Request-forwarding and rate-limit decisions (src/lib/proxy.ts).

  Headers are plain `{lower-case-name value}` maps; the edge turns them into a
  `Headers`. Bodies are parsed wire data (string-keyed maps). Time and date
  parsing are arguments, never ambient."
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Headers
;; ---------------------------------------------------------------------------

(def hop-by-hop-headers
  #{"connection" "content-length" "keep-alive" "proxy-authenticate" "proxy-authorization"
    "te" "trailer" "transfer-encoding" "upgrade"})

(def blocked-request-headers
  #{"authorization" "connection" "content-length" "cookie" "expect" "host"
    "proxy-authenticate" "proxy-authorization" "te" "trailer" "transfer-encoding" "upgrade"})

(def ^:private openai-browser-fingerprint-headers
  #{"accept-language" "cookie" "dnt" "origin" "priority" "referer" "upgrade-insecure-requests"
    "user-agent" "x-real-ip" "true-client-ip" "cf-connecting-ip" "cf-ipcountry" "cf-ray" "cdn-loop"})

(defn- fingerprint-header? [name]
  (let [n (str/lower-case name)]
    (or (contains? openai-browser-fingerprint-headers n)
        (str/starts-with? n "sec-")
        (str/starts-with? n "x-forwarded-"))))

(defn- header-value
  "A client header as one string: repeated headers are comma-joined."
  [raw]
  (if (sequential? raw) (str/join ", " raw) raw))

(defn forward-headers
  "Client headers that may be sent upstream. Blocked names (credentials, cookies,
  hop-by-hop) and empty/non-string values are dropped; content-type defaults to
  JSON."
  [client-headers]
  (let [kept (reduce (fn [acc [raw-name raw-value]]
                       (let [n (str/lower-case (str raw-name))
                             v (header-value raw-value)]
                         (if (and (not (contains? blocked-request-headers n))
                                  (string? v) (seq v))
                           (assoc acc n v)
                           acc)))
                     {} client-headers)]
    (cond-> kept
      (not (contains? kept "content-type")) (assoc "content-type" "application/json"))))

(defn upstream-headers [client-headers api-key]
  (assoc (forward-headers client-headers) "authorization" (str "Bearer " api-key)))

(defn upstream-headers-for-credential
  "`credential` is {:token :chatgpt-account-id}; `codex-profile?` strips browser
  fingerprints and presents as the Codex CLI."
  [client-headers {:keys [token chatgpt-account-id]} {:keys [codex-profile?]}]
  (let [base (if (seq token) (upstream-headers client-headers token) (forward-headers client-headers))
        with-account (cond-> base (seq chatgpt-account-id) (assoc "chatgpt-account-id" chatgpt-account-id))]
    (if codex-profile?
      (assoc (into {} (remove (fn [[k _]] (fingerprint-header? k))) with-account)
             "originator" "codex_cli_rs")
      with-account)))

(defn forwardable-response-headers
  "The `[name value]` pairs of an upstream response worth copying to the client."
  [pairs]
  (into [] (remove (fn [[name _]] (contains? hop-by-hop-headers (str/lower-case name)))) pairs))

;; ---------------------------------------------------------------------------
;; Retry-After
;; ---------------------------------------------------------------------------

(defn- js-number
  "JavaScript `Number(s)` for a string (NaN when unparseable)."
  [s]
  #?(:cljs (js/Number s)
     :clj (try (Double/parseDouble (str/trim s)) (catch Exception _ ##NaN))))

(defn- finite? [x]
  #?(:cljs (js/Number.isFinite x) :clj (and (number? x) (not (Double/isNaN x)) (not (Double/isInfinite x)))))

(defn parse-retry-after-ms
  "Milliseconds a Retry-After header asks for: delta-seconds, or an HTTP date
  relative to `now-ms` (`parse-date-ms` is Date.parse). nil when absent/invalid."
  [value now-ms parse-date-ms]
  (when (and (string? value) (seq value))
    (let [as-seconds (js-number value)]
      (if (and (finite? as-seconds) (>= as-seconds 0))
        (* as-seconds 1000)
        (let [as-date (parse-date-ms value)]
          (when-not (or (nil? as-date) (not (finite? as-date)))
            (max 0 (- as-date now-ms))))))))

;; ---------------------------------------------------------------------------
;; Rate-limit classification
;; ---------------------------------------------------------------------------

(defn error-message
  "The human message inside an upstream error body: a string body, `error` as a
  string, `message`, or the same one level down inside an `error` object."
  [body]
  (cond
    (string? body) body
    (map? body) (let [e (get body "error")]
                  (cond (string? e) e
                        (string? (get body "message")) (get body "message")
                        :else (when (map? e) (error-message e))))))

(defn ollama-limit-kind
  "\"weekly\" | \"session\" | \"unknown\"."
  [body]
  (if-let [message (error-message body)]
    (let [lowered (str/lower-case message)]
      (cond (str/includes? lowered "weekly usage limit") "weekly"
            (str/includes? lowered "session usage limit") "session"
            :else "unknown"))
    "unknown"))

(def ^:private concurrency-indicators
  ["concurrent" "concurrency" "too many requests" "request rate" "requests per" "rpm limit"
   "tpm limit" "capacity" "temporarily limited" "slow down" "please wait" "try again in"])

(def ^:private quota-keywords
  ["usage limit" "quota" "exhausted" "insufficient" "balance" "credit" "billing" "payment"
   "plan limit" "monthly limit" "daily limit"])

(defn classify-rate-limit-kind
  "\"quota_exhausted\" (fall over to another account) or \"concurrency_throttle\"
  (wait and retry the same credential). Quota keywords win over concurrency
  wording; a short positive retry-after with neither is a throttle; the default
  is quota."
  ([body retry-after-ms] (classify-rate-limit-kind body retry-after-ms 30000))
  ([body retry-after-ms threshold-ms]
   (let [lowered (some-> (error-message body) str/lower-case)
         mentions? (fn [needles] (some #(str/includes? lowered %) needles))]
     (cond
       (contains? #{"session" "weekly"} (ollama-limit-kind body)) "quota_exhausted"
       (and lowered (mentions? quota-keywords)) "quota_exhausted"
       (and lowered (mentions? concurrency-indicators)) "concurrency_throttle"
       (and (number? retry-after-ms) (finite? retry-after-ms) (pos? retry-after-ms)
            (<= retry-after-ms threshold-ms)) "concurrency_throttle"
       :else "quota_exhausted"))))

;; ---------------------------------------------------------------------------
;; Wait time in prose
;; ---------------------------------------------------------------------------

(def ^:private duration-re
  #"(?i)(\d+(?:\.\d+)?)\s*(d|days?|h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)\b")

(def ^:private unit-ms
  {\d 86400000 \h 3600000 \m 60000 \s 1000})

(defn- ceil-long [x] (long (Math/ceil x)))

(defn- parse-float [s]
  #?(:cljs (js/parseFloat s) :clj (Double/parseDouble s)))

(defn- parse-int [s]
  #?(:cljs (js/parseInt s 10) :clj (Long/parseLong s)))

(defn parse-wait-time-from-message
  "Milliseconds of wait named in a rate-limit message (\"try again in 2m30s\",
  \"Please wait 1.37s\", \"5d 12h\"), or nil. Every duration component is summed."
  [message]
  (when (string? message)
    (let [lower (str/lower-case message)
          total (reduce (fn [acc [_ value unit]]
                          (+ acc (ceil-long (* (parse-float value) (unit-ms (first (str/lower-case unit)))))))
                        0 (re-seq duration-re lower))]
      (or (when (pos? total) total)
          (when-let [[_ m s] (re-find #"(?i)(\d+)\s*m\s*(\d+)\s*s" lower)]
            (let [minutes (parse-int m) seconds (parse-int s)]
              (when (or (pos? minutes) (pos? seconds))
                (* (+ (* minutes 60) seconds) 1000))))
          (when-let [[_ v] (re-find #"(?i)(\d+(?:\.\d+)?)\s*(s(?:econds?)?|seconds?|secs?)\b" lower)]
            (let [seconds (parse-float v)]
              (when (and (finite? seconds) (pos? seconds)) (ceil-long (* seconds 1000)))))
          (when-let [[_ v] (re-find #"(?i)(\d+)\s*(?:minutes?|mins?)\b" lower)]
            (let [minutes (parse-int v)] (when (pos? minutes) (* minutes 60000))))
          (when-let [[_ v] (re-find #"(?i)(\d+)\s*(?:hours?|hrs?)\b" lower)]
            (let [hours (parse-int v)] (when (pos? hours) (* hours 3600000))))))))

(defn readable-error-content-type?
  "Is a 429 body worth parsing for a wait time (JSON or text)?"
  [content-type]
  (let [ct (or content-type "")]
    (or (str/includes? ct "application/json") (str/includes? ct "text/"))))

(defn cooldown-from-error-body
  "Wait time from an OpenAI-style `{error: {message}}` body, or nil."
  [body]
  (let [error (when (map? body) (get body "error"))
        message (when (map? error) (get error "message"))]
    (when (string? message) (parse-wait-time-from-message message))))

;; ---------------------------------------------------------------------------
;; OpenAI error envelope
;; ---------------------------------------------------------------------------

(defn openai-error [message type code]
  {"error" (cond-> (array-map "message" message "type" type)
             (some? code) (assoc "code" code)
             true (assoc "param" nil))})
