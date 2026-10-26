(ns proxx.federation.autostart-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.autostart :as a]
            [proxx.federation.protocol :as p]))

(def env {"FEDERATION_BRIDGE_RELAY_URL" " ws://relay " "FEDERATION_BRIDGE_OWNER_SUBJECT" "did:plc:o"
          "FEDERATION_SELF_PEER_DID" "did:web:x" "FEDERATION_SELF_CLUSTER_ID" "c1" "FEDERATION_BRIDGE_AGENT_ID" "agent"})

(deftest options-from-environment
  (is (= {:status :disabled} (a/resolve-options {})))
  (is (= {:status :disabled} (a/resolve-options {"FEDERATION_BRIDGE_RELAY_URL" "  "})))
  (testing "missing variables are named in order"
    (is (= {:status :skipped :relay-url "ws://r"
            :missing ["FEDERATION_BRIDGE_OWNER_SUBJECT or FEDERATION_DEFAULT_OWNER_SUBJECT" "FEDERATION_SELF_PEER_DID"
                      "FEDERATION_SELF_CLUSTER_ID" "FEDERATION_BRIDGE_AGENT_ID"]}
           (a/resolve-options {"FEDERATION_BRIDGE_RELAY_URL" "ws://r"}))))
  (let [{:keys [status options]} (a/resolve-options (assoc env "FEDERATION_BRIDGE_AUTH_TOKEN" " t "
                                                          "FEDERATION_BRIDGE_AUTH_MODE" " AT_DID "
                                                          "FEDERATION_BRIDGE_LABELS" "a,b,a, ,c"
                                                          "FEDERATION_BRIDGE_RECONNECT_MIN_MS" "100"
                                                          "FEDERATION_BRIDGE_RECONNECT_MAX_MS" "0"))]
    (is (= :ok status))
    (is (= "ws://relay" (:relay-url options)))
    (is (= "Bearer t" (:authorization options)))
    (is (= "at_did" (:auth-mode options)))
    (is (= ["a" "b" "c"] (:labels options)))
    (is (= 100 (:reconnect-min-ms options)))
    (is (nil? (:reconnect-max-ms options)) "non-positive delays fall back to the agent's defaults")
    (is (= "local" (:environment options)))
    (is (= "0.1.0" (:bridge-agent-version options))))
  (is (= "admin_key" (:auth-mode (:options (a/resolve-options (assoc env "FEDERATION_BRIDGE_AUTH_MODE" "weird")))))))

(deftest topology-from-environment
  (is (nil? (a/build-topology {})))
  (is (= {"groups" [] "nodes" [] "defaultExecutionPolicy" "node_affinity"}
         (a/build-topology {"FEDERATION_SELF_CLUSTER_ID" "c"})) "a cluster alone has no placement")
  (is (= {"groups" [{"groupId" "g" "nodeIds" ["n"]}] "nodes" [{"groupId" "g" "nodeId" "n" "labels" ["x" "x"]}]
          "defaultExecutionPolicy" "group_affinity"}
         (a/build-topology {"FEDERATION_SELF_GROUP_ID" "g" "FEDERATION_SELF_NODE_ID" "n"
                            "FEDERATION_BRIDGE_NODE_LABELS" "x, x"
                            "FEDERATION_BRIDGE_DEFAULT_EXECUTION_POLICY" "GROUP"}))))

(def config {:openai-provider-id "openai" :upstream-provider-id "vivgrid" :responses-model-prefixes ["gpt-"]
             :openai-model-prefixes ["openai/" "openai:"] :messages-model-prefixes ["claude-"]
             :factory-model-prefixes ["factory/"] :ollama-model-prefixes ["ollama:"]
             :chat-completions-path "/v1/chat/completions" :responses-path "/v1/responses"
             :images-generations-path "/v1/images/generations"})

(deftest capabilities
  (let [caps (a/build-capabilities
              {:providers [{:id "openai" :auth-type "oauth_bearer" :account-count 2}
                           {:id "factory" :auth-type "api_key" :account-count 1}
                           {:id "dead" :auth-type "api_key" :account-count 3}
                           {:id "other" :auth-type "api_key" :account-count 1}]
               :statuses {"openai" {:available-accounts 1} "dead" {:available-accounts 0}}
               :model-ids ["gpt-5" "factory/m" "claude-3" "openai/x"]
               :config config :group-id "g" :node-id "n" :now-iso "2026-01-01T00:00:00.000Z"})
        by-id (into {} (map (juxt #(get % "providerId") identity)) caps)]
    (is (= ["openai" "factory" "other"] (map #(get % "providerId") caps)) "providers without an available account are not advertised")
    (is (= ["gpt-5" "openai/x"] (get-in by-id ["openai" "models"])))
    (is (= ["gpt-" "openai/" "openai:"] (get-in by-id ["openai" "modelPrefixes"])))
    (is (= "access_token_only" (get-in by-id ["openai" "credentialMobility"])))
    (is (= true (get-in by-id ["openai" "supportsWarmImport"])))
    (is (= [] (get-in by-id ["other" "models"])) "no prefixes, no models")
    (is (= [{"groupId" "g" "nodeId" "n"}] (get-in by-id ["factory" "topologyTargets"])))
    (is (every? p/valid-frame? (map #(hash-map "type" "capabilities" "protocolVersion" "bridge-ws-v0" "sentAt" "s" "traceId" "t"
                                               "ownerSubject" "o" "clusterId" "c" "agentId" "a" "capabilities" [%])
                                    caps))
        "what the agent advertises is a valid capabilities frame")))

(deftest health
  (is (= {"processHealthy" true "upstreamHealthy" false "availableAccountCount" 0 "localOauthBootstrapReady" false
          "queuedRequests" 0 "nodes" []}
         (a/build-health {:providers [] :statuses {} :now-iso "t"})))
  (let [h (a/build-health {:providers [{:id "openai" :auth-type "oauth_bearer"}] :statuses {"openai" {:available-accounts 2}}
                           :group-id "g" :node-id "n" :now-iso "t"})]
    (is (= true (get h "localOauthBootstrapReady")))
    (is (= 2 (get h "availableAccountCount")))
    (is (= [{"groupId" "g" "nodeId" "n" "reachable" true "lastHealthyAt" "t"}] (get h "nodes")))))

(deftest requests-without-a-host-handler
  (is (= :models-list (a/fallback-route "GET" "/v1/models")))
  (is (= :not-supported (a/fallback-route "POST" "/v1/models")))
  (is (= "bridge route not supported: GET /x" (a/not-supported-message "GET" "/x"))))
