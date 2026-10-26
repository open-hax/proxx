(ns proxx.runtime.routes.streams
  "Server-sent-event routes of the control plane: the request-log stream and the
  federation bridge's SSE transport (src/routes/api/ui/{request-log-sse,bridge-sse}).

  The handler writes the head and then hands the response to the hub/relay;
  what to write and who may bind is proxx.http.streams. The route returns
  {:streamed? true} so the Ring adapter sends nothing more."
  (:require [proxx.http.guard :as guard]
            [proxx.http.streams :as streams]
            [proxx.http.ui-auth :as ui-auth]
            [proxx.runtime.federation :as fed]
            [proxx.runtime.ring :as ring]
            [proxx.runtime.route-auth :as route-auth]))

(defn- start-sse!
  "Write the SSE head on the raw response and return it."
  [^js reply]
  (let [^js res (.-raw reply)]
    (.writeHead res 200 (clj->js streams/sse-headers))
    (.flushHeaders res)
    res))

(defn- keep-alive!
  "A comment frame every 15 s until either side closes."
  [^js res ^js req]
  (let [timer (atom nil)
        stop! (fn [] (js/clearInterval @timer))]
    (reset! timer (js/setInterval
                   (fn []
                     (if (.-writableEnded res)
                       (stop!)
                       (try (.write res streams/keepalive-frame)
                            (catch :default _ (stop!)))))
                   streams/keepalive-interval-ms))
    (.on res "close" stop!)
    (.on ^js (.-raw req) "close" stop!)))

(defn- trimmed-query [query k]
  (let [v (get query k)] (when (string? v) (.trim v))))

;; ---------------------------------------------------------------------------
;; Request-log SSE
;; ---------------------------------------------------------------------------

(defn request-log-routes
  "deps: {:auth-deps (see route-auth) :request-log-sse-hub}."
  [{:keys [auth-deps ^js request-log-sse-hub]}]
  [{:method :get :path "/api/v1/federation/observability/sse"
    :handler (fn ^:async request-log-sse [{:keys [headers query reply raw]}]
               (let [auth (await (route-auth/resolve-control-auth auth-deps (get headers "authorization") (get headers "cookie")))]
                 (cond
                   (nil? auth) (guard/error 401 "unauthorized")
                   (not (ui-auth/can-manage-federation? auth)) (guard/error 403 "forbidden")
                   :else
                   (let [identity (streams/identity-of auth false)
                         subscription (streams/request-log-subscription (get query "ownerSubject") (get query "routeKind"))
                         res (start-sse! reply)]
                     (.addClient request-log-sse-hub res (clj->js identity) (clj->js subscription))
                     (keep-alive! res raw)
                     {:streamed? true}))))}])

;; ---------------------------------------------------------------------------
;; Bridge SSE
;; ---------------------------------------------------------------------------

(defn- ^:async bridge-identity
  "The identity allowed to use the bridge endpoints, or nil (not authenticated
  and not a federation manager are the same answer here)."
  [auth-deps headers]
  (let [auth (await (route-auth/resolve-control-auth auth-deps (get headers "authorization") (get headers "cookie")))]
    (when (and auth (ui-auth/can-manage-federation? auth))
      (streams/identity-of auth true))))

(defn- session-facts [^js session]
  {:authSubject (.-authSubject session) :tenantId (.-tenantId session)})

(defn- body-text
  "The JSON text of a request body: a string as it came, an object serialized;
  nil for anything else (including an absent or empty body)."
  [^js raw]
  (let [body (.-body raw)]
    (cond (string? body) body
          (and body (= "object" (js* "typeof ~{}" body))) (js/JSON.stringify body)
          :else nil)))

(defn- err-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- parse-body
  "[parsed nil] or [nil error-response] for the body of a bridge POST."
  [raw]
  (if-let [text (body-text raw)]
    (try [(fed/parse-bridge-message-json-js text) nil text]
         (catch :default e
           [nil {:status 400 :body {"error" "invalid_message" "message" (err-message e)}}]))
    [nil {:status 400 :body {"error" "invalid_body" "message" "request body must be JSON"}}]))

(defn- authorized-session
  "[session nil] or [nil error-response] for a session id the identity may use."
  [^js relay identity session-id missing-message]
  (let [^js session (.getSession relay session-id)]
    (cond
      (or (not session) (not= "connected" (.-state session)))
      [nil {:status 404 :body {"error" "session_not_found" "message" (str "session " session-id " " missing-message)}}]
      (not (streams/can-access-session? identity (session-facts session)))
      [nil {:status 403 :body {"error" "forbidden" "message" (str "session " session-id " does not belong to the current identity")}}]
      :else [session nil])))

