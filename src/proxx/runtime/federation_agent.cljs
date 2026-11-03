(ns proxx.runtime.federation-agent
  "Edge of the bridge agent: the websocket, the timers and the request handler.

  Every decision (what to say, what to remember, when to back off) is a pure
  transition in proxx.federation.agent. This namespace owns the atom with the
  agent state, feeds socket events to the transitions and interprets the
  effects they return, in order. The JS facade keeps the method names of the
  former TypeScript class: snapshot(), start(), stop()."
  (:require ["node:crypto" :as crypto]
            ["ws" :as ws]
            [proxx.federation.agent :as agent]
            [proxx.federation.protocol :as protocol]
            [proxx.runtime.federation :as fed]))

(def ^:private ws-connecting 0)
(def ^:private ws-open 1)

(defn- or-undefined [x] (if (nil? x) js/undefined x))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (str e)))

(defn- js->opts [^js o]
  {:owner-subject (.-ownerSubject o) :peer-did (.-peerDid o) :cluster-id (.-clusterId o) :agent-id (.-agentId o)
   :environment (.-environment o) :bridge-agent-version (.-bridgeAgentVersion o) :auth-mode (.-authMode o)
   :labels (fed/js->wire (.-labels o)) :topology (fed/js->wire (.-topology o))
   :capabilities-hash (.-capabilitiesHash o)
   :reconnect-min-ms (.-reconnectMinMs o) :reconnect-max-ms (.-reconnectMaxMs o)})

(defn- snapshot->js [{:keys [state session-id connected-at last-sent-at last-received-at last-error reconnect-attempt]}]
  (let [o (js-obj)]
    (aset o "state" (name state))
    (aset o "sessionId" (or-undefined session-id))
    (aset o "connectedAt" (or-undefined connected-at))
    (aset o "lastSentAt" (or-undefined last-sent-at))
    (aset o "lastReceivedAt" (or-undefined last-received-at))
    (aset o "lastError" (if last-error
                          #js {:code (:code last-error) :message (:message last-error)
                               :retryable (:retryable last-error) :at (:at last-error)}
                          js/undefined))
    (aset o "reconnectAttempt" reconnect-attempt)
    o))

