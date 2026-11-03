(ns proxx.host
  "The host of the Proxx application: the JS object of store and manager factories, route
  registrars and collaborator bundles `proxx.app.main/create-app-js` composes the application
  from (formerly src/app.ts and the TypeScript facades it imported). Every entry is a
  CLJS function from the runtime namespaces, called directly; nothing here decides anything.

  Layout of the host: stores and managers are here, request routing glue is `proxx.host.routing`,
  route bundles are `proxx.host.routes`, and the few non-facade objects (typed errors, labelers,
  request-log hubs) are `proxx.host.objects`.

  `host` shape (see `proxx.app.main`):
    isOpenAiHttpError(error)            defaultTenantId   proxyAuthCookieName
    createSqlConnection(config)         closeConnection(sql)
    createDefaultLabelers()             sql: {credential, accountHealth, event, requestUsage,
                                              federation, tenantProviderPolicy, authPersistence}(connection)
    keyPool(config) credentialStore(path, providerId) runtimeCredentialStore(credentialStore, sqlStore)
    oauthManager(options) quotaMonitor(...) providerCatalogStore(...) requestLogStore(...)
    requestLogSseHub(store) promptAffinityStore(sql) pheromoneStore(path, flushMs) proxySettingsStore(path, sql)
    createTokenRefreshRuntime(deps)     createEnvFederationBridgeAgent(deps)
    handleBridgeRequest(deps, input)    injectNativeBridge(deps, url, payload, headers)
    executeFederatedRequestRouting(deps, input)
    getDeclaredProviderRoutes(config)   buildOllamaCatalogRoutes(config)   modelIdsToNativeTags(ids)
    routes: {v1Collaborators() embeddingsCollaborators() mediaCollaborators()
             registerWebSocketRoutes(app, deps) registerBridgeSseRoutes(app, deps, relay)
             registerRequestLogSseRoutes(app, deps, hub) registerApiV1Routes(app, deps)
             registerObservabilityRoutes(app, deps)}"
  (:require ["node:crypto" :as crypto]
            [proxx.app.main :as app-main]
            [proxx.host.objects :as objects]
            [proxx.host.routes :as routes]
            [proxx.host.routing :as hr]
            [proxx.http.url :as url]
            [proxx.policy.manifest-path :refer [policy-manifest-path]]
            [proxx.runtime :as runtime]
            [proxx.runtime.account-health :as account-health]
            [proxx.runtime.account-identity :as account-identity]
            [proxx.runtime.auth-persistence :as auth-persistence]
            [proxx.runtime.catalog :as catalog]
            [proxx.runtime.credentials :as credentials]
            [proxx.runtime.db-schema :as db-schema]
            [proxx.runtime.event-store :as event-store]
            [proxx.runtime.factory-auth :as factory-auth]
            [proxx.runtime.federation-agent :as federation-agent]
            [proxx.runtime.federation-autostart :as federation-autostart]
            [proxx.runtime.federation-routing :as federation-routing]
            [proxx.runtime.federation-store :as federation-store]
            [proxx.runtime.http :as http-edge]
            [proxx.runtime.keypool :as keypool]
            [proxx.runtime.ollama-native :as ollama-native]
            [proxx.runtime.pheromone-store :as pheromone-store]
            [proxx.runtime.prompt-affinity :as prompt-affinity]
            [proxx.runtime.quota-monitor :as quota-monitor]
            [proxx.runtime.request-log :as request-log]
            [proxx.runtime.runtime-credential-store :as runtime-credential-store]
            [proxx.runtime.settings :as settings]
            [proxx.runtime.sql-credential-store :as sql-credential-store]
            [proxx.runtime.telemetry :as telemetry]
            [proxx.runtime.tenant-policy-store :as tenant-policy-store]
            [proxx.runtime.token-refresh :as token-refresh]
            [proxx.runtime.usage-store :as usage-store]))

(def ^:private proxy-auth-cookie-name "open_hax_proxy_auth_token")

;; ---------------------------------------------------------------------------
;; Stores and managers
;; ---------------------------------------------------------------------------

(defn- sha256-hex [value]
  (-> (.createHash crypto "sha256") (.update value) (.digest "hex")))

(defn- ^:async load-factory-auth
  "The Factory CLI's stored credentials as {accessToken, refreshToken, expiresAt?}, or null."
  []
  (let [^js stored (await (factory-auth/load-factory-auth-v2-js))]
    (when stored
      (let [access-token (.-accessToken stored)]
        #js {"accessToken" access-token
             "refreshToken" (.-refreshToken stored)
             "expiresAt" (let [expiry (factory-auth/parse-jwt-expiry-js access-token)]
                           (if (nil? expiry) js/undefined expiry))}))))

