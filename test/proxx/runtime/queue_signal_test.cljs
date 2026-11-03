(ns proxx.runtime.queue-signal-test
  "Proof that the behaviours of origin/staging's src/tests/queue-error-429.test.ts
  (6 cases) and src/tests/queue-signal.test.ts (9 cases) hold in the CLJS runtime.
  Cases that were already asserted elsewhere are listed in
  docs/notes/cljs-rewrite-conventions.md's port ledger; this file holds the ones
  that were not, each against the real CLJS code (no reimplementation)."
  (:require ["node:events" :as node-events]
            ["node:stream" :as node-stream]
            [cljs.test :refer [deftest is]]
            [proxx.queue.runtime :as queue-runtime]
            [proxx.runtime :as runtime]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.reply :as edge]
            [proxx.runtime.strategies :as strategies]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- within
  "`promise`, rejected if it has not settled in `ms`."
  [promise ms]
  (let [timer (atom nil)
        timeout (js/Promise. (fn [_ reject]
                               (reset! timer (js/setTimeout
                                              #(reject (js/Error. (str "operation did not finish within " ms "ms")))
                                              ms))))]
    (-> (js/Promise.race #js [promise timeout])
        (.finally (fn [] (js/clearTimeout @timer))))))

;; ---------------------------------------------------------------------------
;; queue-error-429.test.ts: sendQueueError answers 429 + retry-after, else false
;; ---------------------------------------------------------------------------

(defn- mock-reply
  "A Fastify-reply stand-in recording header/code/send, like the TS mockReply."
  []
  (let [state (atom {:headers {} :status 0 :sent nil})
        ^js reply #js {}]
    (aset reply "header" (fn [name value] (swap! state assoc-in [:headers name] value) reply))
    (aset reply "code" (fn [status] (swap! state assoc :status status) reply))
    (aset reply "send" (fn [data] (swap! state assoc :sent data) nil))
    [reply state]))

(defn- send-queue-error [code retry-after-ms extra]
  (let [[reply state] (mock-reply)
        data (js/Object.assign #js {"code" code "retry-after-ms" retry-after-ms} extra)
        handled (proxy/send-queue-error-js reply #js {"data" data})]
    [handled @state]))

(deftest send-queue-error-dropped-is-429-with-retry-after
  (let [[handled {:keys [status headers]}] (send-queue-error ":queue/dropped" 5000 #js {})]
    (is (true? handled))
    (is (= 429 status))
    (is (= "5" (get headers "retry-after")))))

(deftest send-queue-error-total-timeout-is-429-with-retry-after
  (let [[handled {:keys [status headers]}] (send-queue-error ":queue/total-timeout" 5000 #js {"attempt" 1})]
    (is (true? handled))
    (is (= 429 status))
    (is (= "5" (get headers "retry-after")))))

(deftest send-queue-error-attempt-timeout-is-429-with-retry-after
  (let [[handled {:keys [status headers]}] (send-queue-error ":queue/attempt-timeout" 5000 #js {"attempt" 0})]
    (is (true? handled))
    (is (= 429 status))
    (is (= "5" (get headers "retry-after")))))

(deftest send-queue-error-exhausted-is-429-with-retry-after
  (let [[handled {:keys [status headers]}] (send-queue-error ":queue/exhausted" 10000 #js {})]
    (is (true? handled))
    (is (= 429 status))
    (is (= "10" (get headers "retry-after")))))

(deftest send-queue-error-full-is-429-with-retry-after
  (let [[handled {:keys [status headers]}] (send-queue-error ":queue/full" 3000 #js {})]
    (is (true? handled))
    (is (= 429 status))
    (is (= "3" (get headers "retry-after")))))

(deftest send-queue-error-ignores-unknown-errors
  (let [[reply state] (mock-reply)
        handled (proxy/send-queue-error-js reply (js/Error. "something else"))]
    (is (false? handled))
    (is (= 0 (:status @state)) "nothing was written")
    (is (empty? (:headers @state)))))

(deftest ^:async send-queue-error-answers-real-queue-failures
  ;; The TS cases above hand sendQueueError a plain {data: {...}} object. What the
  ;; host actually receives is the ex-info thrown by the queue runtime, whose data
  ;; is a Clojure map (this used to answer false, i.e. a 500 instead of a 429).
  (let [policy {:queue/status :active :queue/concurrency-limit 1 :queue/max-queue-size 0
                :queue/overflow-policy :reject :queue/attempt-timeout-ms 20 :queue/max-retries 0
                :queue/retry-backoff :immediate}
        full (try (await (queue-runtime/acquire! (atom {:active 1 :queued 0 :waiting []}) policy nil)) nil
                  (catch :default e e))
        timed-out (try (await (queue-runtime/run-attempt (fn ^:async t [_c] (js/Promise. (fn [_ _] nil)))
                                                         0 policy nil))
                       nil
                       (catch :default e e))]
    (is (= :queue/full (:code (ex-data full))))
    (is (= :queue/attempt-timeout (:code (ex-data timed-out))))
    (doseq [[err retry-after] [[full "1"] [timed-out "5"]]]
      (let [[reply state] (mock-reply)]
        (is (true? (proxy/send-queue-error-js reply err)))
        (is (= 429 (:status @state)))
        (is (= retry-after (get-in @state [:headers "retry-after"])))))))

;; ---------------------------------------------------------------------------
;; queue-signal.test.ts
;; ---------------------------------------------------------------------------

;; "CLJS runtime guard validates optional classifyRateLimit": the TS guard
;; (isProxxCljsRuntime) does not exist any more. Its contract, that the runtime
;; the host calls carries every function it needs, is this.
(deftest runtime-exports-the-queue-and-rate-limit-functions
  (doseq [k ["resolveQueuePolicy" "runQueued" "classifyRateLimit"]]
    (is (fn? (aget runtime/exports k)) (str k " is an exported function"))))

(defn- listener-count [^js signal]
  (.getEventListeners node-events signal "abort"))

(defn- finished [^js stream]
  (js/Promise. (fn [resolve] (.once stream "finish" resolve))))

(deftest ^:async pipe-detaches-queue-abort-listeners-on-end-and-error
  (let [encoder (js/TextEncoder.)
        listeners (fn [^js c] (alength (listener-count (.-signal c))))
        run (fn [^js body-init]
              (let [controller (js/AbortController.)
                    ^js response (node-stream/PassThrough.)
                    done (finished response)]
                (.resume response)
                (edge/pipe-web-stream! response (js/ReadableStream. body-init) (.-signal controller))
                [controller done]))]
    ;; stream completes
    (let [[c done] (run #js {:start (fn [^js s]
                                      (.enqueue s (.encode encoder "data: complete\n\n"))
                                      (.close s))})]
      (is (= 1 (listeners c)) "registered while piping")
      (await done)
      (is (= 0 (listeners c)) "detached on end"))
    ;; stream errors
    (let [[c done] (run #js {:start (fn [^js s] (.error s (js/Error. "upstream read failed")))})]
      (is (= 1 (listeners c)) "registered while piping")
      (await done)
      (is (= 0 (listeners c)) "detached on error"))))

(defn- run-queued [context task]
  (runtime/run-queued-js manifest (clj->js context) task))

(deftest ^:async run-queued-attaches-extend-timeout-to-the-signal
  (let [captured (atom nil)]
    (await (run-queued {"request-kind" "chat"}
                       (fn ^:async task [^js controller]
                         (reset! captured (.-signal controller))
                         "ok")))
    (is (some? @captured) "signal should be captured")
    (is (fn? (aget @captured "extendTimeout")) "signal has extendTimeout")))

(deftest ^:async run-queued-extend-timeout-is-callable
  (let [captured (atom nil)]
    (await (run-queued {"request-kind" "chat"}
                       (fn ^:async task [^js controller]
                         (reset! captured (.-signal controller))
                         "ok")))
    (is (some? @captured))
    (.extendTimeout ^js @captured)))

(deftest ^:async extend-timeout-resets-the-attempt-timer-without-exceeding-the-total-deadline
  ;; TS scale is 30s attempt / 120s total, ticks 20s, 10s, 89.999s, 0.001s; here
  ;; the same shape at 1/100: 300ms attempt, 1200ms total (stream timeout longer
  ;; than the total, so only the deadline can cap the extension).
  (let [t0 (js/Date.now)
        policy {:queue/attempt-timeout-ms 300 :queue/stream-timeout-ms 100000
                :queue/max-retries 0 :queue/retry-backoff :immediate
                :queue/jitter-factor 0 :queue/retry-after-respect? false}
        deadline (+ t0 1200)
        controller-ref (atom nil)
        pending (queue-runtime/run-attempt
                 (fn ^:async task [^js controller]
                   (reset! controller-ref controller)
                   (js/Promise. (fn [_ _] nil)))
                 0 policy deadline)
        outcome (-> pending (.then (fn [_] :resolved)) (.catch (fn [e] e)))
        sleep-until (fn [ms] (js/Promise. (fn [resolve] (js/setTimeout resolve (max 0 (- (+ t0 ms) (js/Date.now)))))))]
    (await (sleep-until 200))
    (let [^js controller @controller-ref
          ^js signal (.-signal controller)]
      (is (some? controller) "attempt started")
      (is (fn? (aget signal "extendTimeout")))
      (.extendTimeout signal)
      (await (sleep-until 400))
      (is (false? (.-aborted signal)) "extension replaced the original 300ms timer")
      (await (sleep-until 1100))
      (is (false? (.-aborted signal)) "the stream may run until the total deadline")
      (let [err (await (-> (within outcome 1000) (.catch (fn [e] e))))]
        (is (true? (.-aborted signal)) "extension remained capped by the total deadline")
        (is (= :queue/attempt-timeout (:code (ex-data err))) "and the attempt rejects as timed out")
        (is (re-find #"(?i)timed out" (str (ex-message err))))
        (is (<= (- (js/Date.now) t0) 1500) "aborted at the deadline, not at the 100s stream timeout")))))

(deftest mimo-provider-gets-its-own-queue-policy
  (let [^js result (runtime/resolve-queue-policy-js manifest #js {"provider-id" "xiaomi" "request-kind" "chat"})]
    (is (= "ok" (.-status result)) "should resolve queue policy")
    (is (= 60000 (aget (.-policy result) "attempt-timeout-ms")) "xiaomi provider gets the 60s attempt timeout")))

;; ---- stream mocks ----------------------------------------------------------

(defn- mock-raw []
  (let [writes (atom [])
        ended (atom false)
        ^js raw #js {}]
    (js/Object.defineProperty raw "writableEnded" #js {:get (fn [] @ended)})
    (aset raw "headers" #js {})
    (aset raw "setHeader" (fn [name value] (aset (.-headers raw) (.toLowerCase name) value)))
    (aset raw "flushHeaders" (fn [] (when-let [f (.-onFlush raw)] (f))))
    (aset raw "write" (fn [data]
                        (when @ended (throw (js/Error. "ERR_STREAM_WRITE_AFTER_END")))
                        (swap! writes conj data) true))
    (aset raw "end" (fn [] (reset! ended true) raw))
    [raw writes ended]))

(defn- mock-stream-reply [on-flush]
  (let [[^js raw writes ended] (mock-raw)
        ^js reply #js {}]
    (aset raw "onFlush" on-flush)
    (aset reply "raw" raw)
    (aset reply "header" (fn [_ _] reply))
    (aset reply "removeHeader" (fn [_] reply))
    (aset reply "getHeaders" (fn [] #js {}))
    (aset reply "code" (fn [status] (aset raw "statusCode" status) reply))
    (aset reply "hijack" (fn [] reply))
    [reply writes ended]))

(defn- attempt-context [^js queue-signal overrides]
  (js/Object.assign
   #js {"providerId" "openai" "routeProviderId" "openai" "baseUrl" "https://example.invalid"
        "account" #js {"providerId" "openai" "accountId" "account-1" "token" "test-token" "authType" "api_key"}
        "hasMoreCandidates" false "attempt" 1 "queueSignal" queue-signal
        "config" #js {"streamBootstrapTimeoutMs" 1000 "requestTimeoutMs" 1000
                      "cljsPolicyManifestPath" manifest
                      "chatCompletionsPath" "/v1/chat/completions" "messagesPath" "/v1/messages"
                      "messagesInterleavedThinkingBeta" "beta-1" "ollamaModelPrefixes" #js []}
        "clientHeaders" #js {} "requestBody" #js {}
        "requestedModelInput" "test-model" "routingModelInput" "test-model" "routedModel" "test-model"
        "explicitOllama" false "openAiPrefixed" true "factoryPrefixed" false "localOllama" false
        "clientWantsStream" true "needsReasoningTrace" false "upstreamAttemptTimeoutMs" 1000
        "responsesPassthrough" true "imagesPassthrough" false}
   overrides))

(deftest ^:async openai-passthrough-skips-its-first-chunk-when-the-queue-signal-already-ended-the-response
  (let [controller (js/AbortController.)
        _ (.abort controller)
        [reply writes ended] (mock-stream-reply nil)
        upstream (js/Response. (js/ReadableStream.
                                #js {:start (fn [^js s]
                                              (.enqueue s (.encode (js/TextEncoder.) "data: first\n\n"))
                                              (.close s))})
                               #js {:status 200 :headers #js {"content-type" "text/event-stream"}})
        ^js strategy (strategies/strategy-for-id-js "openai-responses-passthrough")
        ^js outcome (await (.handleProviderAttempt strategy reply upstream (attempt-context (.-signal controller) #js {})))]
    (is (= "handled" (.-kind outcome)))
    (is (true? @ended))
    (is (= 1 (count @writes)) "only the abort frame; the first upstream chunk was skipped")
    (is (string? (first @writes)))
    (is (re-find #"Provider stream aborted by request queue timeout" (first @writes)))))

(deftest ^:async gemini-pending-stream-read-is-cancelled-by-the-queue-signal-and-cleans-up-promptly
  (let [controller (js/AbortController.)
        captured (atom nil)
        flushed (js/Promise. (fn [resolve]
                               (let [[reply writes ended] (mock-stream-reply resolve)]
                                 (reset! captured {:reply reply :writes writes :ended ended}))))
        {:keys [reply writes ended]} @captured
        fake-client
        (fn [_options]
          #js {:models
               #js {:generateContentStream
                    (fn [^js request]
                      (let [^js signal (.. request -config -abortSignal)]
                        (reset! captured (assoc @captured :signal signal))
                        (is (some? signal) "Gemini SDK request should receive the queue abort signal")
                        (js/Promise.resolve
                         (let [^js it #js {}]
                           (aset it js/Symbol.asyncIterator (fn [] it))
                           (aset it "next"
                                 (fn []
                                   (js/Promise.
                                    (fn [_ reject]
                                      (let [on-abort #(reject (or (.-reason signal) (js/DOMException. "Aborted" "AbortError")))]
                                        (if (.-aborted signal)
                                          (on-abort)
                                          (.addEventListener signal "abort" on-abort #js {:once true})))))))
                           it))))
                    :generateContent (fn [] (js/Promise.reject (js/Error. "non-streaming Gemini call was not expected")))}})
        previous (strategies/set-genai-factory! fake-client)
        ^js strategy (strategies/strategy-for-id-js "gemini-chat")
        context (attempt-context (.-signal controller)
                                 #js {"providerId" "gemini" "routeProviderId" "gemini"
                                      "baseUrl" "https://generativelanguage.googleapis.com"
                                      "account" #js {"providerId" "gemini" "accountId" "gemini-account-1"
                                                     "token" "test-gemini-key" "authType" "api_key"}
                                      "requestedModelInput" "gemini-2.5-pro" "routingModelInput" "gemini-2.5-pro"
                                      "routedModel" "gemini-2.5-pro" "openAiPrefixed" false
                                      "responsesPassthrough" false})
        outcome-p (.executeDirect strategy reply context
                                  #js {"model" "gemini-2.5-pro" "messages" #js [#js {"role" "user" "content" "hello"}]})]
    (try
      (await (within flushed 250))
      (is (identical? (.-signal controller) (:signal @captured)))
      (.abort controller)
      (let [^js outcome (await (within outcome-p 250))]
        (is (= "handled" (.-kind outcome)))
        (is (true? @ended))
        (is (= 1 (count @writes)))
        (is (re-find #"Provider stream aborted by request queue timeout" (str (first @writes)))))
      (finally (strategies/set-genai-factory! previous)))))