(defn create-agent-js [^js options]
  (let [opts (js->opts options)
        state (atom agent/initial-state)
        socket (atom nil)
        heartbeat-timer (atom nil)
        reconnect-timer (atom nil)
        start-promise (atom nil)
        open? (fn [^js w] (= (.-readyState w) ws-open))
        env (fn [w] {:now-ms (js/Date.now) :trace-id (.randomUUID ^js crypto) :ws-open? (open? w)})
        handshake-deadline (or (.-handshakeDeadlineMs options) agent/default-handshake-deadline-ms)]
    (letfn [(transition! [f w & args]
              (let [[fx st] (apply f @state opts (env w) args)] (reset! state st) fx))
            (record! [code message retryable]
              (swap! state agent/record-error {:code code :message message :retryable retryable} {:now-ms (js/Date.now)}))
            (clear-heartbeat! []
              (when-let [t @heartbeat-timer] (js/clearInterval t) (reset! heartbeat-timer nil)))
            (clear-reconnect! []
              (when-let [t @reconnect-timer] (js/clearTimeout t) (reset! reconnect-timer nil)))
            (send! [^js w frame] (.send w (protocol/encode-frame frame)))
            (run-sends! [fx w] (doseq [e fx] (when (= :send (:fx e)) (send! w (:frame e)))))
            (publish-snapshot! [^js w]
              (if-not (and (:session-id @state) (open? w))
                (js/Promise.resolve nil)
                (do
                  (run-sends! (transition! agent/heartbeat-frame w) w)
                  (-> (js/Promise.resolve (if-let [f (.-getCapabilities options)] (f) #js []))
                      (.then (fn [caps]
                               (run-sends! (transition! agent/capabilities-frame w (or (fed/js->wire caps) [])) w)
                               (js/Promise.resolve (if-let [f (.-getHealth options)] (f) js/undefined))))
                      (.then (fn [health]
                               (run-sends! (transition! agent/health-frame w (fed/js->wire health)) w)))))))
            (start-heartbeat! [^js w interval-ms]
              (clear-heartbeat!)
              (reset! heartbeat-timer
                      (js/setInterval
                       (fn [] (-> (publish-snapshot! w)
                                  (.catch (fn [e] (record! "bridge_publish_failed" (error-message e) true)))))
                       interval-ms)))
            (schedule-reconnect! []
              (let [[fx st] (agent/schedule-reconnect @state opts)]
                (reset! state st)
                (doseq [e fx]
                  (case (:fx e)
                    :clear-reconnect (clear-reconnect!)
                    :arm-reconnect (reset! reconnect-timer
                                           (js/setTimeout
                                            (fn [] (when-not (:stopped? @state)
                                                     (reset! start-promise (.catch (connect! true) (fn [_] nil)))))
                                            (:delay-ms e)))))))
            (handle-request! [^js w frame body-text]
              (if-not (and (:session-id @state) (open? w))
                (js/Promise.resolve nil)
                (let [stream-id (get frame "streamId")
                      handler (.-handleRequest options)]
                  (if-not handler
                    (js/Promise.resolve
                     (run-sends! (transition! agent/send-error w
                                              {:stream-id stream-id :code "bridge_request_handler_missing"
                                               :message (str "bridge agent has no request handler for " (get frame "method") " " (get frame "path"))
                                               :retryable false})
                                 w))
                    (-> (js/Promise.resolve (handler #js {:request (clj->js frame) :bodyText body-text}))
                        (.then (fn [result]
                                 (if (fn? (aget result js/Symbol.asyncIterator))
                                   (let [stream (atom agent/initial-stream)]
                                     (-> (fed/consume-async-iterable
                                          result
                                          (fn [event]
                                            (if-not (and (:session-id @state) (open? w))
                                              :stop
                                              (let [[fx st stream'] (agent/stream-event @state opts (env w) stream-id @stream (fed/js->wire event))]
                                                (reset! state st) (reset! stream stream')
                                                (run-sends! fx w)
                                                nil))))
                                         (.then (fn [outcome]
                                                  (when-not (= :stopped outcome)
                                                    (let [[fx st] (agent/stream-finish @state opts (env w) stream-id @stream)]
                                                      (reset! state st)
                                                      (run-sends! fx w)))))))
                                   (let [[fx st] (agent/buffered-response @state opts (env w) stream-id (fed/js->wire result))]
                                     (reset! state st)
                                     (run-sends! fx w)))))
                        (.catch (fn [e]
                                  (run-sends! (transition! agent/send-error w
                                                           {:stream-id stream-id :code "bridge_request_failed"
                                                            :message (error-message e) :retryable true})
                                              w))))))))
            (run-effects! [fx w on-connected]
              (reduce (fn [p e]
                        (.then p (fn [_]
                                   (case (:fx e)
                                     :send (send! w (:frame e))
                                     :publish-snapshot (publish-snapshot! w)
                                     :start-heartbeat (start-heartbeat! w (:interval-ms e))
                                     :connected (on-connected)
                                     :handle-request (handle-request! w (:request e) (:body-text e))
                                     nil))))
                      (js/Promise.resolve nil) fx))
            (connect! [reconnect?]
              (swap! state agent/begin-connect reconnect?)
              (let [auth (.-authorization options)
                    headers (js-obj)
                    _ (when (and (string? auth) (seq (.trim auth))) (aset headers "authorization" (.trim auth)))
                    ^js w (new (.-WebSocket ^js ws) (.-relayUrl options) #js {:headers headers})]
                (reset! socket w)
                (js/Promise.
                 (fn [resolve reject]
                   (let [settled? (atom false) hello-ack? (atom false) handshake-timer (atom nil)
                         clear-handshake! (fn [] (when-let [t @handshake-timer] (js/clearTimeout t) (reset! handshake-timer nil)))
                         settle-resolve (fn [] (when-not @settled? (clear-handshake!) (reset! settled? true) (resolve nil)))
                         settle-reject (fn [e] (when-not @settled? (clear-handshake!) (reset! settled? true) (reject e)))]
                     (.once w "open"
                            (fn []
                              (let [[frame st] (agent/hello-frame @state opts (env w))]
                                (reset! state st)
                                (send! w frame)
                                (reset! handshake-timer
                                        (js/setTimeout
                                         (fn []
                                           (let [[message st] (agent/handshake-timeout @state handshake-deadline (env w))]
                                             (reset! state st)
                                             (.close w 1008 "hello_ack timeout")
                                             (settle-reject (js/Error. message))))
                                         handshake-deadline)))))
                     (.on w "message"
                          (fn [data binary?]
                            (if binary?
                              (do (record! "bridge_binary_frames_not_supported"
                                           "binary websocket frames are not supported in bridge-ws-v0" false)
                                  (.close w 1003 "binary frames not supported")
                                  (settle-reject (js/Error. "binary websocket frames are not supported in bridge-ws-v0")))
                              (let [on-error (fn [e]
                                               (record! "bridge_message_invalid" (error-message e) false)
                                               (.close w 1008 "invalid bridge message")
                                               (settle-reject e))]
                                (try
                                  (let [parsed (protocol/parse-message-json (fed/ws-text data))]
                                    (-> (run-effects! (transition! agent/on-message w parsed) w
                                                      (fn [] (reset! hello-ack? true) (settle-resolve)))
                                        (.catch on-error)))
                                  (catch :default e (on-error e)))))))
                     (.on w "error"
                          (fn [e]
                            (clear-handshake!)
                            (record! "bridge_socket_error" (error-message e) true)
                            (settle-reject e)))
                     (.on w "close"
                          (fn []
                            (clear-handshake!)
                            (clear-heartbeat!)
                            (reset! socket nil)
                            (when-not (:stopped? @state) (schedule-reconnect!))
                            (when (and (not @settled?) (not @hello-ack?))
                              (settle-reject (js/Error. "bridge socket closed before hello_ack"))))))))))]
      (let [o (js-obj)]
        (aset o "snapshot" (fn [] (snapshot->js @state)))
        (aset o "start"
              (fn []
                (swap! state agent/start)
                (if (contains? #{:connected :connecting} (:state @state))
                  (or @start-promise (js/Promise.resolve nil))
                  (do (clear-reconnect!)
                      (reset! start-promise (connect! false))
                      (-> @start-promise
                          (.catch (fn [e]
                                    (record! "bridge_initial_connection_failed" (error-message e) true)
                                    (when-not (:stopped? @state) (schedule-reconnect!)))))))))
        (aset o "stop"
              (fn []
                (swap! state agent/stop)
                (clear-heartbeat!)
                (clear-reconnect!)
                (let [^js w @socket]
                  (reset! socket nil)
                  (cond
                    (and w (= (.-readyState w) ws-open))
                    (js/Promise. (fn [resolve _] (.once w "close" (fn [] (resolve nil))) (.close w)))
                    (and w (= (.-readyState w) ws-connecting)) (do (.terminate w) (js/Promise.resolve nil))
                    :else (js/Promise.resolve nil)))))
        o))))