(defn- key-pool [^js config rng]
  (keypool/create-key-pool-js
   config
   #js {"seedSpecs" (runtime/load-provider-seed-specs-js (or (.-policyManifestPath config) (policy-manifest-path)))
        "sha256Hex" sha256-hex
        "env" js/process.env
        "rng" rng
        "telemetry" #js {"recordMetric" (fn [metric value attributes]
                                          (.recordMetric ^js (telemetry/get-telemetry-js) metric value attributes))}
        "loadFactoryAuth" load-factory-auth}))

(defn- credential-store [file-path default-provider-id]
  (credentials/create-credential-store-js
   file-path default-provider-id
   #js {"deriveOAuthMetadata" account-identity/derive-oauth-metadata-from-token-js}))

(defn- prompt-affinity-store [sql]
  (prompt-affinity/create-prompt-affinity-store-js
   sql
   #js {"selectAll" (db-schema/sql-statement-js "SELECT_ALL_PROMPT_AFFINITY")
        "upsert" (db-schema/sql-statement-js "UPSERT_PROMPT_AFFINITY")
        "delete" (db-schema/sql-statement-js "DELETE_PROMPT_AFFINITY")
        "promote" (db-schema/sql-statement-js "UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL")}))

(defn- provider-catalog-store [config pool route-list ollama-route-list]
  (catalog/create-provider-catalog-store-js
   (policy-manifest-path) config pool route-list ollama-route-list
   #js {"fetchWithResponseTimeout" http-edge/fetch-with-response-timeout-js
        "joinUrl" url/join-url}))

(def ^:private request-log-aliases
  "Request-log store methods the application calls by their store names; the kernel facade
  names them after the core's read side."
  [["snapshotHourlyBuckets" "hourlyBuckets"] ["snapshotDailyBuckets" "dailyBuckets"]
   ["snapshotDailyModelBuckets" "dailyModelBuckets"] ["snapshotDailyAccountBuckets" "dailyAccountBuckets"]
   ["snapshotAccountAccumulators" "accountAccumulators"] ["getCoverage" "coverage"]
   ["getPerfSummary" "perfSummary"] ["getModelPerfSummary" "modelPerfSummary"]])

