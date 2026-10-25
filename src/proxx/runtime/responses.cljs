(ns proxx.runtime.responses
  "JS boundary for Responses-API compatibility. The translation itself is pure
  (`proxx.compat.responses*`); this namespace converts at the edge, reads the
  clock, drives a ReadableStream, and paces synthetic chunks."
  (:require [proxx.compat.responses :as responses]
            [proxx.compat.responses.stream :as stream]))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn- call-js
  "Convert JS args to string-keyed data, call `f`, convert the result back.
  Domain errors surface as plain Errors, as before."
  [f & args]
  (try
    (clj->js (apply f (map js->clj args)))
    (catch :default e (rethrow-as-error e))))

(defn- undefined-if-nil [x] (if (nil? x) js/undefined (clj->js x)))

(defn- now [] (js/Date.now))

(defn should-use-responses-upstream-js [model prefixes]
  (responses/should-use-responses-upstream? model (js->clj prefixes)))

(defn chat-request-to-responses-request-js [body]
  (call-js responses/chat-request->responses-request body))

(defn responses-request-to-chat-request-js [body]
  (call-js responses/responses-request->chat-request body))

(defn chat-completion-to-responses-response-js [completion]
  (call-js #(responses/chat-completion->responses-response % (now)) completion))

(defn responses-to-chat-completion-js [response fallback-model]
  (call-js #(responses/responses->chat-completion % fallback-model (now)) response))

(defn responses-output-has-reasoning-js [response]
  (responses/output-has-reasoning? (js->clj response)))

(defn responses-event-stream-to-error-payload-js [text]
  (undefined-if-nil (stream/event-stream->error-payload text)))

(defn extract-terminal-response-from-event-stream-js [text]
  (undefined-if-nil (stream/extract-terminal-response text)))

(defn responses-event-stream-to-chat-completion-js [text fallback-model]
  (try (clj->js (stream/event-stream->chat-completion text fallback-model (now)))
       (catch :default e (rethrow-as-error e))))

(defn chat-completion-event-stream-to-responses-event-stream-js [text fallback-model]
  (try (stream/chat-event-stream->responses-event-stream text fallback-model (now))
       (catch :default e (rethrow-as-error e))))

(defn chat-completion-event-stream-to-responses-response-js [text fallback-model]
  (try (clj->js (stream/chat-event-stream->responses-response text fallback-model (now)))
       (catch :default e (rethrow-as-error e))))

(defn chat-completion-to-sse-js [completion]
  (stream/chat-completion->sse (js->clj completion) (now)))

;; ---------------------------------------------------------------------------
;; Paced replay (STREAM_CHUNK_DELAY_MS / _MIN / _MAX)
;; ---------------------------------------------------------------------------

(defn- env-number [k]
  (when-let [raw (aget js/process.env k)] (js/Number raw)))

(defn- delay-range
  "{:min :max} milliseconds from the environment; zeros when unset or invalid."
  []
  (let [zero {:min 0 :max 0}
        valid? #(and (js/Number.isFinite %) (>= % 0))
        fixed (env-number "STREAM_CHUNK_DELAY_MS")
        lo (env-number "STREAM_CHUNK_DELAY_MS_MIN")
        hi (env-number "STREAM_CHUNK_DELAY_MS_MAX")]
    (cond
      (some? fixed) (if (valid? fixed) {:min fixed :max fixed} zero)
      (and (nil? lo) (nil? hi)) zero
      :else (let [lo (or lo 0) hi (or hi lo)]
              (if (and (valid? lo) (valid? hi)) {:min (min lo hi) :max (max lo hi)} zero)))))

(def ^:private chunk-delay-range (delay (delay-range)))

(defn- next-delay-ms []
  (let [{:keys [min max]} @chunk-delay-range]
    (cond (<= max 0) 0
          (>= min max) min
          :else (+ min (* (js/Math.random) (- max min))))))

(defn- sleep [ms] (js/Promise. (fn [resolve] (js/setTimeout resolve ms))))

(defn- ^:async write-paced [write-fn [{:keys [data pace?] :as _chunk} & more]]
  (when data
    (write-fn data)
    (when pace?
      (let [ms (next-delay-ms)]
        (when (pos? ms) (await (sleep ms)))))
    (await (write-paced write-fn more))))

(defn ^:async write-interleaved-responses-sse-js
  "Replay a finished Responses body as chat chunks through `write-fn`."
  [response fallback-model write-fn]
  (await (write-paced write-fn (stream/interleaved-chunks (js->clj response) fallback-model (now)))))

;; ---------------------------------------------------------------------------
;; True streaming
;; ---------------------------------------------------------------------------

(defn- drain-out
  "Write and clear the chunks the translator queued."
  [write-fn st]
  (run! write-fn (:out st))
  (assoc st :out []))

(defn- ^:async pump
  "Read the stream to its end, feeding every complete SSE block to the
  translator; returns [state unparsed-tail]."
  [^js reader ^js decoder write-fn st buffer]
  (let [result (await (.read reader))]
    (if (.-done result)
      [st buffer]
      (let [[blocks tail] (stream/split-blocks (str buffer (.decode decoder (.-value result) #js {:stream true})))
            st (reduce stream/translator-step st (keep stream/block->payload blocks))]
        (await (pump reader decoder write-fn (drain-out write-fn st) tail))))))

(defn ^:async stream-responses-sse-to-chat-completion-chunks-js
  "Incrementally translate a Responses SSE ReadableStream into chat chunks.
  Resolves {terminalResponse, sawError} (null when absent)."
  [^js body ^js options]
  (let [write-fn (.-writeFn options)
        reader (.getReader body)
        [st tail] (try (await (pump reader (js/TextDecoder.) write-fn
                                    (stream/translator-init (.-fallbackModel options) (now)) ""))
                       (finally (.releaseLock reader)))
        st (if-let [payload (stream/block->payload tail)] (stream/translator-step st payload) st)
        st (drain-out write-fn (stream/translator-finish st))]
    #js {:terminalResponse (some-> (:terminal st) clj->js)
         :sawError (some-> (:error st) clj->js)}))
