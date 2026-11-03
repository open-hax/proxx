(ns proxx.federation.agent
  "The bridge agent's session logic as pure transitions.

  State is one immutable value; transitions are `(f state ... env) -> [effects state']`.
  The socket, the timers and the request handler are the edge's
  (proxx.runtime.federation-agent); it feeds events in and interprets the
  returned effects in order.

    state {:state :idle|:connecting|:connected|:reconnecting|:stopped
           :session-id :connected-at :last-sent-at :last-received-at
           :last-error {:code :message :retryable :at}
           :reconnect-attempt n :heartbeat-sequence n :heartbeat-interval-ms n
           :inbound {stream-id {:request frame :chunks [text ...]}}
           :stopped? bool}

  `opts` is the agent's configuration:
    {:owner-subject :peer-did :cluster-id :agent-id :environment :bridge-agent-version :auth-mode
     :labels :topology :capabilities-hash :reconnect-min-ms :reconnect-max-ms}

  `env` carries what is impure: {:now-ms n :trace-id uuid :ws-open? bool}.

  Effects:
    {:fx :send :frame frame}                      write a frame to the socket
    {:fx :publish-snapshot}                       heartbeat + capabilities + health (async at the edge)
    {:fx :start-heartbeat :interval-ms n}
    {:fx :connected}                              the handshake completed
    {:fx :handle-request :request frame :body-text s}
    {:fx :arm-reconnect :delay-ms n} / {:fx :clear-reconnect}"
  (:require [clojure.string :as str]
            [proxx.federation.protocol :as protocol]))

(def initial-heartbeat-interval-ms 15000)
(def default-handshake-deadline-ms 10000)
(def default-reconnect-min-ms 500)
(def default-reconnect-max-ms 5000)

(def initial-state
  {:state :idle :session-id nil :connected-at nil :last-sent-at nil :last-received-at nil :last-error nil
   :reconnect-attempt 0 :heartbeat-sequence 0 :heartbeat-interval-ms initial-heartbeat-interval-ms
   :inbound {} :stopped? false})

(defn iso-string [now-ms]
  #?(:cljs (.toISOString (js/Date. now-ms))
     :clj (str (java.time.Instant/ofEpochMilli now-ms))))

(defn decode-base64-utf8 [s]
  #?(:cljs (.toString (js/Buffer.from s "base64") "utf8")
     :clj (String. (.decode (java.util.Base64/getDecoder) ^String s) "UTF-8")))

(defn snapshot
  "What `snapshot()` reports: the observable part of the state."
  [state]
  (select-keys state [:state :session-id :connected-at :last-sent-at :last-received-at :last-error :reconnect-attempt]))

(defn record-error
  [state {:keys [code message retryable]} {:keys [now-ms]}]
  (assoc state :last-error {:code code :message message :retryable retryable :at (iso-string now-ms)}))

(defn- compact [m] (into {} (remove (comp nil? val)) m))

;; ---------------------------------------------------------------------------
;; Frames the agent originates
;; ---------------------------------------------------------------------------

(defn- envelope
  "The common frame fields. `session-id` is omitted for the hello (no session yet)."
  [state opts {:keys [now-ms trace-id]} type]
  (compact {"type" type "protocolVersion" protocol/protocol-version
            "sessionId" (:session-id state) "sentAt" (iso-string now-ms) "traceId" trace-id
            "ownerSubject" (:owner-subject opts) "clusterId" (:cluster-id opts) "agentId" (:agent-id opts)}))

(defn hello-frame
  "[hello-frame state']: the first frame on a fresh socket."
  [state opts env]
  (let [frame (merge (envelope (dissoc state :session-id) opts env "hello") ; a hello opens a session, even when a previous one is remembered
                     (compact {"peerDid" (:peer-did opts) "environment" (:environment opts)
                               "bridgeAgentVersion" (:bridge-agent-version opts)
                               "authMode" (:auth-mode opts) "capabilitiesHash" (:capabilities-hash opts)
                               "labels" (vec (:labels opts)) "topology" (:topology opts)}))]
    [frame (assoc state :last-sent-at (get frame "sentAt"))]))

