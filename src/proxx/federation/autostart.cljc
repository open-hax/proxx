(ns proxx.federation.autostart
  "What a federation bridge agent configured from the environment advertises:
  its options, capabilities and health, as pure functions of facts the edge
  has already gathered (environment, provider list, pool statuses, model catalog).

  `env` is a plain string->string map. Provider facts are
  {:id :auth-type :account-count}; `statuses` maps provider id to
  {:available-accounts n}; `config` carries the proxy's configured prefixes and paths."
  (:require [clojure.string :as str]
            [proxx.federation.helpers :as helpers]))

(defn- trimmed [x] (when (string? x) (str/trim x)))
(defn- present [x] (not-empty (trimmed x)))

(defn unique-strings
  "Trimmed, non-empty, first occurrence wins."
  [values]
  (vec (distinct (remove empty? (map str/trim values)))))

(defn parse-csv [value]
  (if (seq value)
    (into [] (comp (map str/trim) (remove empty?)) (str/split value #","))
    []))

(defn parse-default-execution-policy [value]
  (case (str/lower-case (str/trim (or value "node_affinity")))
    ("cluster_default" "cluster") "cluster_default"
    ("group_affinity" "group") "group_affinity"
    "node_affinity"))

(defn build-topology
  "The topology the agent announces, from FEDERATION_SELF_* variables; nil when none is set."
  [env]
  (let [cluster-id (present (get env "FEDERATION_SELF_CLUSTER_ID"))
        group-id (present (get env "FEDERATION_SELF_GROUP_ID"))
        node-id (present (get env "FEDERATION_SELF_NODE_ID"))]
    (when (or cluster-id group-id node-id)
      (let [placed? (and group-id node-id)]
        {"groups" (if placed? [{"groupId" group-id "nodeIds" [node-id]}] [])
         "nodes" (if placed? [{"groupId" group-id "nodeId" node-id
                               "labels" (parse-csv (get env "FEDERATION_BRIDGE_NODE_LABELS"))}] [])
         "defaultExecutionPolicy" (parse-default-execution-policy (get env "FEDERATION_BRIDGE_DEFAULT_EXECUTION_POLICY"))}))))

(defn- positive-int [raw]
  (let [n (when raw (helpers/parse-int raw))]
    (when (and n (== n n) (< n ##Inf) (pos? n)) n)))

(defn resolve-options
  "{:status :disabled} without a relay URL, {:status :skipped :relay-url :missing [...]}
  when required variables are absent, else {:status :ok :options {...}}."
  [env]
  (if-let [relay-url (present (get env "FEDERATION_BRIDGE_RELAY_URL"))]
    (let [owner-subject (or (present (get env "FEDERATION_BRIDGE_OWNER_SUBJECT"))
                            (present (get env "FEDERATION_DEFAULT_OWNER_SUBJECT")))
          peer-did (present (get env "FEDERATION_SELF_PEER_DID"))
          cluster-id (present (get env "FEDERATION_SELF_CLUSTER_ID"))
          agent-id (present (get env "FEDERATION_BRIDGE_AGENT_ID"))
          missing (cond-> []
                    (not owner-subject) (conj "FEDERATION_BRIDGE_OWNER_SUBJECT or FEDERATION_DEFAULT_OWNER_SUBJECT")
                    (not peer-did) (conj "FEDERATION_SELF_PEER_DID")
                    (not cluster-id) (conj "FEDERATION_SELF_CLUSTER_ID")
                    (not agent-id) (conj "FEDERATION_BRIDGE_AGENT_ID"))]
      (if (seq missing)
        {:status :skipped :relay-url relay-url :missing missing}
        (let [token (present (get env "FEDERATION_BRIDGE_AUTH_TOKEN"))
              auth-mode (str/lower-case (str/trim (or (get env "FEDERATION_BRIDGE_AUTH_MODE") "admin_key")))]
          {:status :ok
           :options {:relay-url relay-url
                     :authorization (when token (str "Bearer " token))
                     :owner-subject owner-subject :peer-did peer-did :cluster-id cluster-id :agent-id agent-id
                     :environment (or (present (get env "FEDERATION_BRIDGE_ENVIRONMENT")) (present (get env "NODE_ENV")) "local")
                     :bridge-agent-version (or (present (get env "FEDERATION_BRIDGE_AGENT_VERSION")) "0.1.0")
                     :auth-mode (if (#{"at_did" "did_signed_challenge"} auth-mode) auth-mode "admin_key")
                     :labels (unique-strings (parse-csv (get env "FEDERATION_BRIDGE_LABELS")))
                     :topology (build-topology env)
                     :reconnect-min-ms (positive-int (get env "FEDERATION_BRIDGE_RECONNECT_MIN_MS"))
                     :reconnect-max-ms (positive-int (get env "FEDERATION_BRIDGE_RECONNECT_MAX_MS"))}})))
    {:status :disabled}))

;; ---------------------------------------------------------------------------
;; Capabilities and health
;; ---------------------------------------------------------------------------

(defn capability-prefixes
  "Model prefixes a provider is advertised for; the provider kinds are the configured ones."
  [provider-id {:keys [openai-provider-id upstream-provider-id responses-model-prefixes openai-model-prefixes
                       messages-model-prefixes factory-model-prefixes ollama-model-prefixes]}]
  (cond
    (= provider-id openai-provider-id) (unique-strings (concat responses-model-prefixes openai-model-prefixes))
    (= provider-id upstream-provider-id) (unique-strings (concat responses-model-prefixes messages-model-prefixes))
    (= provider-id "factory") (unique-strings factory-model-prefixes)
    (#{"ollama" "ollama-cloud"} provider-id) (unique-strings ollama-model-prefixes)
    :else []))

(defn capability-paths [{:keys [chat-completions-path responses-path images-generations-path]}]
  (unique-strings ["/v1/models" chat-completions-path responses-path "/v1/embeddings" images-generations-path]))

(defn- strip-trailing-separator [prefix] (str/replace prefix #"[:/]$" ""))

(defn- topology-targets [{:keys [group-id node-id]}]
  (if (and (present group-id) (present node-id)) [{"groupId" group-id "nodeId" node-id}] []))

(defn build-capabilities
  "One advertisement per provider that still has an available account."
  [{:keys [providers statuses model-ids config group-id node-id now-iso]}]
  (let [targets (topology-targets {:group-id group-id :node-id node-id})
        paths (capability-paths config)]
    (into []
          (keep (fn [{:keys [id auth-type account-count]}]
                  (let [available (or (get-in statuses [id :available-accounts]) account-count)]
                    (when (pos? available)
                      (let [prefixes (capability-prefixes id config)
                            oauth? (= "oauth_bearer" auth-type)]
                        {"providerId" id "modelPrefixes" prefixes
                         "models" (if (seq prefixes)
                                    (filterv (fn [model-id] (some #(str/starts-with? model-id (strip-trailing-separator %)) prefixes)) model-ids)
                                    [])
                         "paths" paths "routes" paths "authType" auth-type
                         "accountCount" account-count "availableAccountCount" available
                         "supportsModelsList" true "supportsChatCompletions" true "supportsResponses" true
                         "supportsStreaming" true "supportsWarmImport" oauth?
                         "credentialMobility" (if oauth? "access_token_only" "importable")
                         "credentialOrigin" (if oauth? "localhost_oauth" "local_api_key")
                         "lastHealthyAt" now-iso "topologyTargets" targets})))))
          providers)))

(defn build-health [{:keys [providers statuses group-id node-id now-iso]}]
  (let [available (reduce + 0 (map :available-accounts (vals statuses)))]
    {"processHealthy" true
     "upstreamHealthy" (pos? available)
     "availableAccountCount" available
     "localOauthBootstrapReady" (boolean (some (fn [{:keys [id auth-type]}]
                                                (and (= "oauth_bearer" auth-type)
                                                     (pos? (or (get-in statuses [id :available-accounts]) 0))))
                                              providers))
     "queuedRequests" 0
     "nodes" (if (and (present group-id) (present node-id))
               [{"groupId" group-id "nodeId" node-id "reachable" true "lastHealthyAt" now-iso}]
               [])}))

;; ---------------------------------------------------------------------------
;; Requests with no host handler
;; ---------------------------------------------------------------------------

(defn fallback-route
  "How an agent with no request handler answers: the model list for GET /v1/models, else a 404."
  [method path]
  (if (and (= "GET" method) (= "/v1/models" path)) :models-list :not-supported))

(defn not-supported-message [method path]
  (str "bridge route not supported: " method " " path))
