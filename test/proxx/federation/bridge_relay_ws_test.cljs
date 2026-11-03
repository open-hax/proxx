(ns proxx.federation.bridge-relay-ws-test
  "src/tests/federation-bridge-relay.test.ts: the relay behind the application, over a real
  WebSocket and the /api/v1 session endpoints."
  (:require ["fastify" :as fastify]
            [cljs.test :refer [deftest is]]
            [proxx.host :as host]
            [proxx.runtime.host-support :as hs]))

(def ^:private admin "Bearer bridge-admin-token")

(defn- hello-frame [m]
  (merge {"type" "hello" "protocolVersion" "bridge-ws-v0" "peerDid" "did:web:local.promethean.rest"
          "environment" "local" "bridgeAgentVersion" "0.1.0" "authMode" "admin_key"}
         m))

(defn- ^:async with-bridge-app
  "A listening application (CLJS over the host) plus its upstream; `(f {:app :ws-url})`."
  [f]
  (let [{:keys [temp-dir paths]} (await (hs/create-fixture-dir "proxx-bridge-relay-test-" {}))]
    (try
      (await
       (hs/with-ok-upstream
         (fn ^:async run [port]
           (let [^js app (await (hs/create-app (hs/proxy-config port {:paths paths :auth-token "bridge-admin-token"})))
                 app-port (await (hs/listen-app app))]
             (try (await (f {:app app
                             :ws-url (str "ws://127.0.0.1:" app-port "/api/ui/federation/bridge/ws")}))
                  (finally (await (.close app))))))))
      (finally (await (hs/remove-dir temp-dir))))))

(defn- ^:async bridges [app auth path]
  (await (hs/inject app {:method "GET" :url (str "/api/v1/federation/bridges" path)
                         :headers {"authorization" auth}})))

(deftest ^:async relay-accepts-hello-over-websocket-and-exposes-the-session-over-http
  (await
   (with-bridge-app
     (fn ^:async run [{:keys [app ws-url]}]
       (let [^js ws (await (hs/open-websocket ws-url {"Authorization" admin}))]
         (.send ws (js/JSON.stringify
                    (clj->js (hello-frame {"sentAt" "2026-03-23T06:00:00.000Z" "traceId" "trace-hello-1"
                                           "ownerSubject" "did:plc:z72i7hdynmk6r22z27h6tvur" "clusterId" "local-dev"
                                           "agentId" "cluster-agent-1" "labels" ["bridge-test"]
                                           "topology" {"groups" [{"groupId" "group-a" "nodeIds" ["a1" "a2"]}]
                                                       "nodes" [{"groupId" "group-a" "nodeId" "a1" "labels" ["default"]}]
                                                       "defaultExecutionPolicy" "group_affinity"}}))))
         (let [ack (await (hs/next-json-message ws))
               session-id (get ack "sessionId")]
           (is (= "hello_ack" (get ack "type")))
           (is (= "bridge-ws-v0" (get ack "protocolVersion")))
           (is (string? session-id))
           (is (pos? (count (str session-id))))
           (let [list-response (await (bridges app admin ""))
                 sessions (get-in list-response [:json "sessions"])]
             (is (= 200 (:status list-response)))
             (is (= 1 (count sessions)))
             (is (= "local-dev" (get-in sessions [0 "clusterId"])))
             (is (= "cluster-agent-1" (get-in sessions [0 "agentId"])))
             (is (= "connected" (get-in sessions [0 "state"]))))
           (let [detail (await (bridges app admin (str "/" session-id)))]
             (is (= 200 (:status detail)))
             (is (= "did:web:local.promethean.rest" (get-in detail [:json "session" "peerDid"]))))
           (await (hs/close-websocket ws))
           (let [after (await (bridges app admin (str "/" session-id)))]
             (is (= 200 (:status after)))
             (is (= "disconnected" (get-in after [:json "session" "state"]))))))))))

