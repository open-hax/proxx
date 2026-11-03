(ns proxx.federation.relay
  "The bridge relay's session and request-correlation logic as pure transitions.

  State is one immutable value; every transition is
  `(f state ... env) -> [effects state']` (or `[value state']` when it yields a
  frame). Effects are data for the edge to interpret in order:

    {:fx :send :to :reply | {:session sid} :frame frame}
    {:fx :close :code n :reason s}                 close the arrival channel
    {:fx :register-channel :session-id sid}        bind the arrival channel to sid
    {:fx :unregister-channel :session-id sid}
    {:fx :register-stream :stream-id id}           a response queue now exists
    {:fx :arm-timer :stream-id id :timeout-ms n}   fail the stream if it fires
    {:fx :clear-timer :stream-id id}
    {:fx :stream-push :stream-id id :frame f}      -> proxx.federation.stream/push
    {:fx :stream-end :stream-id id :frame f}       -> .../finish, then drop the queue
    {:fx :stream-fail :stream-id id :message m}    -> .../fail, then drop the queue

  `env` carries everything impure: {:now-ms n :ids [uuid ...]} (a transition
  uses at most three ids) and, for `open-request`, {:channel-open? bool}.

    state    {:sessions {session-id session} :pending {stream-id {:session-id :path :seq}} :seq n}
    session  {:session-id :state (:connected|:disconnected) :connected-at :last-seen-at
              :disconnected-at :disconnected-at-ms :peer-did :owner-subject :cluster-id :agent-id
              :environment :bridge-agent-version :auth-mode :auth-kind :auth-subject :tenant-id
              :labels :topology :capabilities :health :recent-error :active-streams
              :queued-requests :last-heartbeat-sequence :seq}

  Protocol payloads inside a session (topology, capabilities, health) stay
  string-keyed wire data exactly as parsed."
  (:require [proxx.federation.protocol :as protocol]))

(def empty-state {:sessions {} :pending {} :seq 0})

(def heartbeat-interval-ms 15000)
(def max-concurrent-streams 32)
(def max-frame-bytes (* 256 1024))
(def session-retention-ms 300000)

(defn iso-string [now-ms]
  #?(:cljs (.toISOString (js/Date. now-ms))
     :clj (str (java.time.Instant/ofEpochMilli now-ms))))

(defn- locale-compare [a b]
  #?(:cljs (.localeCompare a b) :clj (compare a b)))

(defn- date-ms [iso]
  #?(:cljs (.getTime (js/Date. iso))
     :clj (.toEpochMilli (java.time.Instant/parse iso))))

(defn- error-message [e]
  #?(:cljs (if (instance? js/Error e) (.-message e) (str e))
     :clj (ex-message e)))