(defn- send-frame
  "[effects state'] writing `body` (type-specific fields) in this session's envelope,
  or nothing when there is no session or the socket is not open."
  [state opts env type body]
  (if (and (:session-id state) (:ws-open? env))
    (let [frame (merge (envelope state opts env type) (compact body))]
      [[{:fx :send :frame frame}] (assoc state :last-sent-at (get frame "sentAt"))])
    [[] state]))

(defn send-error
  "[effects state']: tell the relay about a failure and remember it. Without a
  session or an open socket nothing is sent and nothing is remembered."
  [state opts env {:keys [code message retryable stream-id]}]
  (if (and (:session-id state) (:ws-open? env))
    (let [[fx state'] (send-frame state opts env "error"
                                  {"streamId" stream-id "code" code "message" message "retryable" retryable})]
      [fx (record-error state' {:code code :message message :retryable retryable} env)])
    [[] state]))

(defn merge-provenance
  "Who served a response: the update wins, then the base, then (for the cluster) this agent."
  [base update opts]
  {"servedByClusterId" (or (get update "servedByClusterId") (get base "servedByClusterId") (:cluster-id opts))
   "servedByGroupId" (or (get update "servedByGroupId") (get base "servedByGroupId"))
   "servedByNodeId" (or (get update "servedByNodeId") (get base "servedByNodeId"))
   "providerId" (or (get update "providerId") (get base "providerId"))
   "accountId" (or (get update "accountId") (get base "accountId"))})

(defn response-head [state opts env stream-id status headers provenance]
  (send-frame state opts env "response_head"
              (merge {"streamId" stream-id "status" status "headers" (or headers {})}
                     (merge-provenance nil provenance opts))))

(defn response-chunk [state opts env stream-id chunk encoding final provenance]
  (send-frame state opts env "response_chunk"
              (merge {"streamId" stream-id "chunk" chunk "encoding" encoding "final" final}
                     (merge-provenance nil provenance opts))))

(defn response-end [state opts env stream-id usage provenance]
  (send-frame state opts env "response_end"
              (merge {"streamId" stream-id "usage" usage} (merge-provenance nil provenance opts))))

;; ---------------------------------------------------------------------------
;; Turning a handler's answer into frames
;; ---------------------------------------------------------------------------

(defn buffered-response
  "[effects state'] for a handler result that is one complete response
  ({\"status\" \"headers\" \"body\" \"encoding\" \"usage\" + provenance})."
  [state opts env stream-id result]
  (let [[fx1 state] (response-head state opts env stream-id (get result "status") (get result "headers") result)
        body (get result "body")
        [fx2 state] (if (and (string? body) (seq body))
                      (response-chunk state opts env stream-id body (or (get result "encoding") "utf8") true result)
                      [[] state])
        [fx3 state] (response-end state opts env stream-id (get result "usage") result)]
    [(into (into fx1 fx2) fx3) state]))

(def initial-stream {:saw-head? false :saw-end? false :provenance nil})

(defn stream-event
  "[effects state' stream']: one event of a streaming handler result. A chunk or
  end before any head implies a 200 head with no headers."
  [state opts env stream-id stream event]
  (let [provenance (merge-provenance (:provenance stream) event opts)
        stream (assoc stream :provenance provenance)
        implied-head (fn [state stream]
                       (if (:saw-head? stream)
                         [[] state stream]
                         (let [[fx state] (response-head state opts env stream-id 200 nil event)]
                           [fx state (assoc stream :saw-head? true)])))]
    (case (get event "type")
      "response_head" (let [[fx state] (response-head state opts env stream-id (get event "status") (get event "headers") event)]
                        [fx state (assoc stream :saw-head? true)])
      "response_chunk" (let [[fx1 state stream] (implied-head state stream)
                             [fx2 state] (response-chunk state opts env stream-id (get event "chunk")
                                                         (or (get event "encoding") "utf8") (or (get event "final") false) event)]
                         [(into fx1 fx2) state stream])
      "response_end" (let [[fx1 state stream] (implied-head state stream)
                           [fx2 state] (response-end state opts env stream-id (get event "usage") event)]
                       [(into fx1 fx2) state (assoc stream :saw-end? true)])
      [[] state stream])))

(defn stream-finish
  "[effects state']: close out a stream that ended without a head and/or an end."
  [state opts env stream-id stream]
  (let [[fx1 state] (if (:saw-head? stream)
                      [[] state]
                      (response-head state opts env stream-id 200 nil (:provenance stream)))
        [fx2 state] (if (:saw-end? stream)
                      [[] state]
                      (response-end state opts env stream-id nil (:provenance stream)))]
    [(into fx1 fx2) state]))

;; ---------------------------------------------------------------------------
;; Handshake, heartbeat, reconnect
;; ---------------------------------------------------------------------------

(defn begin-connect [state reconnect?]
  (assoc state :state (if reconnect? :reconnecting :connecting)))

(defn handshake-timeout [state deadline-ms env]
  (let [message (str "bridge hello_ack was not received within " deadline-ms "ms")]
    [message (record-error state {:code "bridge_hello_ack_timeout" :message message :retryable true} env)]))

(defn heartbeat-frame
  "[effects state']: the next heartbeat (numbered from 1 per session)."
  [state opts env]
  (let [state (update state :heartbeat-sequence inc)]
    (send-frame state opts env "heartbeat"
                {"sequence" (:heartbeat-sequence state) "activeStreams" 0 "queuedRequests" 0})))

(defn capabilities-frame [state opts env capabilities]
  (send-frame state opts env "capabilities" {"capabilities" (vec capabilities)}))

(def default-health
  {"processHealthy" true "upstreamHealthy" true "availableAccountCount" 0 "localOauthBootstrapReady" false "nodes" []})

(defn health-frame [state opts env health]
  (send-frame state opts env "health_report" {"health" (or health default-health)}))

(defn reconnect-delay-ms [opts attempt]
  (let [min-ms (or (:reconnect-min-ms opts) default-reconnect-min-ms)
        max-ms (or (:reconnect-max-ms opts) default-reconnect-max-ms)]
    (min max-ms (* min-ms (Math/pow 2 (max 0 (dec attempt)))))))

(defn schedule-reconnect
  "[effects state']: arm the next attempt with exponential backoff, unless stopped."
  [state opts]
  (if (:stopped? state)
    [[] state]
    (let [state (-> state (update :reconnect-attempt inc) (assoc :state :reconnecting))]
      [[{:fx :clear-reconnect}
        {:fx :arm-reconnect :delay-ms (reconnect-delay-ms opts (:reconnect-attempt state))}]
       state])))

(defn stop [state]
  (assoc state :stopped? true :state :stopped))

(defn start [state]
  (assoc state :stopped? false))

;; ---------------------------------------------------------------------------
;; Inbound frames
;; ---------------------------------------------------------------------------

(defn on-message
  "[effects state'] for a parsed frame from the relay."
  [state opts env frame]
  (let [state (assoc state :last-received-at (get frame "sentAt"))
        stream-id (get frame "streamId")]
    (case (get frame "type")
      "hello_ack"
      [[{:fx :publish-snapshot}
        {:fx :start-heartbeat :interval-ms (get frame "heartbeatIntervalMs")}
        {:fx :connected}]
       (assoc state :session-id (get frame "sessionId") :connected-at (get frame "sentAt")
              :heartbeat-interval-ms (get frame "heartbeatIntervalMs")
              :reconnect-attempt 0 :heartbeat-sequence 0 :state :connected)]

      "error"
      [[] (record-error state {:code (get frame "code") :message (get frame "message")
                               :retryable (get frame "retryable")} env)]

      "request_open"
      (if (= "GET" (get frame "method"))
        [[{:fx :handle-request :request frame :body-text ""}] state]
        [[] (assoc-in state [:inbound stream-id] {:request frame :chunks []})])

      "request_chunk"
      (if-let [pending (get-in state [:inbound stream-id])]
        (let [text (if (= "base64" (get frame "encoding")) (decode-base64-utf8 (get frame "chunk")) (get frame "chunk"))
              chunks (conj (:chunks pending) text)]
          (if (get frame "final")
            [[{:fx :handle-request :request (:request pending) :body-text (str/join chunks)}]
             (update state :inbound dissoc stream-id)]
            [[] (assoc-in state [:inbound stream-id :chunks] chunks)]))
        (send-error state opts env {:stream-id stream-id :code "bridge_request_stream_missing"
                                    :message (str "received request chunk for unknown stream " stream-id)
                                    :retryable false}))

      [[] state])))
