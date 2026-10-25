(ns proxx.runtime.federation-relay
  "Edge of the bridge relay: sockets, timers, response-stream consumers.

  All session, correlation and queue decisions are pure transitions in
  proxx.federation.relay / proxx.federation.stream; this namespace holds the one
  atom with the relay state, the JS-side tables the pure state cannot hold
  (channels, response queues, timers) and interprets the effects the
  transitions return, in order. The JS facade keeps the method names of the
  former TypeScript class."
  (:require ["node:crypto" :as crypto]
            ["ws" :as ws]
            [proxx.federation.protocol :as protocol]
            [proxx.federation.relay :as relay]
            [proxx.federation.stream :as stream]
            [proxx.runtime.federation :as fed]))

(def ^:private ws-open 1)

;; ---------------------------------------------------------------------------
;; JS conversion
;; ---------------------------------------------------------------------------

(defn- session->js
  "A session as the camelCase record the HTTP layer returns: absent values are absent."
  [{:keys [session-id state connected-at last-seen-at disconnected-at peer-did owner-subject cluster-id agent-id
           environment bridge-agent-version auth-mode auth-kind auth-subject tenant-id labels topology capabilities
           health recent-error active-streams queued-requests last-heartbeat-sequence]}]
  (let [o (js-obj)]
    (doseq [[k v] [["sessionId" session-id] ["state" (name state)] ["connectedAt" connected-at]
                   ["lastSeenAt" last-seen-at] ["disconnectedAt" disconnected-at] ["peerDid" peer-did]
                   ["ownerSubject" owner-subject] ["clusterId" cluster-id] ["agentId" agent-id]
                   ["environment" environment] ["bridgeAgentVersion" bridge-agent-version]
                   ["authMode" auth-mode] ["authKind" auth-kind] ["authSubject" auth-subject]
                   ["tenantId" tenant-id] ["labels" labels] ["topology" topology] ["capabilities" capabilities]
                   ["health" health]
                   ["recentError" (when recent-error
                                    {"at" (:at recent-error) "code" (:code recent-error)
                                     "message" (:message recent-error) "retryable" (:retryable recent-error)})]
                   ["activeStreams" active-streams] ["queuedRequests" queued-requests]
                   ["lastHeartbeatSequence" last-heartbeat-sequence]]]
      (when-not (nil? v) (aset o k (clj->js v))))
    o))

(defn- js->identity [^js identity]
  {:auth-kind (.-authKind identity) :subject (.-subject identity) :tenant-id (.-tenantId identity)})

(defn- iter-result [value done?]
  (let [o (js-obj)] (aset o "value" value) (aset o "done" done?) o))