(defn- try-parse
  "[:ok frame] or [:error message]."
  [text]
  (try [:ok (protocol/parse-message-json text)]
       (catch #?(:clj Throwable :cljs :default) e [:error (error-message e)])))

;; ---------------------------------------------------------------------------
;; Sessions
;; ---------------------------------------------------------------------------

(defn prune-disconnected
  "Drop sessions disconnected longer than `max-age-ms` so the table cannot grow without bound."
  ([state now-ms] (prune-disconnected state now-ms session-retention-ms))
  ([state now-ms max-age-ms]
   (let [cutoff (- now-ms max-age-ms)]
     (update state :sessions
             (fn [sessions]
               (into {} (remove (fn [[_ s]]
                                  (and (= :disconnected (:state s)) (:disconnected-at s)
                                       (< (date-ms (:disconnected-at s)) cutoff))))
                     sessions))))))

(defn list-sessions
  "Sessions, most recently connected first (ties in connection order)."
  [state]
  (->> (vals (:sessions state))
       (sort (fn [a b]
               (let [c (locale-compare (:connected-at b) (:connected-at a))]
                 (if (zero? c) (compare (:seq a) (:seq b)) c))))
       vec))

(defn get-session [state session-id] (get-in state [:sessions session-id]))

(defn accept-hello
  "Register a session for a parsed hello. Returns [hello-ack state'].
  `identity` is {:auth-kind :subject :tenant-id}; env ids: [session-id trace-id]."
  [state hello {:keys [auth-kind subject tenant-id]} {:keys [now-ms ids]}]
  (let [[session-id trace-id] ids
        connected-at (get hello "sentAt")
        state (prune-disconnected state now-ms)
        session {:session-id session-id :state :connected :connected-at connected-at :last-seen-at connected-at
                 :peer-did (get hello "peerDid") :owner-subject (get hello "ownerSubject")
                 :cluster-id (get hello "clusterId") :agent-id (get hello "agentId")
                 :environment (get hello "environment") :bridge-agent-version (get hello "bridgeAgentVersion")
                 :auth-mode (get hello "authMode") :auth-kind auth-kind :auth-subject subject :tenant-id tenant-id
                 :labels (vec (get hello "labels")) :topology (get hello "topology")
                 :capabilities [] :health nil :recent-error nil
                 :active-streams 0 :queued-requests 0 :last-heartbeat-sequence nil
                 :seq (:seq state)}
        ack {"type" "hello_ack" "protocolVersion" protocol/protocol-version "sessionId" session-id
             "sentAt" (iso-string now-ms) "traceId" trace-id
             "ownerSubject" (get hello "ownerSubject") "clusterId" (get hello "clusterId") "agentId" (get hello "agentId")
             "heartbeatIntervalMs" heartbeat-interval-ms "maxConcurrentStreams" max-concurrent-streams
             "maxFrameBytes" max-frame-bytes}]
    [ack (-> state (assoc-in [:sessions session-id] session) (update :seq inc))]))

;; ---------------------------------------------------------------------------
;; Frames the relay originates
;; ---------------------------------------------------------------------------

(defn- error-frame
  "[frame session']: an error frame about `session` (a session map) or about a
  bare session id / no session (strings and nil carry no owner identity).
  Only a known session remembers the error as its :recent-error."
  [session-or-id {:keys [code message retryable stream-id]} {:keys [now-ms ids]}]
  (let [session (when (map? session-or-id) session-or-id)
        sent-at (iso-string now-ms)
        frame (cond-> {"type" "error" "protocolVersion" protocol/protocol-version
                       "sessionId" (cond session (:session-id session) (string? session-or-id) session-or-id :else "")
                       "sentAt" sent-at "traceId" (first ids)
                       "ownerSubject" (if session (:owner-subject session) "")
                       "clusterId" (if session (:cluster-id session) "")
                       "agentId" (if session (:agent-id session) "")
                       "code" code "message" message "retryable" retryable}
                stream-id (assoc "streamId" stream-id))]
    [frame (when session (assoc session :recent-error {:at sent-at :code code :message message :retryable retryable}))]))

(defn- send-error
  "[effects state'] sending an error frame to the arrival channel."
  [state session-or-id input env]
  (let [[frame session'] (error-frame session-or-id input env)]
    [[{:fx :send :to :reply :frame frame}]
     (cond-> state session' (assoc-in [:sessions (:session-id session')] session'))]))

;; ---------------------------------------------------------------------------
;; Inbound frames on an established session
;; ---------------------------------------------------------------------------

(defn- with-pending
  "`f` when a request is waiting on `stream-id`; otherwise only `fallback-state` (frames for unknown streams are dropped)."
  [state fallback-state stream-id f]
  (if (contains? (:pending state) stream-id) (f) [[] fallback-state]))

(defn- dispatch-frame
  "The effects of a validated frame on `session` (already stamped lastSeenAt)."
  [state session parsed env]
  (let [sid (:session-id session)
        stream-id (get parsed "streamId")
        put (fn [s] (assoc-in state [:sessions sid] s))]
    (case (get parsed "type")
      "heartbeat" [[] (put (assoc session :last-heartbeat-sequence (get parsed "sequence")
                                  :active-streams (get parsed "activeStreams")
                                  :queued-requests (get parsed "queuedRequests")))]
      "capabilities" [[] (put (assoc session :capabilities (get parsed "capabilities")))]
      "health_report" [[] (put (assoc session :health (get parsed "health")))]
      "response_head" (with-pending state (put session) stream-id #(vector [{:fx :stream-push :stream-id stream-id :frame parsed}] (put session)))
      "response_chunk" (with-pending state (put session) stream-id #(vector [{:fx :stream-push :stream-id stream-id :frame parsed}] (put session)))
      "response_end" (with-pending state (put session) stream-id
                       #(vector [{:fx :clear-timer :stream-id stream-id}
                                 {:fx :stream-end :stream-id stream-id :frame parsed}]
                                (update (put session) :pending dissoc stream-id)))
      "error" (let [recent {:at (get parsed "sentAt") :code (get parsed "code")
                            :message (get parsed "message") :retryable (get parsed "retryable")}
                    state (put (assoc session :recent-error recent))]
                (if (and stream-id (contains? (:pending state) stream-id))
                  [[{:fx :clear-timer :stream-id stream-id}
                    {:fx :stream-fail :stream-id stream-id
                     :message (str (get parsed "code") ": " (get parsed "message"))}]
                   (update state :pending dissoc stream-id)]
                  [[] state]))
      "hello" (send-error (put session) session
                          {:code "bridge_duplicate_hello" :message "bridge hello may only be sent once per session"
                           :retryable false}
                          env)
      (send-error (put session) session
                  {:code "bridge_execution_not_implemented"
                   :message (str "bridge message type " (get parsed "type") " is not implemented by the relay stub yet")
                   :retryable true :stream-id stream-id}
                  env))))

(defn handle-message
  "One text frame from an established session's channel. Returns [effects state'].
  Anything unreadable becomes a `bridge_message_invalid` error frame."
  [state session-id text env]
  (let [[status parsed] (try-parse text)]
    (if (= :error status)
      (send-error state session-id {:code "bridge_message_invalid" :message parsed :retryable false} env)
      (if-let [session (get-session state session-id)]
        (if (and (get parsed "sessionId") (not= (get parsed "sessionId") session-id))
          (send-error state session
                      {:code "bridge_session_mismatch"
                       :message (str "message sessionId " (get parsed "sessionId") " does not match active session " session-id)
                       :retryable false :stream-id (get parsed "streamId")}
                      env)
          (dispatch-frame state (assoc session :last-seen-at (get parsed "sentAt")) parsed env))
        (send-error state session-id {:code "bridge_session_not_found" :message "bridge session not found" :retryable false} env)))))

(defn handle-connection-message
  "One text frame on a fresh connection. Until a hello has been accepted the only
  legal frame is a hello; afterwards frames go to `handle-message`.
  `conn` is {:session-id sid|nil}. Returns [effects state' conn']."
  [state conn text env]
  (if-let [session-id (:session-id conn)]
    (let [[fx state'] (handle-message state session-id text env)] [fx state' conn])
    (let [[status parsed] (try-parse text)
          reject (fn [code message]
                   (let [[fx state'] (send-error state nil {:code code :message message :retryable false} env)]
                     [(conj fx {:fx :close :code 1008 :reason code}) state' conn]))]
      (cond
        (= :error status) (reject "bridge_message_decode_failed" parsed)
        (not= "hello" (get parsed "type")) (reject "bridge_hello_required" "first bridge frame must be a hello message")
        :else (let [identity (:identity env)
                    [ack state'] (accept-hello state parsed identity env)
                    sid (get ack "sessionId")]
                [[{:fx :register-channel :session-id sid}
                  {:fx :send :to :reply :frame ack}]
                 state' {:session-id sid}])))))

(defn connection-error
  "[effects] for a transport-level failure on a connection (binary frame, undecodable
  bytes): an error frame about `session-id` (nil before the hello) and a policy close."
  [session-id code message env]
  (let [[frame _] (error-frame session-id {:code code :message message :retryable false} env)]
    [{:fx :send :to :reply :frame frame} {:fx :close :code 1008 :reason code}]))

;; ---------------------------------------------------------------------------
;; Disconnect and shutdown
;; ---------------------------------------------------------------------------

(defn- ordered-pending [state]
  (sort-by (comp :seq val) (:pending state)))

(defn- fail-pending [entries message-of]
  (mapcat (fn [[stream-id p]]
            [{:fx :clear-timer :stream-id stream-id}
             {:fx :stream-fail :stream-id stream-id :message (message-of stream-id p)}])
          entries))

(defn disconnect
  "The channel of `session-id` is gone: mark it disconnected and fail its in-flight requests."
  [state session-id {:keys [now-ms]}]
  (if-let [session (and session-id (get-session state session-id))]
    (let [mine (filter (comp #{session-id} :session-id val) (ordered-pending state))]
      [(into [{:fx :unregister-channel :session-id session-id}]
             (fail-pending mine (fn [stream-id _] (str "bridge session " session-id " closed during request " stream-id))))
       (-> state
           (assoc-in [:sessions session-id]
                     (assoc session :state :disconnected :disconnected-at (iso-string now-ms) :disconnected-at-ms now-ms))
           (update :pending #(apply dissoc % (map key mine))))])
    [[] state]))

(defn close-all
  "The relay is closing: fail every in-flight request."
  [state]
  [(vec (fail-pending (ordered-pending state) (fn [_ _] "bridge relay closed")))
   (assoc state :pending {})])

;; ---------------------------------------------------------------------------
;; Requests the relay originates
;; ---------------------------------------------------------------------------

(defn- request-error [message]
  (ex-info message {:error/type :federation/bridge-request-rejected}))

(defn open-request
  "Open a request/response stream on a connected session. Throws when the session
  is not connected or has no open channel. env ids: [stream-id trace-id chunk-trace-id].
  `input`: {:method :path :timeout-ms :headers :body :request-context :routing-intent}."
  [state session-id {:keys [method path timeout-ms headers body request-context routing-intent]}
   {:keys [now-ms ids channel-open?]}]
  (let [session (get-session state session-id)]
    (when-not (and session (= :connected (:state session)))
      (throw (request-error (str "bridge session " session-id " is not connected"))))
    (when-not channel-open?
      (throw (request-error (str "bridge session " session-id " has no open channel"))))
    (let [[stream-id trace-id chunk-trace-id] ids
          sent-at (iso-string now-ms)
          addressed (fn [frame]
                      (merge {"protocolVersion" protocol/protocol-version "sessionId" session-id "sentAt" sent-at
                              "ownerSubject" (:owner-subject session) "clusterId" (:cluster-id session)
                              "agentId" (:agent-id session)}
                             frame))
          open (addressed (cond-> {"type" "request_open" "streamId" stream-id "traceId" trace-id
                                   "method" (or method "GET") "path" path
                                   "headers" (or headers {"accept" "application/json"}) "hopCount" 0}
                            request-context (assoc "requestContext" request-context)
                            routing-intent (assoc "routingIntent" routing-intent)))
          chunk (when (and (string? body) (seq body))
                  (addressed {"type" "request_chunk" "streamId" stream-id "traceId" chunk-trace-id
                              "chunk" body "encoding" "utf8" "final" true}))]
      [(cond-> [{:fx :register-stream :stream-id stream-id}
                {:fx :arm-timer :stream-id stream-id :timeout-ms timeout-ms}
                {:fx :send :to {:session session-id} :frame open}]
         chunk (conj {:fx :send :to {:session session-id} :frame chunk}))
       (-> state
           (assoc-in [:pending stream-id] {:session-id session-id :path path :seq (:seq state)})
           (update :seq inc))
       stream-id])))

(defn request-timed-out
  "The request timer fired. Returns [effects state']."
  [state stream-id]
  (if-let [{:keys [path]} (get-in state [:pending stream-id])]
    [[{:fx :stream-fail :stream-id stream-id :message (str "bridge request timed out for " path)}]
     (update state :pending dissoc stream-id)]
    [[] state]))

(defn release-request
  "The consumer stopped iterating before the end: stop correlating its frames."
  [state stream-id]
  [[{:fx :clear-timer :stream-id stream-id}] (update state :pending dissoc stream-id)])

;; ---------------------------------------------------------------------------
;; Upgrade rejection
;; ---------------------------------------------------------------------------

(defn upgrade-rejection-text
  "Raw HTTP response written to a socket whose websocket upgrade is refused.
  `body-bytes` is the UTF-8 byte length of `body`."
  [status body body-bytes]
  (str "HTTP/1.1 " status " " (case status 401 "Unauthorized" 403 "Forbidden" "Not Found") "\r\n"
       "Connection: close\r\n"
       "Content-Type: application/json; charset=utf-8\r\n"
       "Content-Length: " body-bytes "\r\n"
       "\r\n"
       body))
