(ns proxx.telemetry.otlp-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.runtime.telemetry :as edge]
            [proxx.telemetry.otlp :as o]))

(deftest env-parsing
  (is (= [["Authorization" "Basic abc=="] ["X-Other" "v=w"] ["k" ""]]
         (o/parse-kv-env " Authorization=Basic abc==, X-Other = v=w ,,=x, k "))
      "values keep `=`; blank keys are skipped; a bare key has an empty value")
  (is (= [] (o/parse-kv-env "  ")))
  (is (= [["a" "2"]] (o/parse-kv-env "a=1,a=2")) "a later duplicate replaces in place")
  (is (= [["a" "b"] ["content-type" "application/json"]] (o/request-headers "a=b,content-type=text/plain"))
      "the JSON content type is forced")
  (is (= [["service_name" "svc"] ["env" "prod"]] (o/resource-attributes "svc" "env=prod")))
  (is (= [["service_name" "override"]] (o/resource-attributes "svc" "service_name=override"))))

(deftest attribute-values
  (is (= {"stringValue" "s"} (o/any-value "s")))
  (is (= {"intValue" "3"} (o/any-value 3)))
  (is (= {"intValue" "1e+21"} (o/any-value 1e21)) "integers are rendered as JavaScript renders them")
  (is (= {"doubleValue" 2.5} (o/any-value 2.5)))
  (is (= {"boolValue" false} (o/any-value false)))
  (is (= {"stringValue" ""} (o/any-value nil)))
  (testing "export order is Object.entries order: array-index keys first, ascending"
    (is (= ["2" "10" "b" "a" "01" "4294967295"]
           (map first (o/export-order [["b" 1] ["10" 1] ["a" 1] ["2" 1] ["01" 1] ["4294967295" 1]]))))))

(deftest payload-shape
  (let [res (o/resource-attributes "svc" "")
        span (o/span-record {:trace-id "t" :span-id "s" :name "op" :start-nano "1" :attributes [["a" 1]]
                             :status "error" :status-message nil}
                            [["b" "x"] ["a" 2]] "2")
        p (o/trace-payload [span] res "svc")]
    (is (= [{"key" "a" "value" {"intValue" "2"}} {"key" "b" "value" {"stringValue" "x"}}]
           (get-in p ["resourceSpans" 0 "scopeSpans" 0 "spans" 0 "attributes"])))
    (is (= {"code" 2 "message" ""} (get-in p ["resourceSpans" 0 "scopeSpans" 0 "spans" 0 "status"])))
    (is (= [{"key" "service" "value" {"stringValue" "svc"}} {"key" "service_name" "value" {"stringValue" "svc"}}]
           (get-in p ["resourceSpans" 0 "resource" "attributes"]))))
  (is (= "1700000123456000000" (o/unix-time-nano 1700000123456)))
  (is (= "0" (o/unix-time-nano 0)))
  (is (= "INFO" (:severity (o/log-record "info" "m" [] 1))))
  (is (= {"name" "m" "unit" "1"}
         (select-keys (get-in (o/metric-payload [(o/metric-record "m" 1.5 [] 1)] [] "s")
                              ["resourceMetrics" 0 "scopeMetrics" 0 "metrics" 0])
                      ["name" "unit"])))
  (is (= "https://o.test/base/v1/traces" (o/signal-endpoint "https://o.test/base" "traces")))
  (is (thrown? js/Error (o/signal-endpoint "not a url" "traces"))))

(deftest queue-accounting
  (let [s (-> o/empty-queues (o/enqueue :traces :t) (o/enqueue :logs :l) (o/enqueue :metrics :m))
        [batches s'] (o/take-batches s)]
    (is (= {:traces [:t] :logs [:l] :metrics [:m]} batches))
    (is (= [[] [] []] ((juxt :traces :logs :metrics) s')))
    (is (nil? (first (o/take-batches s'))) "nothing queued, nothing to send")
    (is (= 3 (:dropped (o/flush-failed s' batches))))
    (is (= ["now" 1] ((juxt :last-flush-at :flushes) (o/flush-succeeded s' "now"))))
    (is (= {"traces" 1 "logs" 1 "metrics" 1} (get (o/stats s "https://e") "queued")))))

(deftest configuration
  (let [env (fn [m] #(get m %))]
    (is (false? (boolean (:enabled? (o/config-from-env (env {}))))))
    (is (false? (boolean (:enabled? (o/config-from-env (env {"OTEL_EXPORTER_OTLP_ENDPOINT" "https://o"}))))) "headers are required too")
    (let [c (o/config-from-env (env {"OTEL_EXPORTER_OTLP_ENDPOINT" " https://o " "OTEL_EXPORTER_OTLP_HEADERS" "a=b" "OTEL_SERVICE_NAME" ""}))]
      (is (true? (:enabled? c)))
      (is (= ["https://o" "proxx"] ((juxt :endpoint :service-name) c)) "endpoint is trimmed; an empty service name falls back"))
    (is (false? (boolean (:enabled? (o/config-from-env (env {"OTEL_EXPORTER_OTLP_ENDPOINT" "https://o" "OTEL_EXPORTER_OTLP_HEADERS" "a=b"
                                                             "OTEL_SDK_DISABLED" "TRUE"}))))))))

(deftest ^:async edge-exports-through-the-injected-fetch
  (let [posts (atom [])
        real-fetch (.-fetch js/globalThis)]
    (set! (.-fetch js/globalThis) (fn [url init]
                                    (swap! posts conj [url (js->clj (js/JSON.parse (.-body init)))])
                                    (js/Promise.resolve #js {:ok true})))
    (try
      (let [c (edge/init-telemetry-js #js {"OTEL_EXPORTER_OTLP_ENDPOINT" "https://o.test" "OTEL_EXPORTER_OTLP_HEADERS" "a=b"})]
        (is (true? (.-enabled c)))
        (testing "intentional divergence: null attributes mean none; the TypeScript threw while shaping the batch and dropped every queued record"
          (.recordMetric c "m" 1 nil)
          (.recordLog c "info" "hello" nil))
        (await (.flush c))
        (is (= #{"https://o.test/v1/logs" "https://o.test/v1/metrics"} (set (map first @posts))))
        (is (= 0 (get (js->clj (.getStats c)) "dropped")))
        (await (edge/shutdown-telemetry-js))
        (is (false? (.-enabled (edge/get-telemetry-js)))))
      (finally (set! (.-fetch js/globalThis) real-fetch)))))
