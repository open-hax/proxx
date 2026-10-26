(ns proxx.telemetry.otlp
  "Pure OTLP/HTTP-JSON shaping and the queue/stats state machine behind the
  telemetry client.

  Attributes are ordered alists [[key value] ...] with JavaScript object
  semantics: assigning an existing key keeps its position, and at export
  integer-like keys sort first (as `Object.entries` orders them). Values are
  string/number/boolean/nil; the edge stringifies anything else first.

  Payloads are string-keyed maps ready for JSON.stringify. Time is an argument
  (`now-ms`); trace/span ids are supplied by the edge.

  Queue state: {:traces [] :logs [] :metrics [] :flushes 0 :dropped 0 :last-flush-at nil}."
  (:require [clojure.string :as str]
            [proxx.jsval :as j]))

;; ---------------------------------------------------------------------------
;; Env parsing
;; ---------------------------------------------------------------------------

(defn assign
  "JavaScript `obj[k] = v` on an alist: replace in place or append."
  [alist k v]
  (if (some #(= k (first %)) alist)
    (mapv #(if (= k (first %)) [k v] %) alist)
    (conj alist [k v])))

(defn assign-all [alist pairs] (reduce (fn [a [k v]] (assign a k v)) alist pairs))

(defn parse-kv-env
  "`k=v,k2=v2` as an alist (value may contain `=`; blank keys are skipped; later
  duplicates replace earlier ones)."
  [value]
  (if (empty? (j/trim value))
    []
    (reduce (fn [acc chunk]
              (let [[raw-key & rest-parts] (str/split chunk #"=" -1)
                    k (j/trim (or raw-key ""))]
                (if (seq k) (assign acc k (j/trim (str/join "=" rest-parts))) acc)))
            [] (str/split value #"," -1))))

(defn resource-attributes
  "The resource alist: `service_name` first, then the parsed env attributes."
  [service-name env-value]
  (assign-all [["service_name" service-name]] (parse-kv-env env-value)))

(defn request-headers
  "Parsed OTLP headers with a forced JSON content type."
  [env-value]
  (assign (parse-kv-env env-value) "content-type" "application/json"))

;; ---------------------------------------------------------------------------
;; Value encoding
;; ---------------------------------------------------------------------------

(defn- integer-value? [x]
  #?(:cljs (js/Number.isInteger x) :clj (integer? x)))

(defn- number-string [x] #?(:cljs (js/String x) :clj (str x)))

(defn any-value
  "The OTLP AnyValue of an attribute value."
  [v]
  (cond
    (string? v) {"stringValue" v}
    (number? v) (if (integer-value? v) {"intValue" (number-string v)} {"doubleValue" v})
    (boolean? v) {"boolValue" v}
    (nil? v) {"stringValue" ""}
    :else {"stringValue" (str v)}))

(defn- index-key? [k]
  (and (re-matches #"0|[1-9]\d*" k)
       (< #?(:cljs (js/Number k) :clj (Double/parseDouble k)) 4294967295)))

(defn export-order
  "Alist in `Object.entries` order: array-index keys ascending, then the rest as inserted."
  [alist]
  (let [{idx true other false} (group-by (comp boolean index-key? first) alist)]
    (vec (concat (sort-by #(#?(:cljs js/Number :clj Double/parseDouble) (first %)) idx) other))))

(defn otlp-attributes [alist]
  (mapv (fn [[k v]] {"key" k "value" (any-value v)}) (export-order alist)))

(defn unix-time-nano
  "Nanoseconds since the epoch, as the decimal string OTLP carries (ms * 1e6)."
  [now-ms]
  (if (zero? now-ms) "0" (str now-ms "000000")))

;; ---------------------------------------------------------------------------
;; Payloads
;; ---------------------------------------------------------------------------

(defn- js-truthy? [v]
  (not (or (nil? v) (false? v) (= v "") (= v 0) (and (number? v) (not= v v)))))

(def ^:private scope {"name" "proxx"})

(defn- resource [resource-alist service-name]
  {"attributes" (otlp-attributes (assign-all [["service" service-name]] resource-alist))})

(defn trace-payload [records resource-alist service-name]
  {"resourceSpans"
   [{"resource" (resource resource-alist service-name)
     "scopeSpans"
     [{"scope" scope
       "spans" (mapv (fn [{:keys [trace-id span-id name start-nano end-nano attributes status status-message]}]
                       {"traceId" trace-id "spanId" span-id "name" name "kind" 1
                        "startTimeUnixNano" start-nano "endTimeUnixNano" end-nano
                        "attributes" (otlp-attributes attributes)
                        "status" {"code" (if (= status "error") 2 1)
                                  "message" (if (js-truthy? status-message) status-message "")}})
                     records)}]}]})

(defn log-payload [records resource-alist service-name]
  {"resourceLogs"
   [{"resource" (resource resource-alist service-name)
     "scopeLogs"
     [{"scope" scope
       "logRecords" (mapv (fn [{:keys [time-nano severity body attributes]}]
                            {"timeUnixNano" time-nano "severityText" severity
                             "body" {"stringValue" body}
                             "attributes" (otlp-attributes attributes)})
                          records)}]}]})

(defn metric-payload [records resource-alist service-name]
  {"resourceMetrics"
   [{"resource" (resource resource-alist service-name)
     "scopeMetrics"
     [{"scope" scope
       "metrics" (mapv (fn [{:keys [time-nano name value attributes]}]
                         {"name" name "unit" "1"
                          "gauge" {"dataPoints" [{"timeUnixNano" time-nano "asDouble" value
                                                  "attributes" (otlp-attributes attributes)}]}})
                       records)}]}]})

(defn signal-endpoint
  "`<base>/v1/<signal>`, resolving relative to the base as a URL does."
  [base-endpoint signal]
  (let [base (if (str/ends-with? base-endpoint "/") base-endpoint (str base-endpoint "/"))]
    #?(:cljs (.toString (js/URL. (str "v1/" signal) base))
       :clj (throw (UnsupportedOperationException. "proxx.telemetry.otlp/signal-endpoint requires the ClojureScript runtime")))))

;; ---------------------------------------------------------------------------
;; Records and queue state
;; ---------------------------------------------------------------------------

(def empty-queues {:traces [] :logs [] :metrics [] :flushes 0 :dropped 0 :last-flush-at nil})

(defn span-record
  [{:keys [trace-id span-id name start-nano attributes status status-message]} extra-attributes end-nano]
  {:trace-id trace-id :span-id span-id :name name :start-nano start-nano :end-nano end-nano
   :attributes (assign-all attributes extra-attributes)
   :status status :status-message status-message})

(defn log-record [level message attributes now-ms]
  {:time-nano (unix-time-nano now-ms) :severity (str/upper-case level) :body message :attributes attributes})

(defn metric-record [name value attributes now-ms]
  {:time-nano (unix-time-nano now-ms) :name name :value value :attributes attributes})

(defn enqueue [state kind record] (update state kind conj record))

(defn take-batches
  "[batches state'] — everything queued, with the queues emptied. `batches` is nil
  when there is nothing to send."
  [state]
  (let [batches (select-keys state [:traces :logs :metrics])]
    [(when (some seq (vals batches)) batches)
     (assoc state :traces [] :logs [] :metrics [])]))

(defn flush-succeeded [state now-iso]
  (-> state (update :flushes inc) (assoc :last-flush-at now-iso)))

(defn flush-failed [state batches]
  (update state :dropped + (reduce + (map count (vals batches)))))

(defn stats [state endpoint]
  {"enabled" true
   "endpoint" endpoint
   "queued" {"traces" (count (:traces state)) "logs" (count (:logs state)) "metrics" (count (:metrics state))}
   "flushes" (:flushes state)
   "dropped" (:dropped state)
   "lastFlushAt" (:last-flush-at state)})

(def noop-stats
  {"enabled" false "endpoint" nil "queued" {"traces" 0 "logs" 0 "metrics" 0}
   "flushes" 0 "dropped" 0 "lastFlushAt" nil})

;; ---------------------------------------------------------------------------
;; Configuration
;; ---------------------------------------------------------------------------

(defn config-from-env
  "{:enabled? :endpoint :headers :service-name :resource-attributes} from an
  env-get fn. Telemetry needs an endpoint and headers and is off when
  OTEL_SDK_DISABLED is `true` (any case)."
  [env-get]
  (let [endpoint (j/trim (or (env-get "OTEL_EXPORTER_OTLP_ENDPOINT") ""))
        headers (j/trim (or (env-get "OTEL_EXPORTER_OTLP_HEADERS") ""))
        disabled? (= "true" (some-> (env-get "OTEL_SDK_DISABLED") j/lower))
        service-name (let [v (env-get "OTEL_SERVICE_NAME")] (if (seq v) v "proxx"))
        resource (let [v (env-get "OTEL_RESOURCE_ATTRIBUTES")] (if (seq v) v ""))]
    {:enabled? (and (not disabled?) (seq endpoint) (seq headers) true)
     :endpoint endpoint :headers headers :service-name service-name :resource-attributes resource}))
