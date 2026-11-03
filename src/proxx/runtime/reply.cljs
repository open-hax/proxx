(ns proxx.runtime.reply
  "Interpreter for the reply frames of proxx.http.reply, plus the byte plumbing
  streamed replies need (pumping a web stream into the hijacked response).

  Handlers build frames (pure) and call `play!`; the only places a reply or a raw
  response is touched for a provider answer are here. `reply` is the Fastify
  reply, `raw` the Node response after a hijack."
  (:require ["node:stream" :as node-stream]
            [proxx.http.reply :as frames]))

(defn hijack!
  "Take over the response: set the status, copy every header set so far onto
  the raw response and flush the head. Returns the raw response."
  [^js reply status]
  (.hijack reply)
  (let [^js raw (.-raw reply)]
    (aset raw "statusCode" status)
    (doseq [^js entry (array-seq (js/Object.entries (.getHeaders reply)))]
      (let [value (aget entry 1)]
        (when-not (undefined? value)
          (.setHeader raw (aget entry 0) value))))
    (.flushHeaders raw)
    raw))

(defn- send-value
  "Frames carry JS values untouched; a Clojure map/vector built by a pure
  function becomes JSON-ready JS here."
  [body]
  (if (or (map? body) (vector? body)) (clj->js body) body))

(defn play!
  "Apply `frames` to `reply` in order. Returns the raw response when the
  sequence hijacked it (so the caller can stream into it), else nil."
  [^js reply frames]
  (reduce
   (fn [raw frame]
     (let [kind (nth frame 0)]
       (case kind
         :header (do (.header reply (nth frame 1) (nth frame 2)) raw)
         :remove-header (do (.removeHeader reply (nth frame 1)) raw)
         :code (do (.code reply (nth frame 1)) raw)
         :send (do (.send reply (send-value (nth frame 1))) raw)
         :hijack (hijack! reply (nth frame 1))
         :write (do (.write ^js raw (nth frame 1)) raw)
         :end (do (when-not (.-writableEnded ^js raw) (.end ^js raw)) raw))))
   nil
   frames))

(defn end-quietly!
  "End the raw response unless it already ended."
  [^js raw]
  (when-not (.-writableEnded raw) (.end raw)))

(defn write-flushing!
  "Write a chunk, then flush a compressing/buffering layer if one is installed."
  [^js raw data]
  (.write raw data)
  (when-let [flush (aget raw "flush")]
    (.call flush raw)))

;; ---------------------------------------------------------------------------
;; Request-queue lifecycle of a streamed reply
;; ---------------------------------------------------------------------------

(defn extend-queue-timeout!
  "Streaming has started: ask the request queue (whose AbortSignal carries
  `extendTimeout`) to swap the attempt timeout for the longer stream timeout."
  [^js signal]
  (when (and signal (fn? (aget signal "extendTimeout")))
    (.extendTimeout signal))
  nil)

(defn register-queue-abort!
  "Answer a queue abort mid-stream with an SSE error frame and end the response.
  Returns the cleanup fn, which every terminal path of the stream must call."
  [^js signal ^js raw]
  (if-not signal
    (fn [] nil)
    (let [on-abort (fn []
                     (when-not (.-writableEnded raw)
                       (.write raw (frames/queue-abort-chunk))
                       (.end raw)))]
      (.addEventListener signal "abort" on-abort #js {"once" true})
      (when (.-aborted signal) (on-abort))
      (fn [] (.removeEventListener signal "abort" on-abort)))))

(defn ^:async with-queue-lifecycle
  "Run `(body)` (a promise-returning fn) as the streaming phase of a reply:
  extend the queue timeout, honour a queue abort, and always unregister."
  [^js signal ^js raw body]
  (extend-queue-timeout! signal)
  (let [cleanup (register-queue-abort! signal raw)]
    (try (await (body))
         (finally (cleanup)))))

(defn- release-quietly [^js reader]
  (try (.releaseLock reader) (catch :default _ nil)))

(defn ^:async pump-reader!
  "Write what `read-next` (reader -> Promise<{done, value}>) yields into `raw`
  until the stream ends, the response ends, or a read throws. `before` (if any)
  runs first inside the same guard. The reader is released and the response
  ended on every exit path; a read error propagates after that."
  [^js raw ^js reader read-next before]
  (try
    (when before (before raw))
    (loop []
      (when-not (.-writableEnded raw)
        (let [^js result (await (read-next reader))]
          (when-not (.-done result)
            (let [value (.-value result)]
              (when (and value (pos? (.-byteLength value)))
                (.write raw value)))
            (recur)))))
    (finally
      (release-quietly reader)
      (end-quietly! raw))))

(defn cancel-quietly
  "Cancel a reader, ignoring failure."
  [^js reader]
  (-> (js/Promise.resolve (.cancel reader)) (.catch (fn [_] nil))))

(defn read-with-timeout
  "`reader.read()` racing a timeout that rejects with `message`."
  [^js reader timeout-ms message]
  (let [timer (atom nil)
        timeout (js/Promise. (fn [_ reject] (reset! timer (js/setTimeout #(reject (js/Error. message)) timeout-ms))))]
    (-> (js/Promise.race #js [(.read reader) timeout])
        (.finally (fn [] (when @timer (js/clearTimeout @timer)))))))

(defn readable-from-web
  "A Node Readable over a web ReadableStream."
  [body]
  (let [^js readable-class (aget node-stream "Readable")]
    (.fromWeb readable-class body)))

(defn pipe-web-stream!
  "Pipe a web ReadableStream into the hijacked response. The response ends with
  the stream (immediately if it errors), the stream is destroyed when the client
  goes away, and a queue abort (`signal`) answers with an SSE error. Every
  terminal path unregisters every listener."
  ([^js raw body] (pipe-web-stream! raw body nil))
  ([^js raw body ^js signal]
   (let [^js readable (readable-from-web body)
         cleanup-abort (register-queue-abort! signal raw)
         cleaned? (atom false)]
     (letfn [(cleanup []
               (when-not @cleaned?
                 (reset! cleaned? true)
                 (cleanup-abort)
                 (.off readable "error" on-stream-error)
                 (.off readable "close" cleanup)
                 (.off raw "finish" on-response-done)
                 (.off raw "close" on-response-done)))
             (on-stream-error []
               (end-quietly! raw)
               (cleanup))
             (on-response-done []
               (when-not (.-destroyed readable) (.destroy readable))
               (cleanup))]
       (.once readable "error" on-stream-error)
       (.once readable "close" cleanup)
       (.once raw "finish" on-response-done)
       (.once raw "close" on-response-done)
       (.pipe readable raw))
     nil)))
