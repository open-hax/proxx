(ns proxx.federation.bridge-autostart-app-test
  "src/tests/federation-bridge-autostart.test.ts: the application auto-starts its federation
  bridge agent from the environment and shows up as a session on a second application's relay."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.host-support :as hs]))

(def ^:private admin "Bearer bridge-admin-token")

(defn- ^:async sessions [^js relay-app]
  (let [response (await (hs/inject relay-app {:method "GET" :url "/api/v1/federation/bridges"
                                              :headers {"authorization" admin}}))]
    (is (= 200 (:status response)))
    (get-in response [:json "sessions"])))

(deftest ^:async create-app-auto-starts-the-federation-bridge-agent-from-env
  (let [relay-fixture (await (hs/create-fixture-dir "proxx-bridge-autostart-relay-" {}))
        local-fixture (await (hs/create-fixture-dir "proxx-bridge-autostart-local-" {}))
        local-app (atom nil)
        relay-app (atom nil)]
    (try
      (await
       (hs/with-ok-upstream
         (fn ^:async run [port]
           (try
             (reset! relay-app (await (hs/create-app (hs/proxy-config port {:paths (:paths relay-fixture)
                                                                            :auth-token "bridge-admin-token"}))))
             (let [^js relay @relay-app
                   relay-port (await (hs/listen-app relay))]
               (await
                (hs/with-env
                  {"FEDERATION_BRIDGE_RELAY_URL" (str "ws://127.0.0.1:" relay-port "/api/ui/federation/bridge/ws")
                   "FEDERATION_BRIDGE_AUTH_TOKEN" "bridge-admin-token"
                   "FEDERATION_BRIDGE_AGENT_ID" "local-cluster-agent"
                   "FEDERATION_DEFAULT_OWNER_SUBJECT" "did:plc:z72i7hdynmk6r22z27h6tvur"
                   "FEDERATION_SELF_PEER_DID" "did:web:local.promethean.rest"
                   "FEDERATION_SELF_CLUSTER_ID" "local-dev"
                   "FEDERATION_SELF_GROUP_ID" "group-a"
                   "FEDERATION_SELF_NODE_ID" "a1"
                   "FEDERATION_BRIDGE_LABELS" "auto-start,local"
                   "FEDERATION_BRIDGE_NODE_LABELS" "default"
                   "FEDERATION_BRIDGE_DEFAULT_EXECUTION_POLICY" "node_affinity"
                   "FEDERATION_BRIDGE_ENVIRONMENT" "local"}
                  (fn ^:async with-agent-env []
                    (reset! local-app (await (hs/create-app (hs/proxy-config port {:paths (:paths local-fixture)
                                                                                   :auth-token "local-admin-token"}))))
                    (await (hs/listen-app @local-app))
                    ;; wait for the agent to announce itself to the relay (state-based, not timing-based)
                    (await (hs/wait-for (fn ^:async check [] (some #(= "connected" (get % "state")) (await (sessions relay))))
                                        5000))
                    (let [connected (await (sessions relay))]
                      (is (= 1 (count connected)))
                      (is (= "local-cluster-agent" (get-in connected [0 "agentId"])))
                      (is (= "local-dev" (get-in connected [0 "clusterId"])))
                      (is (= "connected" (get-in connected [0 "state"]))))
                    (let [^js app @local-app]
                      (reset! local-app nil)
                      (await (.close app)))
                    (await (hs/wait-for (fn ^:async check [] (= "disconnected" (get (first (await (sessions relay))) "state")))))))))
             (finally
               (when-let [^js app @local-app] (await (.close app)))
               (when-let [^js app @relay-app] (await (.close app))))))))
      (finally
        (await (hs/remove-dir (:temp-dir relay-fixture)))
        (await (hs/remove-dir (:temp-dir local-fixture)))))))