(defn bridge-routes
  "deps: {:auth-deps :bridge-relay}."
  [{:keys [auth-deps ^js bridge-relay]}]
  [{:method :get :path "/api/ui/federation/bridge/sse"
    :handler (fn ^:async bridge-sse [{:keys [headers query reply raw]}]
               (if-let [identity (await (bridge-identity auth-deps headers))]
                 (let [session-id (not-empty (trimmed-query query "sessionId"))
                       [_ failure] (when session-id (authorized-session bridge-relay identity session-id "not found or not connected"))]
                   (or failure
                       (let [res (start-sse! reply)
                             channel (fed/create-sse-bridge-send-channel-js res)]
                         (if session-id
                           (do (.registerSseChannel bridge-relay session-id channel)
                               (.write res (streams/sse-open-frame session-id (.toISOString (js/Date.))))
                               (.on res "close" (fn [] (.unregisterChannel bridge-relay session-id channel))))
                           (.write res (streams/sse-open-frame nil (.toISOString (js/Date.)))))
                         (keep-alive! res raw)
                         {:streamed? true})))
                 (guard/error 401 "unauthorized")))}

   {:method :post :path "/api/ui/federation/bridge/sse/hello"
    :handler (fn ^:async bridge-hello [{:keys [headers raw]}]
               (if-let [identity (await (bridge-identity auth-deps headers))]
                 (let [[parsed failure] (parse-body raw)]
                   (cond
                     failure failure
                     (not= "hello" (.-type ^js parsed))
                     {:status 400 :body {"error" "invalid_message_type" "message" "this endpoint only accepts hello messages"}}
                     :else
                     (let [^js ack (.acceptHello bridge-relay parsed (clj->js identity))]
                       {:body #js {:type "hello_ack"
                                   :protocolVersion (.-protocolVersion ack)
                                   :sessionId (.-sessionId ack)
                                   :sentAt (.-sentAt ack)
                                   :traceId (.-traceId ack)
                                   :ownerSubject (.-ownerSubject ack)
                                   :clusterId (.-clusterId ack)
                                   :agentId (.-agentId ack)
                                   :heartbeatIntervalMs (.-heartbeatIntervalMs ack)
                                   :maxConcurrentStreams (.-maxConcurrentStreams ack)
                                   :maxFrameBytes (.-maxFrameBytes ack)
                                   :sseReconnectUrl (str "/api/ui/federation/bridge/sse?sessionId=" (.-sessionId ack))}})))
                 (guard/error 401 "unauthorized")))}

   {:method :post :path "/api/ui/federation/bridge/sse/message"
    :handler (fn ^:async bridge-message [{:keys [headers raw]}]
               (if-let [identity (await (bridge-identity auth-deps headers))]
                 (let [header (get headers "x-bridge-session-id")
                       session-id (when (string? header) (not-empty (.trim header)))]
                   (if-not session-id
                     {:status 400 :body {"error" "missing_session_id" "message" "x-bridge-session-id header required"}}
                     (let [[_ failure] (authorized-session bridge-relay identity session-id "not found or disconnected")]
                       (or failure
                           (let [[parsed failure text] (parse-body raw)]
                             (cond
                               failure failure
                               (= "hello" (.-type ^js parsed))
                               {:status 400 :body {"error" "duplicate_hello" "message" "use /api/ui/federation/bridge/sse/hello for initial hello"}}
                               :else
                               (let [^js channel (.getChannel bridge-relay session-id)]
                                 (if (or (not channel) (not (.-isOpen channel)))
                                   {:status 410 :body {"error" "channel_not_found" "message" (str "session " session-id " has no active SSE channel")}}
                                   (do (.handleChannelMessage bridge-relay session-id text channel)
                                       {:body {"type" "ack" "sessionId" session-id "sentAt" (.toISOString (js/Date.))}})))))))))
                 (guard/error 401 "unauthorized")))}])

(defn- auth-deps-of [^js deps]
  {:proxy-auth-token (.-proxyAuthToken deps)
   :sql-credential-store (.-sqlCredentialStore deps)
   :auth-persistence (.-authPersistence deps)
   :pepper (.-proxyTokenPepper deps)
   :default-tenant-id (.-defaultTenantId deps)})

(defn register-request-log-sse-routes-js
  "deps: {proxyAuthToken, sqlCredentialStore?, authPersistence?, proxyTokenPepper, defaultTenantId};
  `hub` is the request-log SSE hub."
  [app ^js deps ^js hub]
  (ring/register! app (request-log-routes {:auth-deps (auth-deps-of deps) :request-log-sse-hub hub})))

(defn register-bridge-sse-routes-js
  [app ^js deps ^js relay]
  (ring/register! app (bridge-routes {:auth-deps (auth-deps-of deps) :bridge-relay relay})))
