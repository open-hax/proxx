(ns proxx.strategy.attempt
  "Verdicts on a single upstream response, over facts the edge has already read.

  An attempt ends in `:handled` (the client got an answer) or a `continue` outcome
  whose flags say why the router should move on. This namespace decides *which
  flags* from the status, the body shape and the stream so far; reading bodies,
  cancelling readers and writing to the client are the edge's job. Outcome flags
  are kebab-case keywords: `:rate-limit :request-error :upstream-server-error
  :upstream-invalid-request :model-not-found :model-not-supported-for-account`."
  (:require [clojure.string :as str]
            [proxx.json :as json]))

;; ---------------------------------------------------------------------------
;; Failed responses
;; ---------------------------------------------------------------------------

(defn failure-body-needed
  "What the edge must still read to judge a failed response whose missing-model and
  unsupported-model probes were negative: `:auth-summary` for 401/403, `:text` for
  400/422, otherwise nothing."
  [status]
  (case status
    (401 403) :auth-summary
    (400 422) :text
    nil))

(defn failed-outcome
  "The `continue` outcome for a non-OK response.
  `facts`: `{:status n :missing-model? b :model-not-supported? b
  :auth-message s-or-nil :error-body s}`."
  [{:keys [status missing-model? model-not-supported? auth-message error-body]}]
  (cond
    missing-model? {:model-not-found true}
    model-not-supported? {:model-not-supported-for-account true :request-error true}
    (contains? #{401 403} status)
    {:request-error true
     :upstream-auth-error (cond-> {:status status} (some? auth-message) (assoc :message auth-message))}
    (contains? #{400 422} status)
    {:request-error true :upstream-invalid-request true :upstream-error-body (or error-body "")}
    :else {:request-error true}))

;; ---------------------------------------------------------------------------
;; Successful responses
;; ---------------------------------------------------------------------------

(defn event-stream-content-type? [content-type]
  (str/includes? (str/lower-case (or content-type "")) "text/event-stream"))

(defn event-stream-or-untyped?
  "Event stream, or no content type at all (providers that stream without saying so)."
  [content-type]
  (or (event-stream-content-type? content-type) (empty? (or content-type ""))))

(defn chat-completion-like?
  "Does a parsed OK body look like a chat completion (or one of the other payloads
  this attempt is allowed to relay)? `facts`: `{:images-passthrough? :provider-id}`."
  [parsed {:keys [images-passthrough? provider-id]}]
  (let [record? (map? parsed)
        images? (and images-passthrough? record? (sequential? (get parsed "data")))
        native-ollama? (and (= "ollama" provider-id) record?
                            (or (map? (get parsed "message")) (string? (get parsed "response"))))]
    (boolean (or (and record? (or (contains? parsed "choices") (contains? parsed "object") (contains? parsed "id")))
                 images? native-ollama?))))

(defn ok-body-verdict
  "How to treat an OK, non-event-stream body already read as `body-text`.
  `:empty` and `:invalid` mean continue with a request error; `:stream-like` means
  the body is really SSE and the client wants a stream; `:ok` means relay it.
  `facts`: `{:client-wants-stream? :stream-like? :images-passthrough? :provider-id}`."
  [body-text {:keys [client-wants-stream? stream-like?] :as facts}]
  (cond
    (empty? body-text) :empty
    (and client-wants-stream? stream-like?) :stream-like
    :else (let [parsed (try (json/parse body-text) (catch #?(:cljs :default :clj Exception) _ ::unparseable))]
            (if (or (= ::unparseable parsed) (not (chat-completion-like? parsed facts))) :invalid :ok))))

(defn chat-completion-response?
  "A completion with a first choice that has a `message` object."
  [value]
  (let [choices (when (map? value) (get value "choices"))]
    (boolean (and (sequential? choices) (map? (first choices)) (map? (get (first choices) "message"))))))

(defn success-mode
  "How an OK response is delivered: `:reasoning-json` (buffered, checked for a
  reasoning trace), `:stream` (bootstrap-checked event stream) or `:relay`."
  [{:keys [client-wants-stream? needs-reasoning-trace?]}]
  (cond
    (and (not client-wants-stream?) needs-reasoning-trace?) :reasoning-json
    client-wants-stream? :stream
    :else :relay))

(defn missing-reasoning-skips?
  "A reasoning trace was required, the result has none, and another candidate remains."
  [{:keys [needs-reasoning-trace? has-more-candidates?]} has-reasoning?]
  (boolean (and needs-reasoning-trace? (not has-reasoning?) has-more-candidates?)))

;; ---------------------------------------------------------------------------
;; Stream bootstrap
;; ---------------------------------------------------------------------------

(defn bootstrap-verdict
  "Judge the event stream's text so far (comments already stripped).
  `quota?` `substantive?` `reasoning?` are the three questions asked of it;
  `done?` says the stream has ended. Returns `:ready`, `:read-more`,
  `{:continue {:rate-limit true}}` or `{:continue {:request-error true}}`."
  [{:keys [quota? substantive? reasoning? done?]}
   {:keys [needs-reasoning-trace? has-more-candidates?]}]
  (let [wants-reasoning? (and needs-reasoning-trace? has-more-candidates?)]
    (cond
      quota? {:continue {:rate-limit true}}
      (not substantive?) (if done? {:continue {:request-error true}} :read-more)
      (and wants-reasoning? (not reasoning?)) (if done? {:continue {:request-error true}} :read-more)
      :else :ready)))

;; ---------------------------------------------------------------------------
;; Native embeddings relays
;; ---------------------------------------------------------------------------

(defn embedding-attempt-outcome [ok?]
  (if ok? :handled {:continue {:request-error true}}))
