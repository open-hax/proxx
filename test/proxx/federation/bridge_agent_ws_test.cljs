(ns proxx.federation.bridge-agent-ws-test
  "src/tests/federation-bridge-agent.test.ts: the bridge agent against a real relay (behind the
  application, behind a bare relay, and behind a server that never answers the hello)."
  (:require ["node:http" :as http]
            ["ws" :as ws]
            [cljs.test :refer [deftest is]]
            [proxx.runtime.federation-agent :as agent-edge]
            [proxx.runtime.federation-relay :as relay-edge]
            [proxx.runtime.host-support :as hs]))

(def ^:private admin "Bearer bridge-admin-token")

(defn- ^:async with-bridge-app [f]
  (let [{:keys [temp-dir paths]} (await (hs/create-fixture-dir "proxx-bridge-agent-test-" {}))]
    (try
      (await
       (hs/with-ok-upstream
         (fn ^:async run [port]
           (let [^js app (await (hs/create-app (hs/proxy-config port {:paths paths :auth-token "bridge-admin-token"})))
                 app-port (await (hs/listen-app app))]
             (try (await (f {:app app :ws-url (str "ws://127.0.0.1:" app-port "/api/ui/federation/bridge/ws")}))
                  (finally (await (.close app))))))))
      (finally (await (hs/remove-dir temp-dir))))))

(defn- ^:async sessions [app]
  (let [response (await (hs/inject app {:method "GET" :url "/api/v1/federation/bridges"
                                        :headers {"authorization" admin}}))]
    (is (= 200 (:status response)))
    (get-in response [:json "sessions"])))

