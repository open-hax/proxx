(ns proxx.runtime.provider-reply
  "How each provider strategy answers an upstream response
  (src/lib/provider-strategy/{base,strategies/*}.ts): the I/O half. Which reply
  a response earns is decided by proxx.strategy.reply, the bytes the client sees
  are the frames of proxx.http.reply, and proxx.runtime.reply interprets them;
  this namespace reads what the verdicts need (bodies, headers), asks, and does
  what they name.

  `reply` is the Fastify reply, `response` the upstream fetch Response, `ctx` a
  ProviderAttemptContext / LocalAttemptContext. Handlers resolve to an attempt
  outcome: {kind:\"handled\"} or a `continue` outcome the router reads."
  (:require [clojure.string :as str]
            [proxx.http.reply :as frames]
            [proxx.runtime :as runtime]
            [proxx.runtime.ollama :as ollama]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.reply :as edge]
            [proxx.runtime.responses :as responses]
            [proxx.runtime.strategy :as strategy]
            [proxx.strategy.reply :as plan]))

;; ---------------------------------------------------------------------------
;; Facts read off the host objects
;; ---------------------------------------------------------------------------

(defn- handled [] #js {"kind" "handled"})
(defn- request-error [] #js {"kind" "continue" "requestError" true})

(defn- ct-of [^js response] (or (.get (.-headers response) "content-type") ""))

(defn- header-pairs [^js response]
  (mapv (fn [^js entry] [(aget entry 0) (aget entry 1)])
        (array-seq (js/Array.from (.entries (.-headers response))))))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- js-record? [v] (and (some? v) (= "object" (js* "typeof ~{}" v))))

(defn- identity-of [^js ctx]
  (let [^js auth (.-requestAuth ctx)
        kind (when auth (.-kind auth))]
    (cond-> {:provider-id (.-providerId ctx) :auth-kind kind}
      (= "legacy_admin" kind)
      (assoc :account-id (.-accountId ^js (.-account ctx))
             :auth-type (.-authType ^js (.-account ctx))))))

(defn- json-or-bad
  "The parsed JSON body of `response`, or ::bad when it does not parse."
  [^js response]
  (-> (.json response) (.catch (fn [_] ::bad))))

(defn- has-body? [^js response] (some? (.-body response)))

(defn- send-openai-error!
  "reply.code(status).send(openAiError(...)) with the error-code header (src/lib/provider-utils.ts)."
  [^js reply status message type code]
  (when code (.header reply "x-open-hax-error-code" code))
  (.send (.code reply status) (proxy/openai-error-js message type code)))

(defn- sse-from [completion] (responses/chat-completion-to-sse-js completion))

(defn- convert [kind json routed-model]
  (if (= :messages kind)
    (runtime/messages-to-chat-completion-js json routed-model)
    (responses/responses-to-chat-completion-js json routed-model)))

;; ---------------------------------------------------------------------------
;; Standard replies
;; ---------------------------------------------------------------------------

(defn- ^:async failed-outcome
  "The `continue` outcome for a non-OK response: probe for a missing model or an
  unsupported one, read only the body the status needs, ask the verdict."
  [^js response ^js ctx]
  (let [routed (.-routedModel ctx)
        missing? (await (runtime/response-indicates-missing-model-js response routed))
        not-supported? (and (not missing?)
                            (await (runtime/response-indicates-model-not-supported-js response routed)))
        needed (when-not (or missing? not-supported?) (strategy/failed-body-needed-js (.-status response)))
        auth-message (when (= "auth-summary" needed)
                       (let [^js summary (await (runtime/summarize-upstream-error-js response))]
                         (.-upstreamErrorMessage summary)))
        error-body (if (= "text" needed)
                     (try (await (.text response)) (catch :default _ js/undefined))
                     (do (try (await (.arrayBuffer response)) (catch :default _ nil))
                         js/undefined))]
    (strategy/failed-attempt-outcome-js
     #js {"status" (.-status response)
          "missingModel" missing?
          "modelNotSupported" not-supported?
          "authMessage" auth-message
          "errorBody" error-body})))

(defn- ^:async relay-successful
  "An OK response relayed as it is (no translation)."
  [^js reply ^js response ^js ctx]
  (let [mode (strategy/success-mode-js ctx)]
    (cond
      (= "reasoning-json" mode)
      (let [json (await (json-or-bad response))]
        (if (= ::bad json)
          (request-error)
          (let [has-reasoning (and (js-record? json) (runtime/chat-completion-has-reasoning-content-js json))]
            (if (strategy/missing-reasoning-skips-js ctx has-reasoning)
              (request-error)
              (do (edge/play! reply (concat (frames/identity-frames (identity-of ctx))
                                            [[:code (.-status response)]]
                                            (frames/copy-upstream-frames (header-pairs response))
                                            [[:header "content-type" "application/json"] [:send json]]))
                  (handled))))))

      (= "stream" mode)
      (let [^js bootstrap (await (strategy/bootstrap-event-stream-js
                                  response
                                  #js {"timeoutMs" (.-upstreamAttemptTimeoutMs ctx)
                                       "needsReasoningTrace" (.-needsReasoningTrace ctx)
                                       "hasMoreCandidates" (.-hasMoreCandidates ctx)}))]
        (if (= "continue" (.-kind bootstrap))
          bootstrap
          (let [raw (edge/play! reply (frames/relayed-stream-head
                                       {:status (.-status response)
                                        :lead (frames/identity-frames (identity-of ctx))
                                        :upstream-headers (header-pairs response)}))]
            (await (edge/pump-reader! raw (.-reader bootstrap) (fn [^js reader] (.read reader))
                                      (fn [^js raw]
                                        (doseq [chunk (array-seq (.-bufferedChunks bootstrap))]
                                          (.write raw chunk)))))
            (handled))))

      :else
      (do (edge/play! reply (concat (frames/identity-frames (identity-of ctx))
                                    [[:code (.-status response)]]
                                    (frames/copy-upstream-frames (header-pairs response))))
          (let [ct (ct-of response)]
            (cond
              (not (has-body? response)) (do (.send reply (await (.text response))) (handled))
              (plan/event-stream? ct)
              (do (.removeHeader reply "content-length")
                  (.send reply (edge/readable-from-web (.-body response)))
                  (handled))
              :else (do (.send reply (js/Buffer.from (await (.arrayBuffer response)))) (handled))))))))

(defn ^:async handle-standard-provider-attempt-js
  "The default answer: relay a good response, classify a bad one."
  [^js reply ^js response ^js ctx]
  (if (.-ok response)
    (let [ct (ct-of response)]
      (if (strategy/is-event-stream-content-type-js ct)
        (await (relay-successful reply response ctx))
        (let [body-text (try (await (.text (.clone response))) (catch :default _ ::bad))]
          (if (= ::bad body-text)
            (request-error)
            (let [verdict (strategy/ok-body-verdict-js
                           body-text
                           #js {"clientWantsStream" (.-clientWantsStream ctx)
                                "streamLike" (and (.-clientWantsStream ctx)
                                                  (runtime/stream-payload-has-substantive-chunks-js
                                                   (runtime/strip-sse-comment-lines-js body-text)))
                                "imagesPassthrough" (true? (.-imagesPassthrough ctx))
                                "providerId" (.-providerId ctx)})]
              (cond (= "stream-like" verdict) (await (relay-successful reply response ctx))
                    (not= "ok" verdict) (request-error)
                    :else (await (relay-successful reply response ctx))))))))
    (await (failed-outcome response ctx))))

(defn ^:async handle-standard-local-attempt-js
  "The default local answer: copy status and headers, relay a stream, send the rest."
  [^js reply ^js response ^js ctx]
  (edge/play! reply (into [[:code (.-status response)]] (frames/copy-upstream-frames (header-pairs response))))
  (case (plan/local-standard-plan {:ct (ct-of response) :has-body? (has-body? response)})
    :text (.send reply (await (.text response)))
    :stream (let [^js readable (edge/readable-from-web (.-body response))
                  raw (edge/play! reply [[:remove-header "content-length"] [:hijack (.-status response)]])]
              (.pipe readable raw)
              (.on readable "error" (fn [] (edge/end-quietly! raw))))
    :bytes (.send reply (js/Buffer.from (await (.arrayBuffer response)))))
  js/undefined)

;; ---------------------------------------------------------------------------
;; Translated replies (JSON -> chat completion)
;; ---------------------------------------------------------------------------

(defn- ^:async answer-chat-completion
  "Reply with `completion`: an SSE document for a streaming client, JSON otherwise."
  [^js reply ^js ctx status completion]
  (if (.-clientWantsStream ctx)
    (edge/play! reply (frames/sse-text-frames (sse-from completion)))
    (edge/play! reply (frames/json-frames status completion)))
  (handled))

(defn- ^:async handle-transformed [^js reply ^js response ^js ctx kind]
  (if-not (.-ok response)
    (await (handle-standard-provider-attempt-js reply response ctx))
    (let [json (await (json-or-bad response))]
      (if (= ::bad json)
        (request-error)
        (let [completion (convert kind json (.-routedModel ctx))]
          (if (strategy/missing-reasoning-skips-js ctx (runtime/chat-completion-has-reasoning-content-js completion))
            (request-error)
            (do (edge/play! reply (frames/identity-frames (identity-of ctx)))
                (await (answer-chat-completion reply ctx (.-status response) completion)))))))))

(defn- ^:async handle-responses [^js reply ^js response ^js ctx]
  (if-not (.-ok response)
    (await (handle-standard-provider-attempt-js reply response ctx))
    (let [json (await (json-or-bad response))]
      (cond
        (= ::bad json) (request-error)
        (not (js-record? json)) (request-error)
        :else
        (let [completion (convert :responses json (.-routedModel ctx))]
          (if (and (.-needsReasoningTrace ctx)
                   (not (runtime/chat-completion-has-reasoning-content-js completion))
                   (.-hasMoreCandidates ctx))
            (request-error)
            (let [provider (frames/provider-frames (.-providerId ctx))]
              (edge/play! reply provider)
              (case (plan/responses-plan {:wants-stream? (.-clientWantsStream ctx)
                                          :output-has-reasoning? (and (.-clientWantsStream ctx)
                                                                      (responses/responses-output-has-reasoning-js json))})
                :reasoning-stream
                (let [raw (edge/play! reply (frames/translated-stream-head {}))]
                  (await (responses/write-interleaved-responses-sse-js json (.-routedModel ctx) (fn [data] (.write ^js raw data))))
                  (.end ^js raw)
                  (handled))
                :sse (do (edge/play! reply (frames/sse-text-frames (sse-from completion))) (handled))
                :json (do (edge/play! reply (frames/json-frames (.-status response) completion)) (handled))))))))))

;; ---------------------------------------------------------------------------
;; Responses event streams answered as chat completions
;; ---------------------------------------------------------------------------

(defn- ^:async buffered-event-stream-as-chat
  "Read the whole Responses event stream; an error event is a 400, anything
  that does not convert tries the next candidate."
  [^js reply ^js response ^js ctx]
  (let [text (await (.text response))
        error-payload (responses/responses-event-stream-to-error-payload-js text)]
    (if error-payload
      (do (edge/play! reply (frames/error-frames (.-providerId ctx) error-payload)) (handled))
      (let [completion (try (responses/responses-event-stream-to-chat-completion-js text (.-routedModel ctx))
                            (catch :default _ ::bad))]
        (if (= ::bad completion)
          (request-error)
          (do (edge/play! reply (concat (frames/provider-frames (.-providerId ctx))
                                        (frames/json-frames 200 completion)))
              (handled)))))))

(defn- ^:async stream-event-stream-as-chat
  "Translate the Responses SSE into chat-completion chunks as they arrive.
  `on-failure` is told about an upstream error event / read error (the
  strategies differ in how loudly they report it)."
  [^js reply ^js response ^js ctx on-error-event on-read-error]
  (let [raw (edge/play! reply (frames/translated-stream-head {:before (frames/provider-frames (.-providerId ctx))}))
        done (try
               (let [^js result (await (responses/stream-responses-sse-to-chat-completion-chunks-js
                                        (.-body response)
                                        #js {"fallbackModel" (.-routedModel ctx)
                                             "writeFn" (fn [data] (.write ^js raw data))}))]
                 (when (.-sawError result)
                   (on-error-event ctx raw)
                   ::done))
               (catch :default err
                 (on-read-error ctx response err)
                 nil))]
    (when-not (= ::done done)
      (edge/end-quietly! raw))
    (handled)))

(defn- ^:async handle-event-stream-as-chat [^js reply ^js response ^js ctx]
  (if (= :stream (plan/event-stream-as-chat-plan {:wants-stream? (.-clientWantsStream ctx) :has-body? (has-body? response)}))
    (await (stream-event-stream-as-chat
            reply response ctx
            (fn [^js ctx raw]
              (js/console.error "[responses-event-stream] upstream SSE error"
                                #js {"providerId" (.-providerId ctx) "routedModel" (.-routedModel ctx)})
              (edge/end-quietly! raw))
            (fn [^js ctx ^js response err]
              (js/console.error "[responses-event-stream] stream read error"
                                #js {"providerId" (.-providerId ctx) "message" (error-message err)})
              (.catch (js/Promise.resolve (.cancel (.-body response))) (fn [_] nil)))))
    (await (buffered-event-stream-as-chat reply response ctx))))

(defn- ^:async handle-openai-codex [^js reply ^js response ^js ctx]
  (case (plan/codex-plan {:ok? (.-ok response) :ct (ct-of response)})
    :transformed (await (handle-transformed reply response ctx :responses))
    :event-stream (await (handle-event-stream-as-chat reply response ctx))))

(defn- ^:async handle-factory-responses [^js reply ^js response ^js ctx]
  (case (plan/factory-responses-plan {:ok? (.-ok response) :ct (ct-of response)
                                      :wants-stream? (.-clientWantsStream ctx) :has-body? (has-body? response)})
    :transformed (await (handle-transformed reply response ctx :responses))
    :json (let [json (await (json-or-bad response))]
            (if (= ::bad json)
              (request-error)
              (let [completion (convert :responses json (.-routedModel ctx))]
                (edge/play! reply (frames/provider-frames (.-providerId ctx)))
                (if (.-clientWantsStream ctx)
                  (edge/play! reply (frames/sse-text-frames (sse-from completion)))
                  (edge/play! reply (frames/json-frames 200 completion)))
                (handled))))
    :stream (await (stream-event-stream-as-chat
                    reply response ctx
                    (fn [_ctx raw] (edge/end-quietly! raw))
                    (fn [_ctx _response _err] nil)))
    :buffer (await (buffered-event-stream-as-chat reply response ctx))))

;; ---------------------------------------------------------------------------
;; Passthrough replies
;; ---------------------------------------------------------------------------

(defn- ^:async handle-passthrough
  "responses-passthrough / factory-responses-passthrough: the body goes through untouched."
  [^js reply ^js response ^js ctx]
  (if-not (.-ok response)
    (await (handle-standard-provider-attempt-js reply response ctx))
    (let [prefix {:status (.-status response)
                  :lead (frames/provider-frames (.-providerId ctx))
                  :upstream-headers (header-pairs response)}
          verdict (plan/passthrough-plan {:ct (ct-of response) :has-body? (has-body? response)})]
      (case verdict
        :stream (let [raw (edge/play! reply (frames/relayed-stream-head prefix))]
                  (edge/pipe-web-stream! raw (.-body response))
                  (handled))
        :no-body (do (edge/play! reply (frames/relay-prefix prefix)) (request-error))
        (do (edge/play! reply (frames/relay-prefix prefix))
            (if (= :text verdict)
              (.send reply (await (.text response)))
              (.send reply (js/Buffer.from (await (.arrayBuffer response)))))
            (handled))))))

(defn- ^:async relay-responses-stream
  "OpenAI Responses SSE relayed to the client with a bootstrap and an idle timeout."
  [^js reply ^js response ^js ctx]
  (if-not (has-body? response)
    (request-error)
    (let [^js reader (.getReader (.-body response))
          first-chunk (try (await (edge/read-with-timeout reader (.-streamBootstrapTimeoutMs ^js (.-config ctx))
                                                          "responses stream timeout"))
                           (catch :default _ (await (edge/cancel-quietly reader)) ::bad))]
      (cond
        (= ::bad first-chunk) (request-error)
        (.-done ^js first-chunk) (do (await (edge/cancel-quietly reader)) (request-error))
        :else
        (let [raw (edge/play! reply (frames/relayed-stream-head
                                     {:status (.-status response)
                                      :lead (frames/provider-frames (.-providerId ctx))
                                      :upstream-headers (header-pairs response)}))
              timeout-ms (.-requestTimeoutMs ^js (.-config ctx))]
          (try
            (let [value (.-value ^js first-chunk)]
              (when (and value (pos? (.-byteLength value))) (.write ^js raw value)))
            (loop []
              (when-not (.-writableEnded ^js raw)
                (let [next-chunk (try (await (edge/read-with-timeout reader timeout-ms "responses stream timeout"))
                                      (catch :default _ (await (edge/cancel-quietly reader)) ::bad))]
                  (when-not (= ::bad next-chunk)
                    (when-not (.-done ^js next-chunk)
                      (let [value (.-value ^js next-chunk)]
                        (when (and value (pos? (.-byteLength value))) (.write ^js raw value)))
                      (recur))))))
            (finally
              (try (.releaseLock reader) (catch :default _ nil))
              (edge/end-quietly! raw)))
          (handled))))))

(defn- ^:async answer-error-event-stream
  "A 4xx/5xx event stream: an error event in it is the answer (400)."
  [^js reply ^js response ^js ctx]
  (let [text (await (.text response))
        error-payload (responses/responses-event-stream-to-error-payload-js text)]
    (if error-payload
      (do (edge/play! reply (frames/error-frames (.-providerId ctx) error-payload)) (handled))
      (request-error))))

(defn- ^:async handle-openai-passthrough [^js reply ^js response ^js ctx]
  (case (plan/openai-passthrough-plan {:ok? (.-ok response) :ct (ct-of response)
                                       :wants-stream? (.-clientWantsStream ctx)})
    :standard (await (handle-standard-provider-attempt-js reply response ctx))
    :stream-error (await (answer-error-event-stream reply response ctx))
    :relay (await (relay-responses-stream reply response ctx))
    :collect (let [text (await (.text response))
                   error-payload (responses/responses-event-stream-to-error-payload-js text)]
               (if error-payload
                 (do (edge/play! reply (frames/error-frames (.-providerId ctx) error-payload)) (handled))
                 (let [terminal (responses/extract-terminal-response-from-event-stream-js text)]
                   (if-not terminal
                     (request-error)
                     (do (edge/play! reply (concat (frames/provider-frames (.-providerId ctx))
                                                   (frames/json-frames 200 terminal)))
                         (handled))))))
    :copy (do (edge/play! reply (frames/relay-prefix {:status (.-status response)
                                                      :lead (frames/provider-frames (.-providerId ctx))
                                                      :upstream-headers (header-pairs response)}))
              (if (= :text (plan/copy-plan {:has-body? (has-body? response)}))
                (.send reply (await (.text response)))
                (.send reply (js/Buffer.from (await (.arrayBuffer response)))))
              (handled))))

(defn- ^:async handle-responses-via-chat [^js reply ^js response ^js ctx]
  (if-not (.-ok response)
    (await (handle-standard-provider-attempt-js reply response ctx))
    (do
      (edge/play! reply (frames/provider-frames (.-providerId ctx)))
      (let [routed (.-routedModel ctx)]
        (case (plan/responses-via-chat-plan {:wants-stream? (.-clientWantsStream ctx) :ct (ct-of response)})
          :events->response
          (try (let [compat (responses/chat-completion-event-stream-to-responses-response-js (await (.text response)) routed)]
                 (edge/play! reply (frames/json-frames 200 compat))
                 (handled))
               (catch :default _ (request-error)))

          :completion->events
          (let [body (await (json-or-bad response))]
            (if (or (= ::bad body) (not (strategy/is-chat-completion-response-js body)))
              (request-error)
              (do (edge/play! reply (frames/sse-head-frames))
                  (.send reply (responses/chat-completion-event-stream-to-responses-event-stream-js (sse-from body) routed))
                  (handled))))

          :stream-skipped (request-error)

          :completion->response
          (let [body (await (json-or-bad response))]
            (if (or (= ::bad body) (not (strategy/is-chat-completion-response-js body)))
              (request-error)
              (do (edge/play! reply (frames/json-frames 200 (responses/chat-completion-to-responses-response-js body)))
                  (handled)))))))))

;; ---------------------------------------------------------------------------
;; Ollama
;; ---------------------------------------------------------------------------

(defn- ^:async stream-ndjson!
  "Translate an Ollama NDJSON body into SSE on the hijacked response; a failure
  mid-stream is written as an error frame and the response is closed."
  [^js raw ^js response ^js ctx]
  (try
    (await (ollama/stream-ollama-ndjson-to-chat-completion-sse-js
            (.-body response) (.-routedModel ctx)
            (fn [data] (edge/write-flushing! raw data))))
    (catch :default error
      (when-not (.-writableEnded raw)
        (.write raw (plan/sse-error-frame (error-message error))))))
  (edge/end-quietly! raw))

(defn- ^:async handle-ollama-cloud [^js reply ^js response ^js ctx]
  (cond
    (not (.-ok response)) (await (handle-standard-provider-attempt-js reply response ctx))

    (and (.-clientWantsStream ctx) (has-body? response))
    (let [raw (edge/play! reply (frames/translated-stream-head {:after (frames/provider-frames (.-providerId ctx))}))]
      (await (stream-ndjson! raw response ctx))
      (handled))

    :else
    (let [json (await (json-or-bad response))]
      (if (= ::bad json)
        (request-error)
        (let [completion (ollama/ollama-to-chat-completion-js json (.-routedModel ctx))]
          (edge/play! reply (into [[:header "content-type" "application/json"]]
                                  (conj (frames/provider-frames (.-providerId ctx)) [:send completion])))
          (handled))))))

(defn- ^:async ollama-parse-failure!
  [^js reply wants-stream? message]
  (let [{:keys [status type code message]} (plan/ollama-parse-failure wants-stream? message)]
    (send-openai-error! reply status message type code)))

(defn- ^:async parse-ollama-json [^js response]
  (try (await (.json response))
       (catch :default e {::failed e})))

(defn- ^:async handle-local-ollama [^js reply ^js response ^js ctx]
  (case (plan/local-ollama-plan {:ok? (.-ok response) :wants-stream? (.-clientWantsStream ctx)
                                 :ct (ct-of response) :has-body? (has-body? response)})
    (:standard :standard-stream) (await (handle-standard-local-attempt-js reply response ctx))
    :bootstrap
    (let [parsed (await (parse-ollama-json response))]
      (if (and (map? parsed) (contains? parsed ::failed))
        (await (ollama-parse-failure! reply true (error-message (::failed parsed))))
        (let [completion (ollama/ollama-to-chat-completion-js parsed (.-routedModel ctx))]
          (edge/play! reply (frames/sse-text-frames (sse-from completion))))))))

(defn- ^:async handle-ollama [^js reply ^js response ^js ctx]
  (case (plan/ollama-plan {:ok? (.-ok response) :wants-stream? (.-clientWantsStream ctx) :has-body? (has-body? response)})
    :standard (await (handle-standard-local-attempt-js reply response ctx))
    :ndjson (let [raw (edge/play! reply (frames/translated-stream-head {}))]
              (await (stream-ndjson! raw response ctx)))
    :json
    (let [parsed (await (parse-ollama-json response))]
      (if (and (map? parsed) (contains? parsed ::failed))
        (await (ollama-parse-failure! reply (.-clientWantsStream ctx) (error-message (::failed parsed))))
        (let [completion (ollama/ollama-to-chat-completion-js parsed (.-routedModel ctx))]
          (if (.-clientWantsStream ctx)
            (edge/play! reply (frames/sse-text-frames (sse-from completion)))
            (edge/play! reply [[:header "content-type" "application/json"] [:send completion]])))))))

;; ---------------------------------------------------------------------------
;; Entry points
;; ---------------------------------------------------------------------------

(defn ^:async handle-provider-attempt-js
  "Answer a provider attempt for the strategy registered as `id`. Resolves to
  {kind:\"handled\"} or a `continue` outcome."
  [id ^js reply ^js response ^js ctx]
  (case (plan/provider-handler id)
    :standard (await (handle-standard-provider-attempt-js reply response ctx))
    :transformed (await (handle-transformed reply response ctx (get plan/transformed-ids id)))
    :responses (await (handle-responses reply response ctx))
    :factory-responses (await (handle-factory-responses reply response ctx))
    :openai-codex (await (handle-openai-codex reply response ctx))
    :passthrough (await (handle-passthrough reply response ctx))
    :openai-passthrough (await (handle-openai-passthrough reply response ctx))
    :responses-via-chat (await (handle-responses-via-chat reply response ctx))
    :ollama-cloud (await (handle-ollama-cloud reply response ctx))))

(defn ^:async handle-local-attempt-js
  "Answer a local attempt for the strategy registered as `id`."
  [id ^js reply ^js response ^js ctx]
  (case (plan/local-handler id)
    :standard (await (handle-standard-local-attempt-js reply response ctx))
    :local-ollama (await (handle-local-ollama reply response ctx))
    :ollama (await (handle-ollama reply response ctx)))
  js/undefined)