(defn- request-log-store [file-path max-entries persist-interval-ms mirror]
  (let [^js store (request-log/create-request-log-store-js
                   #js {"filePath" file-path
                        "maxEntries" (if (undefined? max-entries) 1000 max-entries)
                        "persistIntervalMs" (if (undefined? persist-interval-ms) 1000 persist-interval-ms)
                        "mirror" mirror
                        "estimate" hr/estimate-request-cost})
        list-entries (aget store "list")
        count-since (aget store "countRequestsSince")]
    (doseq [[alias original] request-log-aliases] (aset store alias (aget store original)))
    (aset store "list" (fn [filters] (list-entries (or filters #js {}))))
    (aset store "countRequestsSince" (fn [since-ms filters] (count-since since-ms (or filters #js {}))))
    store))

(defn- quota-monitor-of [credential-store logger config health-store cooldown-controller]
  (quota-monitor/create-quota-monitor-js (policy-manifest-path) credential-store logger (or config #js {})
                                         health-store cooldown-controller))

;; ---------------------------------------------------------------------------
;; Token refresh
;; ---------------------------------------------------------------------------

(def ^:private refresh-hooks
  #js {"isTerminalOpenAiRefreshError" objects/terminal-open-ai-refresh-error?
       "refreshFactoryOAuthToken" (fn [refresh-token fetch-fn]
                                    (factory-auth/refresh-factory-oauth-token-js refresh-token (or fetch-fn js/fetch)))
       "parseJwtExpiry" factory-auth/parse-jwt-expiry-js
       "persistFactoryAuthV2" factory-auth/persist-factory-auth-v2-js
       "factoryCredentialNeedsRefresh" factory-auth/factory-credential-needs-refresh-js
       "toErrorMessage" hr/error-message})

(defn- create-token-refresh-runtime
  "The OpenAI and Factory refresh handlers, the manager that schedules them, and `ensureFreshAccounts`."
  [^js deps]
  (let [refresh-expired-oauth-account (token-refresh/create-openai-refresh-handler-js deps refresh-hooks)
        refresh-factory-account (token-refresh/create-factory-refresh-handler-js deps refresh-hooks)
        manager (token-refresh/create-token-refresh-manager-js
                 (token-refresh/create-refresh-dispatcher-js deps refresh-hooks) (.-log deps) (.-config deps))
        ensure-fresh-accounts (token-refresh/create-ensure-fresh-accounts-js
                               #js {"keyPool" (.-keyPool deps) "tokenRefreshManager" manager} refresh-hooks)]
    #js {"tokenRefreshManager" manager
         "refreshExpiredOAuthAccount" refresh-expired-oauth-account
         "refreshFactoryAccount" refresh-factory-account
         "ensureFreshAccounts" ensure-fresh-accounts}))

(defn- create-env-federation-bridge-agent [deps]
  (when-let [options (federation-autostart/create-env-agent-options-js deps)]
    (federation-agent/create-agent-js options)))

;; ---------------------------------------------------------------------------
;; The host
;; ---------------------------------------------------------------------------

(def host
  "The host object `proxx.app.main/create-app-js` composes the application from."
  #js {"isOpenAiHttpError" objects/open-ai-http-error?
       "defaultTenantId" routes/default-tenant-id
       "proxyAuthCookieName" proxy-auth-cookie-name
       "createSqlConnection" db-schema/create-sql-connection-js
       "closeConnection" db-schema/close-connection-js
       "createDefaultLabelers" objects/create-default-labelers
       "sql" #js {"credential" (fn [connection]
                                 (sql-credential-store/create-sql-credential-store-js
                                  connection #js {"defaultTenantId" routes/default-tenant-id}))
                  "accountHealth" (fn [connection]
                                    (account-health/create-account-health-store-js
                                     connection 5000 (db-schema/sql-statement-js "SELECT_ALL_ACCOUNT_HEALTH")))
                  "event" (fn [connection] (event-store/create-event-store-js connection 3000 200))
                  "requestUsage" usage-store/create-sql-request-usage-store-js
                  "federation" federation-store/create-sql-federation-store-js
                  "tenantProviderPolicy" tenant-policy-store/create-sql-tenant-provider-policy-store-js
                  "authPersistence" auth-persistence/create-sql-auth-persistence-js}
       "keyPool" key-pool
       "credentialStore" credential-store
       "runtimeCredentialStore" runtime-credential-store/create-runtime-credential-store-js
       "oauthManager" objects/create-openai-oauth-manager
       "quotaMonitor" quota-monitor-of
       "providerCatalogStore" provider-catalog-store
       "requestLogStore" request-log-store
       "requestLogSseHub" objects/create-request-log-sse-hub
       "promptAffinityStore" prompt-affinity-store
       "pheromoneStore" pheromone-store/create-provider-route-pheromone-store-js
       "proxySettingsStore" settings/create-proxy-settings-store-js
       "createTokenRefreshRuntime" create-token-refresh-runtime
       "createEnvFederationBridgeAgent" create-env-federation-bridge-agent
       "handleBridgeRequest" federation-routing/handle-bridge-request
       "injectNativeBridge" federation-routing/inject-native-bridge
       "executeFederatedRequestRouting" routes/execute-federated-request-routing
       "getDeclaredProviderRoutes" hr/declared-provider-routes
       "buildOllamaCatalogRoutes" hr/ollama-catalog-routes
       "modelIdsToNativeTags" (fn [model-ids]
                                (ollama-native/model-ids-to-native-tags-js
                                 model-ids (fn [] (.replace (js/crypto.randomUUID) (js/RegExp. "-" "g") ""))))
       "routes" #js {"v1Collaborators" routes/v1-collaborators
                     "embeddingsCollaborators" routes/embeddings-collaborators
                     "mediaCollaborators" routes/media-collaborators
                     "registerWebSocketRoutes" routes/register-web-socket-routes
                     "registerBridgeSseRoutes" routes/register-bridge-sse-routes
                     "registerRequestLogSseRoutes" routes/register-request-log-sse-routes
                     "registerApiV1Routes" routes/register-api-v1-routes
                     "registerObservabilityRoutes" routes/register-observability-routes}})

;; ---------------------------------------------------------------------------
;; Entry points
;; ---------------------------------------------------------------------------

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn- ^:async assert-policy-runtime-ready
  "Refuse to start on a policy manifest that does not load and normalise as the routes expect."
  []
  (let [^js preview (runtime/preview-policy-decision-js
                     default-manifest
                     #js {"modelId" "gpt-5-mini" "providerIds" #js ["openai" "factory"]
                          "accountsByProvider" #js {"openai" #js [#js {"accountId" "plus" "planType" "plus"}]}
                          "strategiesByProvider" #js {"openai" #js [#js {"mode" "chat-completions" "priority" 1}]}})]
    (when-not (= "ok" (.-status preview))
      (throw (js/Error. "CLJS runtime previewPolicyDecision readiness check failed"))))
  (let [^js result (runtime/normalize-reasoning-request-js
                    default-manifest
                    #js {"modelId" "gpt-5.4-mini"
                         "requestBody" #js {"model" "gpt-5.4-mini" "reasoning" #js {"effort" "max"}}})
        body (some-> ^js (.-decision result) (aget "request-body"))
        effort (some-> ^js (some-> ^js body (aget "reasoning")) (aget "effort"))]
    (when-not (and (= "ok" (.-status result)) (= "xhigh" effort))
      (throw (js/Error. "CLJS runtime normalizeReasoningRequest readiness check failed")))))

(defn ^:async prepare
  "Check the policy runtime is sound before the application is built."
  []
  (await (assert-policy-runtime-ready)))

(defn ^:async create-app-js
  "The application for `config` (a ProxyConfig) over `host`."
  [config]
  (await (app-main/create-app-js config host)))