(defn- async-iterable
  "A JS async iterable over the plain-data `events` (what a streaming request handler returns)."
  [events]
  (let [o #js {}]
    (aset o js/Symbol.asyncIterator
          (fn []
            (let [remaining (atom events)]
              #js {"next" (fn []
                            (js/Promise.resolve
                             (if-let [e (first @remaining)]
                               (do (swap! remaining rest) #js {"done" false "value" (clj->js e)})
                               #js {"done" true "value" js/undefined})))})))
    o))

(def ^:private base-agent
  {:authorization admin :ownerSubject "did:plc:z72i7hdynmk6r22z27h6tvur" :peerDid "did:web:local.promethean.rest"
   :clusterId "local-dev" :environment "local" :bridgeAgentVersion "0.1.0" :authMode "admin_key"})

(defn- new-agent [overrides] (agent-edge/create-agent-js (clj->js (merge base-agent overrides))))

(deftest ^:async agent-connects-publishes-capabilities-health-and-stops-cleanly
  (await
   (with-bridge-app
     (fn ^:async run [{:keys [app ws-url]}]
       (let [^js agent (new-agent
                        {:relayUrl ws-url :agentId "cluster-agent-1" :labels ["agent-test"]
                         :topology {:groups [{:groupId "group-a" :nodeIds ["a1" "a2"]}]
                                    :nodes [{:groupId "group-a" :nodeId "a1" :labels ["default"]}]
                                    :defaultExecutionPolicy "group_affinity"}
                         :getCapabilities
                         (fn [] (js/Promise.resolve
                                 (clj->js [{:providerId "openai" :modelPrefixes ["gpt-"] :models ["gpt-5.4-mini"]
                                            :authType "oauth_bearer" :accountCount 4 :availableAccountCount 3
                                            :supportsModelsList true :supportsChatCompletions true
                                            :supportsResponses true :supportsStreaming true :supportsWarmImport false
                                            :credentialMobility "access_token_only" :credentialOrigin "localhost_oauth"
                                            :lastHealthyAt "2026-03-23T06:10:00.000Z"
                                            :topologyTargets [{:groupId "group-a" :nodeId "a1"}]}])))
                         :getHealth
                         (fn [] (js/Promise.resolve
                                 (clj->js {:processHealthy true :upstreamHealthy true :availableAccountCount 3
                                           :localOauthBootstrapReady true :queuedRequests 0
                                           :nodes [{:groupId "group-a" :nodeId "a1" :reachable true
                                                    :lastHealthyAt "2026-03-23T06:10:00.000Z"}]})))
                         :reconnectMinMs 100 :reconnectMaxMs 250})]
         (await (.start agent))
         (await (hs/wait-for
                 (fn ^:async check []
                   (let [ss (await (sessions app))
                         s (first ss)]
                     (and (= 1 (count ss))
                          (= "connected" (get s "state"))
                          (vector? (get s "capabilities"))
                          (= 1 (count (get s "capabilities")))
                          (map? (get s "health"))
                          (= "cluster-agent-1" (get s "agentId")))))))
         (let [^js connected (.snapshot agent)]
           (is (= "connected" (.-state connected)))
           (is (some? (.-sessionId connected)))
           (is (= 0 (.-reconnectAttempt connected))))
         (await (.stop agent))
         (await (hs/wait-for (fn ^:async check [] (= "disconnected" (get (first (await (sessions app))) "state")))))
         (is (= "stopped" (.-state ^js (.snapshot agent)))))))))

(deftest ^:async agent-times-out-the-hello-handshake-and-retries-in-the-background
  (let [^js server (.createServer http)
        ^js ws-server (new (.-WebSocketServer ^js ws) #js {:noServer true})]
    (.on server "upgrade"
         (fn [request socket head]
           (.handleUpgrade ws-server request socket head
                           (fn [^js web-socket]
                             ;; Intentionally never send hello_ack.
                             (.on web-socket "message" (fn [] nil))))))
    (let [port (await (hs/listen-server server))
          ^js agent (new-agent {:relayUrl (str "ws://127.0.0.1:" port) :agentId "cluster-agent-timeout"
                                :handshakeDeadlineMs 50 :reconnectMinMs 25 :reconnectMaxMs 50})]
      (try
        (await (.start agent))
        (await (hs/wait-for (fn [] (= "bridge_hello_ack_timeout" (some-> ^js (.snapshot agent) .-lastError .-code))) 1000))
        (let [^js snapshot (.snapshot agent)]
          (is (= "bridge_hello_ack_timeout" (.-code ^js (.-lastError snapshot))))
          (is (not= "connected" (.-state snapshot))))
        (finally
          (await (.stop agent))
          (await (js/Promise. (fn [resolve _] (.close ws-server (fn [] (resolve nil))))))
          (await (hs/close-server server)))))))

(deftest ^:async relay-request-stream-preserves-streamed-chunks-and-provenance-from-the-agent
  (let [^js relay (relay-edge/create-relay-js)
        ^js server (.createServer http)
        provenance (fn [node account] {:servedByClusterId "local-dev" :servedByGroupId "group-a" :servedByNodeId node
                                       :providerId "openai" :accountId account})]
    (.on server "upgrade"
         (fn [request socket head]
           (.handleAuthorizedUpgrade relay request socket head
                                     #js {"authKind" "legacy_admin" "subject" "bridge-admin-token" "tenantId" "default"})))
    (let [port (await (hs/listen-server server))
          ^js agent (new-agent
                     {:relayUrl (str "ws://127.0.0.1:" port) :agentId "cluster-agent-streaming"
                      :reconnectMinMs 25 :reconnectMaxMs 50
                      :handleRequest
                      (fn []
                        (js/Promise.resolve
                         (async-iterable
                          [(merge {:type "response_head" :status 200
                                   :headers {"content-type" "text/event-stream; charset=utf-8"}}
                                  (provenance "a2" "acct-stream-1"))
                           (merge {:type "response_chunk" :chunk "data: hello\n\n" :encoding "utf8"}
                                  (provenance "a2" "acct-stream-1"))
                           (merge {:type "response_chunk" :chunk "data: [DONE]\n\n" :encoding "utf8"}
                                  (provenance "a3" "acct-stream-2"))
                           (merge {:type "response_end"} (provenance "a3" "acct-stream-2"))])))})]
      (try
        (await (.start agent))
        (await (hs/wait-for (fn [] (some #(= "connected" (.-state ^js %)) (array-seq (.listSessions relay)))) 1000))
        (let [session-id (.-sessionId ^js (aget (.listSessions relay) 0))
              _ (is (some? session-id))
              ^js stream (.requestStream relay session-id
                                         #js {"method" "POST" "path" "/v1/chat/completions" "timeoutMs" 1000
                                              "headers" #js {"accept" "text/event-stream" "content-type" "application/json"}
                                              "body" (js/JSON.stringify #js {"model" "gpt-5.4-mini" "stream" true})})
              ^js iterator ((aget stream js/Symbol.asyncIterator))
              events (loop [acc []]
                       (let [^js step (await (.next iterator))]
                         (if (.-done step)
                           acc
                           (let [^js event (.-value step)]
                             (recur (conj acc {:type (.-type event) :servedByNodeId (.-servedByNodeId event)
                                               :accountId (.-accountId event)
                                               :chunk (when (= "response_chunk" (.-type event)) (.-chunk event))}))))))]
          (is (= ["response_head" "response_chunk" "response_chunk" "response_end"] (mapv :type events)))
          (is (= "a2" (:servedByNodeId (events 1))))
          (is (= "a3" (:servedByNodeId (events 2))))
          (is (= "acct-stream-2" (:accountId (events 2))))
          (is (= "data: hello\n\n" (:chunk (events 1)))))
        (finally
          (await (.stop agent))
          (await (.close relay))
          (await (hs/close-server server)))))))