(deftest ^:async relay-returns-a-typed-stub-error-for-request-execution-frames
  (await
   (with-bridge-app
     (fn ^:async run [{:keys [ws-url]}]
       (let [^js ws (await (hs/open-websocket ws-url {"Authorization" admin}))]
         (.send ws (js/JSON.stringify
                    (clj->js (hello-frame {"sentAt" "2026-03-23T06:01:00.000Z" "traceId" "trace-hello-2"
                                           "ownerSubject" "did:plc:z72i7hdynmk6r22z27h6tvur" "clusterId" "local-dev"
                                           "agentId" "cluster-agent-2" "labels" ["bridge-test"]}))))
         (let [ack (await (hs/next-json-message ws))]
           (.send ws (js/JSON.stringify
                      (clj->js {"type" "request_open" "protocolVersion" "bridge-ws-v0"
                                "sessionId" (get ack "sessionId") "streamId" "stream-1"
                                "sentAt" "2026-03-23T06:01:01.000Z" "traceId" "trace-request-open-1"
                                "ownerSubject" "did:plc:z72i7hdynmk6r22z27h6tvur" "clusterId" "local-dev"
                                "agentId" "cluster-agent-2" "method" "POST" "path" "/v1/chat/completions"
                                "headers" {"content-type" "application/json"}
                                "routingIntent" {"providerId" "openai" "model" "gpt-5.4-mini"}
                                "hopCount" 0})))
           (let [err (await (hs/next-json-message ws))]
             (is (= "error" (get err "type")))
             (is (= "bridge_execution_not_implemented" (get err "code")))
             (is (= (get ack "sessionId") (get err "sessionId")))
             (is (= "stream-1" (get err "streamId"))))
           (await (hs/close-websocket ws))))))))

(deftest ^:async bridge-websocket-http-route-requires-websocket-upgrade
  (await
   (with-bridge-app
     (fn ^:async run [{:keys [app]}]
       (let [response (await (hs/inject app {:method "GET" :url "/api/v1/federation/bridge/ws"
                                             :headers {"authorization" admin}}))]
         (is (= 426 (:status response)))
         (is (= "websocket" (get-in response [:headers "upgrade"])))
         (is (= {"error" "websocket_upgrade_required"} (:json response))))))))

;; ---- tenant scoped sessions -----------------------------------------------------------

(defn- ^:async with-tenant-scoped-bridge-ui-app
  "A bare Fastify with a hand-made auth hook (a legacy admin and a tenant admin) and only the
  bridge websocket and /api/v1 route bundles of the host, over real stores."
  [f]
  (let [{:keys [temp-dir paths]} (await (hs/create-fixture-dir "proxx-bridge-relay-tenant-test-" {}))]
    (try
      (await
       (hs/with-ok-upstream
         (fn ^:async run [port]
           (let [^js host host/host
                 ^js routes (.-routes host)
                 config (clj->js (hs/proxy-config port {:paths paths :auth-token "bridge-admin-token"}))
                 ^js server ((.-default fastify) #js {"logger" false})
                 _ (.decorateRequest server "openHaxAuth" nil)
                 _ (.addHook server "onRequest"
                             (fn ^:async on-request [^js request]
                               (let [authorization (let [a (aget (.-headers request) "authorization")]
                                                     (if (string? a) (.trim a) ""))]
                                 (cond
                                   (= authorization "Bearer bridge-admin-token")
                                   (aset request "openHaxAuth"
                                         #js {"kind" "legacy_admin" "tenantId" "default" "role" "owner" "source" "bearer"
                                              "subject" "legacy:proxy-auth-token"})
                                   (= authorization "Bearer tenant-admin-token")
                                   (aset request "openHaxAuth"
                                         #js {"kind" "ui_session" "tenantId" "tenant-a" "role" "admin" "source" "bearer"
                                              "userId" "user-tenant-a" "subject" "did:example:tenant-admin-a"
                                              "memberships" #js [#js {"tenantId" "tenant-a" "tenantName" "Tenant A"
                                                                      "tenantStatus" "active" "role" "admin"}]}))))
                             )
                 ^js key-pool (.keyPool host #js {"keysFilePath" (:keys-path paths) "reloadIntervalMs" 50
                                                  "defaultCooldownMs" 10000 "defaultProviderId" "vivgrid"})
                 _ (await (.warmup key-pool))
                 ^js credential-store (.credentialStore host (:keys-path paths) "vivgrid")
                 ^js request-log-store (.requestLogStore host (:request-logs-path paths) 1000 0)
                 _ (await (.warmup request-log-store))
                 ^js settings-store (.proxySettingsStore host (:settings-path paths))
                 _ (await (.warmup settings-store))
                 access-tokens {"tenant-admin-token"
                                #js {"token" "tenant-admin-token" "clientId" "test-client"
                                     "subject" "did:example:tenant-admin-a" "scopes" #js []
                                     "extra" #js {"activeTenantId" "tenant-a"}
                                     "expiresAt" (+ (js/Date.now) 60000)}}
                 sessions {"did:example:tenant-admin-a"
                           #js {"userId" "user-tenant-a" "subject" "did:example:tenant-admin-a"
                                "activeTenantId" "tenant-a" "role" "admin"
                                "memberships" #js [#js {"tenantId" "tenant-a" "tenantName" "Tenant A"
                                                        "tenantStatus" "active" "role" "admin"}]}}
                 auth-persistence #js {"getAccessToken" (fn [token] (js/Promise.resolve (get access-tokens token)))}
                 sql-credential-store #js {"resolveTenantApiKey" (fn [] (js/Promise.resolve js/undefined))
                                           "resolveUiSession" (fn [subject] (js/Promise.resolve (get sessions subject)))}
                 deps #js {"config" config "keyPool" key-pool "requestLogStore" request-log-store
                           "credentialStore" credential-store "sqlCredentialStore" sql-credential-store
                           "authPersistence" auth-persistence "proxySettingsStore" settings-store}
                 ^js registered (await (.registerWebSocketRoutes routes server deps))
                 _ (await (.registerApiV1Routes routes server
                                                (doto (js/Object.assign #js {} deps)
                                                  (aset "bridgeRelay" (.-bridgeRelay registered)))))
                 app-port (await (hs/listen-app server))]
             (try (await (f {:app server :ws-url (str "ws://127.0.0.1:" app-port "/api/ui/federation/bridge/ws")}))
                  (finally
                    (await (.close server))
                    (await (.close request-log-store))
                    (await (.close credential-store)))))))
       )
      (finally (await (hs/remove-dir temp-dir))))))

