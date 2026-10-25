(ns proxx.http.request
  "Pure HTTP request helpers: cookie/header reading, bearer checks, model-name
  normalization, HTML escaping and the queue-error -> HTTP mapping.

  Everything here decides; replying (Fastify) and the clock stay at the edge."
  (:require [clojure.string :as str]))

(defn- decode-uri-component [s]
  #?(:cljs (js/decodeURIComponent s)
     :clj (java.net.URLDecoder/decode (str/replace s "+" "%2B") "UTF-8")))

(defn read-cookie-token
  "Value of the first cookie called `name` in a Cookie header, URI-decoded when
  it can be (a malformed escape returns the raw value), else nil."
  [cookie-header name]
  (when (seq cookie-header)
    (let [prefix (str name "=")]
      (some (fn [part]
              (let [trimmed (str/trim part)]
                (when (str/starts-with? trimmed prefix)
                  (let [raw (subs trimmed (count prefix))]
                    (try (decode-uri-component raw)
                         (catch #?(:clj Exception :cljs :default) _ raw))))))
            (str/split cookie-header #";")))))

(defn parse-json-if-possible
  "`{:value parsed}` for a non-blank body that `parse` accepts, else nil. The
  wrapper keeps a literal JSON `null` distinguishable from failure."
  [parse body]
  (when-not (str/blank? body)
    (try {:value (parse body)}
         (catch #?(:clj Exception :cljs :default) _ nil))))

(defn single-header-value
  "A header value as one string: a string as-is, or the first non-empty string of
  a repeated header; nil otherwise."
  [raw]
  (cond (string? raw) raw
        (sequential? raw) (some #(when (and (string? %) (seq %)) %) raw)))

(def ^:private html-escapes
  {\& "&amp;" \< "&lt;" \> "&gt;" \" "&quot;" \' "&#39;"})

(defn escape-html [value] (str/escape value html-escapes))

(defn normalize-requested-model
  "The trimmed model name, or nil when absent, non-string or blank."
  [value]
  (when (string? value)
    (let [trimmed (str/trim value)]
      (when (seq trimmed) trimmed))))

(def ^:private loopback-addresses #{"127.0.0.1" "::1" "::ffff:127.0.0.1"})

(defn trusted-local-bridge-address? [remote-address]
  (contains? loopback-addresses remote-address))

(defn- char-code [s i]
  #?(:cljs (.charCodeAt s i) :clj (int (.charAt ^String s (int i)))))

(defn- constant-time=
  "String equality whose running time does not depend on where they differ."
  [a b]
  (and (= (count a) (count b))
       (zero? (reduce (fn [acc i] (bit-or acc (bit-xor (char-code a i) (char-code b i))))
                      0 (range (count a))))))

(defn bearer-token?
  "Does the Authorization header carry exactly `expected-token` under the
  (case-insensitive) Bearer scheme? Only the first two whitespace-separated
  fields are considered."
  [header expected-token]
  (boolean
   (when (seq header)
     (let [[scheme token] (str/split header #"\s+" -1)]
       (and (= "bearer" (str/lower-case (or scheme "")))
            (string? token)
            (constant-time= token expected-token))))))

;; ---------------------------------------------------------------------------
;; Queue errors -> HTTP
;; ---------------------------------------------------------------------------

(defn- keyword-name
  "The name of an error code that may arrive as a keyword, a `:ns/name` string,
  a plain string, or the `{ns, name}` shape a keyword takes once serialized to JS."
  [value]
  (cond (nil? value) nil
        (keyword? value) (subs (str value) 1)
        (and (map? value) (string? (get value "name")))
        (str (when (string? (get value "ns")) (str (get value "ns") "/")) (get value "name"))
        :else (str/replace-first (str value) #"^:" "")))

(defn- finite-number? [x]
  (and (number? x) #?(:cljs (js/Number.isFinite x) :clj (not (Double/isInfinite (double x))))))

(defn queue-error-response
  "How the HTTP edge should answer a queue failure carried in an error's data, or
  nil when the error is not a queue error. `:retry-after-seconds` is present
  when the queue reported a usable delay."
  [data]
  (let [code (keyword-name (get data :code (get data "code")))
        retry-ms (first (remove nil? [(get data :retry-after-ms (get data "retry-after-ms"))
                                      (get data :retryAfterMs (get data "retryAfterMs"))]))]
    (cond
      (= "queue/full" code)
      (cond-> {:status 429 :message "Request queue full" :type "server_error" :code "queue_full"}
        (finite-number? retry-ms)
        (assoc :retry-after-seconds (max 1 (long (Math/ceil (/ retry-ms 1000))))))

      (contains? #{"queue/dropped" "queue/total-timeout" "queue/exhausted"} code)
      {:status 503 :message "Request queue dropped or timed out" :type "server_error" :code "queue_dropped"})))
