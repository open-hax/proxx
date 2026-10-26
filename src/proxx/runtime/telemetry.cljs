(ns proxx.runtime.telemetry
  "Edge of the telemetry client: the active-client atom, span objects, the
  250ms flush timer, the OTLP POSTs and console output. Payload shaping, queue
  accounting and configuration are proxx.telemetry.otlp.

  The JS objects returned have the TelemetryClient / TelemetrySpan shapes."
  (:require [proxx.jsval :as j]
            [proxx.telemetry.otlp :as otlp]))

(def ^:private flush-delay-ms 250)

(defn- now-ms [] (js/Date.now))
(defn- err-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- random-hex [byte-length]
  (let [bytes (js/Uint8Array. byte-length)]
    (.getRandomValues js/crypto bytes)
    (apply str (map #(.padStart (.toString % 16) 2 "0") (array-seq bytes)))))

(defn- attr-value
  "Attribute values keep primitives; anything else is stringified like `String(v)`."
  [v]
  (cond (or (string? v) (number? v) (boolean? v) (nil? v)) v
        :else (js/String v)))

(defn- attrs->alist
  "[[k v] ...] in `Object.entries` order of a JS attributes object (or nothing)."
  [attrs]
  (if (some? attrs)
    (mapv (fn [^js entry] [(aget entry 0) (attr-value (aget entry 1))]) (array-seq (js/Object.entries attrs)))
    []))

(defn- noop-span []
  (let [f (fn [& _] js/undefined)]
    #js {:setAttribute f :setAttributes f :setStatus f :recordError f :end f}))

(defn- noop-client []
  (let [stats #(clj->js otlp/noop-stats)]
    #js {:enabled false
         :startSpan (fn [& _] (noop-span))
         :recordMetric (fn [& _] js/undefined)
         :recordLog (fn [& _] js/undefined)
         :flush (fn [] (js/Promise.resolve js/undefined))
         :shutdown (fn [] (js/Promise.resolve js/undefined))
         :getStats stats}))

(defn- ^:async post! [headers endpoint signal payload]
  (let [url (otlp/signal-endpoint endpoint signal)
        ^js response (await (js/fetch url #js {:method "POST" :headers headers :body (js/JSON.stringify (clj->js payload))}))]
    (when-not (.-ok response)
      (let [body (await (.catch (.text response) (fn [_] "")))]
        (throw (js/Error. (str "OTLP " signal " export failed (" (.-status response) "): " (.slice body 0 200))))))))

(defn- otlp-client [{:keys [endpoint headers service-name resource-attributes]}]
  (let [resource (otlp/resource-attributes service-name resource-attributes)
        header-obj (let [o #js {}] (doseq [[k v] (otlp/request-headers headers)] (aset o k v)) o)
        state (atom otlp/empty-queues)
        timer (atom nil)
        in-flight (atom nil)
        flush (fn ^:async flush []
                (if-let [p @in-flight]
                  (do (await p) js/undefined)
                  (let [[batches state'] (otlp/take-batches @state)]
                    (reset! state state')
                    (when batches
                      (let [{:keys [traces logs metrics]} batches
                            p ((fn ^:async run []
                                 (try
                                   (await (js/Promise.all
                                           #js [(if (seq traces) (post! header-obj endpoint "traces" (otlp/trace-payload traces resource service-name)) (js/Promise.resolve))
                                                (if (seq logs) (post! header-obj endpoint "logs" (otlp/log-payload logs resource service-name)) (js/Promise.resolve))
                                                (if (seq metrics) (post! header-obj endpoint "metrics" (otlp/metric-payload metrics resource service-name)) (js/Promise.resolve))]))
                                   (swap! state otlp/flush-succeeded (.toISOString (js/Date.)))
                                   (catch :default e
                                     (swap! state otlp/flush-failed batches)
                                     (js/console.warn "[telemetry] OTLP flush failed" (err-message e)))
                                   (finally (reset! in-flight nil)))))]
                        (reset! in-flight p)
                        (await p)))
                    js/undefined)))
        schedule-flush (fn []
                         (when-not @timer
                           (reset! timer (js/setTimeout (fn [] (reset! timer nil) (flush)) flush-delay-ms))))
        enqueue! (fn [kind record] (swap! state otlp/enqueue kind record) (schedule-flush))]
    #js {:enabled true
         :startSpan
         (fn [name attributes]
           (let [attr (atom (attrs->alist attributes))
                 status (atom "ok")
                 status-message (atom nil)
                 trace-id (random-hex 16)
                 span-id (random-hex 8)
                 start (otlp/unix-time-nano (now-ms))]
             #js {:setAttribute (fn [k v] (swap! attr otlp/assign k (attr-value v)) js/undefined)
                  :setAttributes (fn [attrs] (swap! attr otlp/assign-all (attrs->alist attrs)) js/undefined)
                  :setStatus (fn [s message] (reset! status s) (reset! status-message message) js/undefined)
                  :recordError (fn [e] (reset! status "error") (reset! status-message (err-message e)) js/undefined)
                  :end (fn [extra]
                         (enqueue! :traces (otlp/span-record {:trace-id trace-id :span-id span-id :name name :start-nano start
                                                              :attributes @attr :status @status :status-message @status-message}
                                                             (attrs->alist extra)
                                                             (otlp/unix-time-nano (now-ms))))
                         js/undefined)}))
         :recordMetric (fn [name value attributes]
                         (enqueue! :metrics (otlp/metric-record name value (attrs->alist attributes) (now-ms)))
                         js/undefined)
         :recordLog (fn [level message attributes]
                      (enqueue! :logs (otlp/log-record level message (attrs->alist attributes) (now-ms)))
                      js/undefined)
         :flush flush
         :shutdown (fn ^:async shutdown []
                     (when-let [t @timer] (js/clearTimeout t) (reset! timer nil))
                     (await (flush))
                     js/undefined)
         :getStats (fn [] (clj->js (otlp/stats @state endpoint)))}))

(defonce ^:private active (atom nil))

(defn- active-client [] (or @active (reset! active (noop-client))))

(defn init-telemetry-js
  "Configure telemetry from `env` (an object like process.env) and make it the active client."
  [^js env]
  (let [{:keys [enabled? endpoint service-name] :as cfg} (otlp/config-from-env #(let [v (aget env %)] (when (some? v) v)))]
    (if-not enabled?
      (do (js/console.log "[telemetry] OTEL disabled (missing endpoint/headers or OTEL_SDK_DISABLED=true)")
          (reset! active (noop-client)))
      (do (js/console.log (str "[telemetry] OTEL enabled: service=" service-name " endpoint=" endpoint))
          (reset! active (otlp-client cfg))))))

(defn get-telemetry-js [] (active-client))

(defn ^:async shutdown-telemetry-js []
  (await (.shutdown ^js (active-client)))
  (reset! active (noop-client))
  js/undefined)