(defn- ws-channel
  "A BridgeSendChannel over a websocket; `ws` exposes the socket for listeners."
  [^js web-socket]
  (let [o (js-obj)]
    (aset o "send" (fn [data] (.send web-socket data)))
    (aset o "close" (fn [code reason] (.close web-socket (or code 1000) (or reason ""))))
    (aset o "ws" web-socket)
    (js/Object.defineProperty o "isOpen" #js {:get (fn [] (= (.-readyState web-socket) ws-open))})
    o))

;; ---------------------------------------------------------------------------
;; The relay
;; ---------------------------------------------------------------------------

(defn create-relay-js []
  (let [state (atom relay/empty-state)
        channels (js/Map.)
        streams (js/Map.)
        timers (js/Map.)
        ws-server (new (.-WebSocketServer ^js ws) #js {:noServer true})
        env (fn [extra] (merge {:now-ms (js/Date.now) :ids (vec (repeatedly 3 #(.randomUUID ^js crypto)))} extra))]
    (letfn [(clear-timer! [stream-id]
              (when-let [t (.get timers stream-id)] (js/clearTimeout t) (.delete timers stream-id)))
            (settle! [effects]
              (doseq [[kind w x] effects]
                (case kind
                  :resolve-event ((.-resolve ^js w) (iter-result (clj->js x) false))
                  :resolve-done ((.-resolve ^js w) (iter-result js/undefined true))
                  :reject ((.-reject ^js w) (js/Error. x)))))
            (with-stream! [stream-id f]
              (when-let [a (.get streams stream-id)]
                (let [[fx st] (f @a)] (reset! a st) (settle! fx))))
            (target [to reply]
              (if (= :reply to) reply (.get channels (:session to))))
            (run-fx! [{:keys [fx] :as e} reply]
              (case fx
                :send (.send ^js (target (:to e) reply) (protocol/encode-frame (:frame e)))
                :close (.close ^js reply (:code e) (:reason e))
                :register-channel (.set channels (:session-id e) reply)
                :unregister-channel (.delete channels (:session-id e))
                :register-stream (.set streams (:stream-id e) (atom stream/empty-stream))
                :arm-timer (.set timers (:stream-id e)
                                 (js/setTimeout (fn [] (commit! (relay/request-timed-out @state (:stream-id e)) nil))
                                                (:timeout-ms e)))
                :clear-timer (clear-timer! (:stream-id e))
                :stream-push (with-stream! (:stream-id e) #(stream/push % (:frame e)))
                :stream-end (do (with-stream! (:stream-id e) #(stream/finish % (:frame e)))
                                (.delete streams (:stream-id e)))
                :stream-fail (do (with-stream! (:stream-id e) #(stream/fail % (:message e)))
                                 (.delete streams (:stream-id e)))))
            (commit! [[effects state'] reply]
              (reset! state state')
              (doseq [e effects] (run-fx! e reply)))
            (handle-channel-message! [session-id text channel]
              (commit! (relay/handle-message @state session-id text (env nil)) channel))
            (handle-disconnect! [session-id]
              (commit! (relay/disconnect @state session-id (env nil)) nil))
            (accept-hello! [hello identity]
              (let [[ack state'] (relay/accept-hello @state (fed/js->wire hello) (js->identity identity) (env nil))]
                (reset! state state')
                ack))
            (handle-connection! [channel identity]
              (let [conn (atom {:session-id nil})
                    on-text (fn [text]
                              (let [[fx st conn'] (relay/handle-connection-message
                                                   @state @conn text (env {:identity (js->identity identity)}))]
                                (reset! conn conn')
                                (commit! [fx st] channel)))
                    fail! (fn [code message]
                            (commit! [(relay/connection-error (:session-id @conn) code message (env nil)) @state] channel))]
                (when-let [^js web-socket (.-ws ^js channel)]
                  (.on web-socket "message"
                       (fn [data binary?]
                         (if binary?
                           (do (fail! "bridge_binary_frames_not_supported"
                                      "binary websocket frames are not supported in bridge-ws-v0"))
                           (let [text (try (fed/ws-text data) (catch :default e (fail! "bridge_message_decode_failed" (str (ex-message e))) nil))]
                             (when text (on-text text))))))
                  (.on web-socket "close" (fn [] (handle-disconnect! (:session-id @conn)))))))
            (response-iterable [stream-id]
              (let [a (.get streams stream-id)
                    it (js-obj)
                    iterable (js-obj)]
                (aset it "next"
                      (fn []
                        (js/Promise.
                         (fn [resolve reject]
                           (let [[outcome st] (stream/pull @a #js {:resolve resolve :reject reject})]
                             (reset! a st)
                             (cond
                               (= :wait outcome) nil
                               (= :done outcome) (resolve (iter-result js/undefined true))
                               (:yield outcome) (resolve (iter-result (clj->js (:yield outcome)) false))
                               :else (reject (js/Error. (:fail outcome)))))))))
                (aset it "return"
                      (fn []
                        (let [[fx st] (relay/release-request @state stream-id)]
                          (reset! state st)
                          (doseq [e fx] (run-fx! e nil))
                          (let [[fx' st'] (stream/close @a)] (reset! a st') (settle! fx'))
                          (.delete streams stream-id)
                          (js/Promise.resolve (iter-result js/undefined true)))))
                (aset iterable js/Symbol.asyncIterator (fn [] it))
                iterable))
            (request-stream [session-id ^js input]
              (try
                (let [ch (.get channels session-id)
                      wire (fed/js->wire input)
                      [effects state' stream-id]
                      (relay/open-request @state session-id
                                          {:method (get wire "method") :path (get wire "path")
                                           :timeout-ms (.-timeoutMs input) :headers (get wire "headers")
                                           :body (get wire "body") :request-context (get wire "requestContext")
                                           :routing-intent (get wire "routingIntent")}
                                          (env {:channel-open? (boolean (and ch (.-isOpen ^js ch)))}))]
                  (reset! state state')
                  (doseq [e effects] (run-fx! e nil))
                  (response-iterable stream-id))
                (catch :default e (fed/rethrow-as-error e))))
            (request-json [session-id input]
              (let [events (request-stream session-id input)
                    status (atom 200) headers (atom #js {}) chunks (atom [])]
                (.then (fed/consume-async-iterable events
                                (fn [^js event]
                                  (case (.-type event)
                                    "response_head" (do (reset! status (.-status event)) (reset! headers (.-headers event)))
                                    "response_chunk" (swap! chunks conj
                                                            (if (= "base64" (.-encoding event))
                                                              (.toString (js/Buffer.from (.-chunk event) "base64") "utf8")
                                                              (.-chunk event)))
                                    nil)))
                       (fn [_]
                         (let [body (apply str @chunks)
                               json (try (if (pos? (count body)) (js/JSON.parse body) js/undefined)
                                         (catch :default _ js/undefined))]
                           #js {:status @status :headers @headers :body body :json json})))))]
      (let [o (js-obj)]
        (doseq [[k f] {"listSessions" (fn [] (to-array (map session->js (relay/list-sessions @state))))
                       "getSession" (fn [id] (if-let [s (relay/get-session @state id)] (session->js s) js/undefined))
                       "rejectUpgrade" (fn [^js socket status payload]
                                         (let [body (js/JSON.stringify payload)]
                                           (.write socket (relay/upgrade-rejection-text status body (js/Buffer.byteLength body)))
                                           (.destroy socket)))
                       "handleAuthorizedUpgrade" (fn [request socket head identity]
                                                   (.handleUpgrade ^js ws-server request socket head
                                                                   (fn [web-socket] (handle-connection! (ws-channel web-socket) identity))))
                       "close" (fn []
                                 (commit! (relay/close-all @state) nil)
                                 (doseq [client (js/Array.from (.-clients ^js ws-server))] (.close ^js client))
                                 (js/Promise. (fn [resolve _] (.close ^js ws-server (fn [] (resolve nil))))))
                       "requestStream" request-stream
                       "requestJson" request-json
                       "registerSseChannel" (fn [id channel] (.set channels id channel))
                       "unregisterChannel" (fn [id channel] (when (identical? (.get channels id) channel) (.delete channels id)))
                       "getChannel" (fn [id] (.get channels id))
                       "completeSseHello" (fn [hello identity channel]
                                            (let [ack (accept-hello! hello identity)]
                                              (.set channels (get ack "sessionId") channel)
                                              (clj->js ack)))
                       "handleChannelMessage" handle-channel-message!
                       "acceptHello" (fn [hello identity] (clj->js (accept-hello! hello identity)))
                       "handleDisconnect" handle-disconnect!}]
          (aset o k f))
        o))))
