(ns proxx.strategy.reply
  "How each strategy answers an upstream response, as verdicts over facts
  (src/lib/provider-strategy/strategies/*). The edge reads the facts (status,
  content type, whether a body exists, what the client asked for), asks for the
  verdict, then does exactly the I/O the verdict names.

  `ct` arguments are the upstream content-type header (nil when absent)."
  (:require [clojure.string :as str]
            [proxx.strategy.attempt :as attempt]))

(def transformed-ids
  "Strategies that read an OK JSON body, translate it to a chat completion and
  reply (src/lib/provider-strategy/base.ts TransformedJsonProviderStrategy).
  The value names the translation."
  {"messages" :messages
   "factory-messages" :messages
   "responses" :responses
   "factory-responses" :responses
   "openai-responses" :responses
   "openai-chat" :responses})

(def local-ollama-ids #{"local-ollama"})
(def ollama-ids #{"ollama" "remote-ollama"})

(defn provider-handler
  "Which handler answers a provider attempt for the strategy registered as `id`."
  [id]
  (case id
    "responses" :responses
    "factory-responses" :factory-responses
    ("openai-responses" "openai-chat") :openai-codex
    ("responses-passthrough" "factory-responses-passthrough") :passthrough
    "openai-responses-passthrough" :openai-passthrough
    "responses-via-chat" :responses-via-chat
    "ollama-cloud" :ollama-cloud
    (if (contains? transformed-ids id) :transformed :standard)))

(defn local-handler
  "Which handler answers a local attempt for the strategy registered as `id`."
  [id]
  (cond (contains? local-ollama-ids id) :local-ollama
        (contains? ollama-ids id) :ollama
        :else :standard))

(defn event-stream? [ct] (attempt/event-stream-content-type? ct))

(defn event-stream-or-untyped? [ct] (attempt/event-stream-or-untyped? ct))

(defn passthrough-plan
  "responses-passthrough / factory-responses-passthrough on an OK response:
    :stream      relay the SSE body as it arrives
    :no-body     an event stream with nothing to read: try the next candidate
    :text        no body object: send the text
    :bytes       send the body as bytes"
  [{:keys [ct has-body?]}]
  (cond (event-stream? ct) (if has-body? :stream :no-body)
        has-body? :bytes
        :else :text))

(defn openai-passthrough-plan
  "openai-responses-passthrough:
    :standard      a failed non-stream response: the standard failure verdict
    :stream-error  a failed event stream: look for an error event in it
    :relay         client wants a stream and upstream streams: relay with timeouts
    :collect       upstream streams, client does not: buffer and unwrap
    :copy          anything else: copy the response through"
  [{:keys [ok? ct wants-stream?]}]
  (let [stream-like? (event-stream-or-untyped? ct)]
    (cond (and (not ok?) (not stream-like?)) :standard
          (not ok?) :stream-error
          (and wants-stream? stream-like?) :relay
          stream-like? :collect
          :else :copy)))

(defn copy-plan
  "How the :copy reply sends its body."
  [{:keys [has-body?]}]
  (if has-body? :bytes :text))

(defn codex-plan
  "openai-responses / openai-chat: an event stream (or untyped) OK response is
  read as a Responses event stream, anything else as JSON."
  [{:keys [ok? ct]}]
  (if (and ok? (event-stream-or-untyped? ct)) :event-stream :transformed))

(defn event-stream-as-chat-plan
  "A Responses event stream answered as a chat completion."
  [{:keys [wants-stream? has-body?]}]
  (if (and wants-stream? has-body?) :stream :buffer))

(defn factory-responses-plan
  "factory-responses on an OK or failed response."
  [{:keys [ok? ct wants-stream? has-body?]}]
  (cond (not ok?) :transformed
        (not (event-stream-or-untyped? ct)) :json
        (and wants-stream? has-body?) :stream
        :else :buffer))

(defn responses-plan
  "responses, once the body parsed to a record and translated:
    :reasoning-stream  the client streams and the Responses output has reasoning
    :sse               the client streams: one buffered SSE reply
    :json              a JSON reply"
  [{:keys [wants-stream? output-has-reasoning?]}]
  (cond (and wants-stream? output-has-reasoning?) :reasoning-stream
        wants-stream? :sse
        :else :json))

(defn responses-via-chat-plan
  "responses-via-chat, for an OK response:
    :events->response  the client streams and upstream streams
    :completion->events the client streams, upstream sent JSON
    :stream-skipped    the client does not stream but upstream did: next candidate
    :completion->response the client does not stream, upstream sent JSON"
  [{:keys [wants-stream? ct]}]
  (let [es? (event-stream? ct)]
    (cond (and wants-stream? es?) :events->response
          wants-stream? :completion->events
          es? :stream-skipped
          :else :completion->response)))

(defn local-standard-plan
  "The standard local reply: relay an event stream, send the rest.
    :text    no body object
    :stream  event stream, relayed
    :bytes   anything else"
  [{:keys [ct has-body?]}]
  (cond (not has-body?) :text
        (event-stream? ct) :stream
        :else :bytes))

(defn local-ollama-plan
  "local-ollama on an OK response:
    :standard  a failed response, or the client does not stream
    :standard-stream  the client streams and upstream already speaks SSE
    :bootstrap  the client streams but upstream sent one JSON document"
  [{:keys [ok? wants-stream? ct has-body?]}]
  (cond (not ok?) :standard
        (not wants-stream?) :standard
        (and (event-stream? ct) has-body?) :standard-stream
        :else :bootstrap))

(defn ollama-plan
  "ollama / remote-ollama on a response:
    :standard   failed
    :ndjson     the client streams and there is a body: translate NDJSON to SSE
    :json       parse the JSON document"
  [{:keys [ok? wants-stream? has-body?]}]
  (cond (not ok?) :standard
        (and wants-stream? has-body?) :ndjson
        :else :json))

(defn ollama-parse-failure
  "The 502 for an Ollama document that did not parse."
  [wants-stream? message]
  (let [code (if wants-stream? "ollama_stream_parse_failed" "ollama_parse_failed")
        label (if wants-stream? "stream bootstrap payload" "upstream payload")]
    {:status 502 :type "server_error" :code code
     :message (str "Failed to parse Ollama " label ": " message)}))

(defn sse-error-frame
  "The data frame written into a stream that failed mid-flight."
  [message]
  (str "data: " #?(:cljs (js/JSON.stringify (clj->js {"error" {"message" message}}))
                   :clj (str "{\"error\":{\"message\":" (pr-str message) "}}"))
       "\n\n"))

(defn lower-includes? [s needle] (str/includes? (str/lower-case (or s "")) needle))