(defn- sessions-of [response] (get-in response [:json "sessions"]))

(deftest ^:async relay-list-and-detail-endpoints-scope-sessions-to-tenant-admins
  (await
   (with-tenant-scoped-bridge-ui-app
     (fn ^:async run [{:keys [app ws-url]}]
       (let [^js tenant-ws (await (hs/open-websocket ws-url {"Authorization" "Bearer tenant-admin-token"}))
             _ (.send tenant-ws (js/JSON.stringify
                                 (clj->js (hello-frame {"sentAt" "2026-03-23T06:10:00.000Z" "traceId" "trace-tenant-a-hello"
                                                        "ownerSubject" "did:plc:tenant-a-owner" "clusterId" "tenant-a-cluster"
                                                        "agentId" "tenant-a-agent" "peerDid" "did:web:tenant-a.promethean.rest"
                                                        "labels" ["tenant-a"]}))))
             tenant-ack (await (hs/next-json-message tenant-ws))
             ^js global-ws (await (hs/open-websocket ws-url {"Authorization" admin}))
             _ (.send global-ws (js/JSON.stringify
                                 (clj->js (hello-frame {"sentAt" "2026-03-23T06:10:01.000Z" "traceId" "trace-default-hello"
                                                        "ownerSubject" "did:plc:default-owner" "clusterId" "default-cluster"
                                                        "agentId" "default-agent" "peerDid" "did:web:default.promethean.rest"
                                                        "labels" ["default"]}))))
             global-ack (await (hs/next-json-message global-ws))
             tenant-session (get tenant-ack "sessionId")
             global-session (get global-ack "sessionId")
             tenant-auth "Bearer tenant-admin-token"]
         (let [r (await (bridges app admin ""))]
           (is (= 200 (:status r)))
           (is (= 2 (count (sessions-of r)))))
         (let [r (await (bridges app tenant-auth ""))]
           (is (= 200 (:status r)))
           (is (= 1 (count (sessions-of r))))
           (is (= tenant-session (get-in (sessions-of r) [0 "sessionId"])))
           (is (= "connected" (get-in (sessions-of r) [0 "state"]))))
         (is (= 200 (:status (await (bridges app tenant-auth (str "/" tenant-session))))))
         (is (= 404 (:status (await (bridges app tenant-auth (str "/" global-session))))))
         (await (hs/close-websocket tenant-ws))
         (await (hs/close-websocket global-ws))
         (let [r (await (bridges app admin ""))]
           (is (= 200 (:status r)))
           (is (= 2 (count (sessions-of r))))
           (is (every? #(= "disconnected" (get % "state")) (sessions-of r))))
         (let [r (await (bridges app tenant-auth ""))]
           (is (= 200 (:status r)))
           (is (= 1 (count (sessions-of r))))
           (is (= tenant-session (get-in (sessions-of r) [0 "sessionId"])))
           (is (= "disconnected" (get-in (sessions-of r) [0 "state"]))))
         (is (= 404 (:status (await (bridges app tenant-auth (str "/" global-session)))))))))))
