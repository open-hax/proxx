(ns proxx.runtime.federation-autostart
  "Edge of the env-configured bridge agent: reads the environment, asks the
  credential store and key pool what they hold, and hands plain facts to the
  pure builders in proxx.federation.autostart. Returns the agent *options*; the
  TypeScript entry point constructs the agent from them."
  (:require [proxx.federation.autostart :as autostart]
            [proxx.runtime.models :as models]))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

(defn- env-map []
  (let [env js/process.env]
    (into {} (map (fn [k] [k (aget env k)])) (js/Object.keys env))))

(defn- env-trim
  "`process.env[name]?.trim()`: undefined when unset, \"\" when blank."
  [name]
  (let [v (aget js/process.env name)] (if (nil? v) js/undefined (.trim v))))

(defn- strings [x] (if (some? x) (vec (array-seq x)) []))

(defn- js->config [^js config]
  {:openai-provider-id (.-openaiProviderId config) :upstream-provider-id (.-upstreamProviderId config)
   :responses-model-prefixes (strings (.-responsesModelPrefixes config))
   :openai-model-prefixes (strings (.-openaiModelPrefixes config))
   :messages-model-prefixes (strings (.-messagesModelPrefixes config))
   :factory-model-prefixes (strings (.-factoryModelPrefixes config))
   :ollama-model-prefixes (strings (.-ollamaModelPrefixes config))
   :chat-completions-path (.-chatCompletionsPath config) :responses-path (.-responsesPath config)
   :images-generations-path (.-imagesGenerationsPath config)})

(defn- js->providers [providers]
  (mapv (fn [^js p] {:id (.-id p) :auth-type (.-authType p) :account-count (.-accountCount p)}) (array-seq providers)))

(defn- js->statuses [^js statuses]
  (into {} (map (fn [k] (let [^js status (aget statuses k)] [k {:available-accounts (.-availableAccounts status)}])))
        (js/Object.keys statuses)))

(defn- local-facts
  "Providers and pool statuses, each falling back to nothing when the store or pool fails."
  [^js deps]
  (-> (js/Promise.all
       #js [(.catch (.listProviders ^js (.-credentialStore deps) false) (fn [_] #js []))
            (.catch (.getAllStatuses ^js (.-keyPool deps)) (fn [_] #js {}))])
      (.then (fn [r] {:providers (js->providers (aget r 0)) :statuses (js->statuses (aget r 1))}))))

(defn- self-ids []
  {:group-id (env-trim "FEDERATION_SELF_GROUP_ID") :node-id (env-trim "FEDERATION_SELF_NODE_ID")
   :now-iso (.toISOString (js/Date.))})

(defn- model-ids [^js deps]
  (if-let [f (.-getResolvedModelCatalog deps)]
    (.then (js/Promise.resolve (.catch (f) (fn [_] #js {:modelIds #js []}))) (fn [c] (strings (.-modelIds ^js c))))
    (js/Promise.resolve [])))

(defn- capabilities [^js deps]
  (-> (local-facts deps)
      (.then (fn [facts]
               (-> (model-ids deps)
                   (.then (fn [ids]
                            (clj->js (autostart/build-capabilities
                                      (merge facts (self-ids) {:model-ids ids :config (js->config (.-config deps))}))))))))))

(defn- health [^js deps]
  (.then (local-facts deps) (fn [facts] (clj->js (autostart/build-health (merge facts (self-ids)))))))

(defn- provenance []
  {"servedByClusterId" (env-trim "FEDERATION_SELF_CLUSTER_ID") "servedByGroupId" (env-trim "FEDERATION_SELF_GROUP_ID")
   "servedByNodeId" (env-trim "FEDERATION_SELF_NODE_ID")})

(defn- fallback-response [^js deps method path]
  (if (= :models-list (autostart/fallback-route method path))
    (-> (if-let [f (.-getResolvedModelCatalog deps)] (js/Promise.resolve (f)) (js/Promise.resolve #js {:modelIds #js []}))
        (.then (fn [^js catalog]
                 (let [o (clj->js {"status" 200 "headers" {"content-type" "application/json"}})]
                   (aset o "body" (js/JSON.stringify
                                   #js {:object "list" :data (.map (.-modelIds catalog) (fn [id] (models/to-open-ai-model-js id)))}))
                   (doseq [[k v] (provenance)] (aset o k v))
                   o))))
    (js/Promise.resolve
     (clj->js {"status" 404 "headers" {"content-type" "application/json"}
               "body" (js/JSON.stringify #js {:error (autostart/not-supported-message method path)})}))))

(defn- handle-request [^js deps ^js arg]
  (let [request (.-request arg)]
    (if-let [handler (.-handleBridgeRequest deps)]
      (let [context (.-requestContext request)
            input (js-obj)]
        (aset input "method" (.-method request))
        (aset input "path" (.-path request))
        (aset input "headers" (.-headers request))
        (aset input "bodyText" (.-bodyText arg))
        (aset input "ownerSubject" (.-ownerSubject request))
        (aset input "tenantId" (if context (.-tenantId ^js context) js/undefined))
        (handler input))
      (fallback-response deps (.-method request) (.-path request)))))

(defn create-env-agent-options-js
  "Options for the env-configured bridge agent, or undefined when it is not configured
  (no relay URL) or cannot start (required variables missing, which is logged)."
  [^js deps]
  (let [{:keys [status options relay-url missing]} (autostart/resolve-options (env-map))]
    (case status
      :disabled js/undefined
      :skipped (do (.warn ^js (.-logger deps)
                          #js {:relayUrl relay-url :missing (to-array missing)}
                          "bridge relay autostart skipped because required federation bridge env is missing")
                   js/undefined)
      :ok (let [o (js-obj)]
            (doseq [[k v] {"relayUrl" (:relay-url options) "authorization" (:authorization options)
                           "ownerSubject" (:owner-subject options) "peerDid" (:peer-did options)
                           "clusterId" (:cluster-id options) "agentId" (:agent-id options)
                           "environment" (:environment options) "bridgeAgentVersion" (:bridge-agent-version options)
                           "authMode" (:auth-mode options) "labels" (to-array (:labels options))
                           "topology" (some-> (:topology options) clj->js)
                           "reconnectMinMs" (:reconnect-min-ms options) "reconnectMaxMs" (:reconnect-max-ms options)}]
              (aset o k (or-undefined v)))
            (aset o "getCapabilities" (fn [] (capabilities deps)))
            (aset o "getHealth" (fn [] (health deps)))
            (aset o "handleRequest" (fn [arg] (js/Promise.resolve (handle-request deps arg))))
            o))))
