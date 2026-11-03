(ns proxx.runtime.reply-test
  "Queue lifecycle of a streamed reply: a queue abort mid-stream is an SSE error
  (not a silent EOF), every terminal path unregisters its listeners, and a stalled
  body can tear down its transport."
  (:require ["node:stream" :as node-stream]
            [cljs.test :refer [deftest is]]
            [proxx.http.reply :as frames]
            [proxx.runtime.http :as http-edge]
            [proxx.runtime.reply :as edge]))

(defn- sink
  "A Node Writable that records what it is given."
  []
  (let [chunks (atom [])
        ^js w (node-stream/Writable. #js {:write (fn [chunk _enc cb] (swap! chunks conj (str chunk)) (cb))})]
    [w chunks]))

(defn- tick [] (js/Promise. (fn [resolve] (js/setTimeout resolve 10))))

(defn- queue-signal
  "An AbortSignal-like with `extendTimeout`, as the request queue provides."
  []
  (let [controller (js/AbortController.)
        extended (atom 0)
        ^js signal (.-signal controller)]
    (aset signal "extendTimeout" (fn [] (swap! extended inc)))
    {:controller controller :signal signal :extended extended}))

(deftest ^:async queue-abort-mid-stream-writes-an-sse-error-and-ends
  (let [[^js raw chunks] (sink)
        {:keys [^js controller signal]} (queue-signal)
        cleanup (edge/register-queue-abort! signal raw)]
    (.abort controller)
    (await (tick))
    (is (= [(frames/queue-abort-chunk)] @chunks))
    (is (.-writableEnded raw))
    (cleanup)))

(deftest ^:async an-already-aborted-signal-answers-immediately
  (let [[^js raw chunks] (sink)
        {:keys [^js controller signal]} (queue-signal)]
    (.abort controller)
    (edge/register-queue-abort! signal raw)
    (await (tick))
    (is (= 1 (count @chunks)))
    (is (.-writableEnded raw))))

(deftest ^:async cleanup-unregisters-the-abort-listener
  (let [[^js raw chunks] (sink)
        {:keys [^js controller signal]} (queue-signal)
        cleanup (edge/register-queue-abort! signal raw)]
    (cleanup)
    (.abort controller)
    (await (tick))
    (is (empty? @chunks) "a finished stream is not written to by a later abort")
    (is (not (.-writableEnded raw)))))

(deftest ^:async lifecycle-extends-the-timeout-and-always-unregisters
  (let [[^js raw chunks] (sink)
        {:keys [^js controller signal extended]} (queue-signal)]
    (try
      (await (edge/with-queue-lifecycle signal raw (fn [] (throw (js/Error. "boom")))))
      (catch :default _ nil))
    (is (= 1 @extended) "streaming started: queue timeout extended")
    (.abort controller)
    (await (tick))
    (is (empty? @chunks) "listener removed even though the stream threw")
    (is (nil? (edge/extend-queue-timeout! nil)) "no signal: nothing to extend")))

(defn- web-stream-of [chunks]
  (let [^js readable (.from (aget node-stream "Readable") (clj->js chunks))]
    (.toWeb (aget node-stream "Readable") readable)))

(deftest ^:async pipe-relays-the-body-and-ends-with-the-stream
  (let [[^js raw chunks] (sink)]
    (edge/pipe-web-stream! raw (web-stream-of ["a" "b"]) nil)
    (await (js/Promise. (fn [resolve] (.once raw "finish" resolve))))
    (is (= ["a" "b"] @chunks))))

(deftest ^:async pipe-answers-a-queue-abort-and-tears-the-upstream-down
  (let [[^js raw chunks] (sink)
        {:keys [^js controller signal]} (queue-signal)
        cancelled (atom false)
        body (js/ReadableStream. #js {:pull (fn [] (js/Promise. (fn [_] nil)))
                                      :cancel (fn [] (reset! cancelled true))})]
    (edge/pipe-web-stream! raw body signal)
    (.abort controller)
    (await (tick))
    (await (tick))
    (is (= [(frames/queue-abort-chunk)] @chunks))
    (is (true? @cancelled) "the upstream stream is destroyed once the response is done")))

(deftest ^:async abort-fetch-response-aborts-the-transport-behind-a-response
  (let [server (.createServer (js/require "node:http")
                              (fn [_req ^js res]
                                (.writeHead res 200 #js {"content-type" "text/event-stream"})
                                (.write res "data: 1\n\n")))]
    (await (js/Promise. (fn [resolve] (.listen server 0 "127.0.0.1" resolve))))
    (try
      (let [port (.-port (.address server))
            ^js response (await (http-edge/fetch-with-response-timeout-js
                                 (str "http://127.0.0.1:" port "/") #js {} 5000))
            reader (.getReader (.-body response))
            _ (await (.read reader))
            pending (.read reader)]
        (http-edge/abort-fetch-response! response (js/DOMException. "stalled" "TimeoutError"))
        (is (= "TimeoutError" (try (await pending) nil
                                   (catch :default e (.-name e))))
            "a stalled body read is rejected by aborting the transport"))
      (finally (.closeAllConnections server) (.close server)))))
