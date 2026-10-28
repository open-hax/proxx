(ns proxx.app.main
  "The Proxx application (formerly src/app.ts): configuration in, a running-ready
  Fastify instance out.

  What to build and in which order is data (`proxx.app.wiring/plan`); the global
  hooks and handlers are `proxx.runtime.app`; routes are Ring route tables
  registered through `proxx.runtime.ring`. This namespace is the composition:
  it builds the app, constructs the stores and pools the plan names, wires the
  hooks and registers every route in the original order.

  Stores, pools and managers are still host classes (TypeScript: SQL, files,
  OAuth, quota, the federation relay). They are constructed through `host`, one
  JS object of factory functions and route-registration bundles supplied by
  src/app.ts; nothing here knows how they are implemented. `host` shape:
    isOpenAiHttpError(error)            defaultTenantId   proxyAuthCookieName
    createSqlConnection(config)         closeConnection(sql)
    createDefaultLabelers()             sql: {credential, accountHealth, event, requestUsage,
                                              federation, tenantProviderPolicy, authPersistence}(connection)
    keyPool(opts) credentialStore(path, providerId) runtimeCredentialStore(credentialStore, sqlStore)
    oauthManager(opts) quotaMonitor(...) providerCatalogStore(...) requestLogStore(...)
    requestLogSseHub(store) promptAffinityStore(sql) pheromoneStore(path, flushMs) proxySettingsStore(path, sql)
    createTokenRefreshRuntime(deps)
    getDeclaredProviderRoutes(config)   buildOllamaCatalogRoutes(config)   modelIdsToNativeTags(ids)
    routes: {v1Collaborators() embeddingsCollaborators() mediaCollaborators()
             createRequestLogWsHub(store) registerBridgeSseRoutes(app, deps, relay)
             registerRequestLogSseRoutes(app, deps, hub) registerApiV1Routes(app, deps)
             registerObservabilityRoutes(app, deps)}"
  (:require ["@fastify/swagger" :as swagger]
            ["@fastify/swagger-ui" :as swagger-ui]
            ["fastify" :as fastify]
            ["node:path" :as path]
            [proxx.app.wiring :as wiring]
            [proxx.runtime :as runtime]
            [proxx.runtime.app :as app-edge]
            [proxx.runtime.federation-agent :as federation-agent]
            [proxx.runtime.federation-autostart :as federation-autostart]
            [proxx.runtime.federation-relay :as federation-relay]
            [proxx.runtime.federation-routing :as federation-routing]
            [proxx.runtime.models :as models]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.ring :as ring]
            [proxx.runtime.routes :as routes]
            [proxx.runtime.routes.embeddings :as embeddings-routes]
            [proxx.runtime.routes.media :as media-routes]
            [proxx.runtime.routes.native-ollama :as native-ollama-routes]
            [proxx.runtime.routes.v1 :as v1-routes]
            [proxx.runtime.routes.ws :as ws-routes]
            [proxx.runtime.routes.websearch :as websearch-routes]
            [proxx.runtime.routing :as routing]
            [proxx.runtime.telemetry :as telemetry]))

(defn- u
  "nil as JS `undefined`: the host classes take optional collaborators as `undefined`."
  [x]
  (if (nil? x) js/undefined x))

(defn- plugin [m] (or (aget m "default") m))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(def ^:private body-limit (* 300 1024 1024))

(def ^:private openapi
  #js {"info" #js {"title" "Proxx API"
                   "description" "OpenAI-compatible proxy with provider account rotation"
                   "version" "1.0.0"}
       "servers" #js [#js {"url" "/"}]})

(defn- ^:async register-docs!
  "Swagger/OpenAPI document and UI."
  [^js app]
  (await (.register app (plugin swagger) #js {"openapi" openapi}))
  (await (.register app (plugin swagger-ui) #js {"routePrefix" "/docs" "staticCSP" true}))
  (.get app "/api/v1/openapi.json"
        (fn ^:async openapi-json [_request ^js reply]
          (.send (.header reply "content-type" "application/json") (.swagger app))))
  (.get app "/api/docs"
        (fn ^:async docs-redirect [_request ^js reply]
          (.redirect reply "/docs"))))

;; ---------------------------------------------------------------------------
;; Telemetry hooks (a span per request)
;; ---------------------------------------------------------------------------

(defn- install-telemetry-hooks! [^js app]
  (.decorateRequest app "_otelSpan" nil)
  (.addHook app "onRequest"
            (fn ^:async on-request [^js request]
              (when-not (= "OPTIONS" (.-method request))
                (let [raw-url (or (.-url ^js (.-raw request)) (.-url request))
                      span (.startSpan ^js (telemetry/get-telemetry-js) "http.request"
                                       #js {"http.method" (.-method request)
                                            "http.path" (first (.split raw-url "?"))})]
                  (aset request "_otelSpan" span)))))
  (.addHook app "onResponse"
            (fn ^:async on-response [^js request ^js reply]
              (when-let [^js span (aget request "_otelSpan")]
                (.setAttribute span "http.status_code" (.-statusCode reply))
                (if (>= (.-statusCode reply) 400)
                  (.setStatus span "error" (str "HTTP " (.-statusCode reply)))
                  (.setStatus span "ok"))
                (.end span)))))

;; ---------------------------------------------------------------------------
;; Database stores
;; ---------------------------------------------------------------------------

(defn- ^:async init-database-stores!
  "Connect and initialise the SQL stores in plan order. Returns {:sql :stores {id store}}.
  A required store failing aborts startup; an optional one is left out."
  [^js app ^js config ^js plan ^js host]
  (.info (.-log app) "connecting to database")
  (let [^js connection ((.-createSqlConnection host) #js {"connectionString" (.-databaseUrl config)})
        stores (atom {})]
    (try
      (doseq [^js entry (array-seq (.-storeInit plan))]
        (let [id (.-id entry)
              ^js store ((aget ^js (.-sql host) id) connection)
              init! (fn ^:async init-store []
                      (await (.init store))
                      (when (= "event" id)
                        (doseq [labeler (array-seq ((.-createDefaultLabelers host)))]
                          (.registerLabeler store labeler)))
                      (swap! stores assoc id store))]
          (if (.-required entry)
            (do (await (init!))
                (.info (.-log app) (.-started entry)))
            (try (await (init!))
                 (.info (.-log app) (.-started entry))
                 (catch :default error
                   (.warn (.-log app) #js {"error" (error-message error)} (.-failed entry)))))))
      (let [^js credential (get @stores "credential")
            removed (await (.cleanupLegacyOpenAiDuplicates credential))]
        (when (pos? removed)
          (.warn (.-log app) #js {"count" removed} "removed legacy duplicate OpenAI account rows after seeding")))
      (.info (.-log app) "database connection established")
      {:sql connection :stores @stores}
      (catch :default error
        (.error (.-log app) #js {"error" (error-message error)} "failed to initialize database connection")
        (throw error)))))

;; ---------------------------------------------------------------------------
;; Model catalogue (local + connected bridge sessions)
;; ---------------------------------------------------------------------------

(defn- bridge-model-ids-fn
  "(→ Promise<[id]>): model ids advertised by connected bridge sessions, preferring
  their advertised capabilities over a /v1/models fan-out."
  [^js app ^js config relay-atom]
  (fn ^:async bridge-advertised-model-ids []
    (if-let [^js relay @relay-atom]
      (let [connected (filterv (fn [^js s] (= "connected" (.-state s))) (array-seq (.listSessions relay)))]
        (if (empty? connected)
          #js []
          (let [advertised (app-edge/advertised-model-ids-js (to-array connected))]
            (if (pos? (.-length advertised))
              advertised
              (let [lists (await (js/Promise.all
                                  (to-array
                                   (map (fn [^js session]
                                          (-> (.requestJson relay (.-sessionId session)
                                                            #js {"path" "/v1/models"
                                                                 "timeoutMs" (js/Math.min (.-requestTimeoutMs config) 10000)
                                                                 "headers" #js {"accept" "application/json"}})
                                              (.then (fn [^js response] (routing/parse-model-ids-from-catalog-payload-js (.-json response))))
                                              (.catch (fn [error]
                                                        (.warn (.-log app)
                                                               #js {"error" (error-message error) "sessionId" (.-sessionId session)}
                                                               "failed to fetch bridge model inventory from connected session")
                                                        #js []))))
                                        connected))))]
                (to-array (distinct (mapcat array-seq (array-seq lists)))))))))
      #js [])))

;; ---------------------------------------------------------------------------
;; Routes the application owns
;; ---------------------------------------------------------------------------

(defn- policy-allows-model? [^js deps tenant-settings model-id]
  (let [^js result (runtime/preview-policy-decision-js
                    (or (.-cljsPolicyManifestPath ^js (.-config deps)) "resources/policies/runtime/00-manifest.edn")
                    #js {"modelId" model-id "requestKind" "chat" "tenantSettings" tenant-settings "providerIds" #js []})
        decision (when (and (= "ok" (.-status result)) (some? (.-decision result))
                            (= "object" (js* "typeof ~{}" (.-decision result))))
                   (.-decision result))]
    (not (and decision (= "denied" (.-status ^js decision)) (= "tenant-model-not-allowed" (.-reason ^js decision))))))

(defn- ^:async allowed-model-ids [^js deps ^js request]
  (let [tenant-id (or (some-> ^js (.-openHaxAuth request) .-tenantId) "default")
        settings (await (.getForTenant ^js (.-proxySettingsStore deps) tenant-id))
        ids (await ((.-getMergedModelIds deps)))]
    (filterv #(policy-allows-model? deps settings %) (array-seq ids))))

(defn models-routes
  "GET /v1/models and /v1/models/:model: the merged catalogue the tenant's policy allows."
  [^js deps]
  [{:method :get :path "/v1/models"
    :handler (fn ^:async list-models [{:keys [raw]}]
               {:status 200
                :body #js {"object" "list" "data" (to-array (map models/to-open-ai-model-js (await (allowed-model-ids deps raw))))}})}
   {:method :get :path "/v1/models/:model"
    :handler (fn ^:async get-model [{:keys [raw params]}]
               (let [wanted (get params "model")
                     found (first (filter #(= % wanted) (await (allowed-model-ids deps raw))))]
                 (if-not found
                   {:status 404
                    :headers {"x-open-hax-error-code" "model_not_found"}
                    :body (proxy/openai-error-js (str "Model not found: " wanted) "invalid_request_error" "model_not_found")}
                   {:status 200 :body (models/to-open-ai-model-js found)})))}])

(defn- native-tags-route [^js host get-merged-model-ids]
  [{:method :get :path "/api/tags"
    :handler (fn ^:async native-tags [_]
               (try {:status 200 :body ((.-modelIdsToNativeTags host) (await (get-merged-model-ids)))}
                    (catch :default error
                      {:status 500 :body #js {"error" (error-message error)}})))}])

;; ---------------------------------------------------------------------------
;; createApp
;; ---------------------------------------------------------------------------

(defn- policy-manifest [^js config]
  (.-cljsPolicyManifestPath config))

(defn ^:async create-app-js
  "Build the Fastify application for `config` (a ProxyConfig). `host` supplies the
  store and manager factories (see the namespace doc)."
  [^js config ^js host]
  (let [^js app ((plugin fastify) #js {"logger" true "bodyLimit" body-limit})
        ^js routes-host (.-routes host)]
    (app-edge/install-error-handler-js app #js {"isOpenAiHttpError" (.-isOpenAiHttpError host)})
    (await (register-docs! app))
    (let [^js plan (app-edge/wiring-plan-js config)
          {:keys [stores] sql* :sql} (if (.-database plan)
                                 (await (init-database-stores! app config plan host))
                                 {:sql nil :stores {}})
          sql (u sql*)
          ^js sql-credential-store (u (get stores "credential"))
          ^js account-health-store (u (get stores "accountHealth"))
          ^js event-store (u (get stores "event"))
          ^js sql-request-usage-store (u (get stores "requestUsage"))
          ^js sql-federation-store (u (get stores "federation"))
          ^js sql-tenant-provider-policy-store (u (get stores "tenantProviderPolicy"))
          ^js sql-auth-persistence (u (get stores "authPersistence"))
          dynamic-base-url-getter (routing/create-dynamic-provider-base-url-getter-js sql-credential-store)
          ^js key-pool ((.-keyPool host)
                        #js {"keysFilePath" (.-keysFilePath config)
                             "reloadIntervalMs" (.-keyReloadMs config)
                             "defaultCooldownMs" (.-keyCooldownMs config)
                             "defaultProviderId" (.-upstreamProviderId config)
                             "accountStore" sql-credential-store
                             "cooldownStore" sql-credential-store
                             "disabledStore" sql-credential-store
                             "preferAccountStoreProviders" (.-preferAccountStoreProviders plan)
                             "cooldownJitterFactor" (.-keyCooldownJitterFactor config)
                             "enableRandomWalk" (.-enableKeyRandomWalk config)})]
      (try (await (.warmup key-pool))
           (catch :default error
             (.warn (.-log app) #js {"error" (error-message error)}
                    "failed to warm up provider accounts; non-keyed routes may still work")))
      (let [^js request-log-store ((.-requestLogStore host) (.-requestLogsFilePath config) (.-requestLogsMaxEntries config)
                                                            (.-requestLogsFlushMs config) sql-request-usage-store)
            _ (await (.warmup request-log-store))
            ^js request-log-sse-hub ((.-requestLogSseHub host) request-log-store)
            ^js prompt-affinity-store ((.-promptAffinityStore host) sql)
            _ (await (.init prompt-affinity-store))
            ^js pheromone-store ((.-pheromoneStore host) (.join path (.dirname path (.-requestLogsFilePath config)) (.-pheromoneFileName plan))
                                                         (.-promptAffinityFlushMs config))
            _ (await (.warmup pheromone-store))
            ^js proxy-settings-store ((.-proxySettingsStore host) (.-settingsFilePath config) sql)
            _ (await (.warmup proxy-settings-store))
            _ (.info (.-log app) "CLJS policy router runtime boundary available")
            ^js credential-store ((.-credentialStore host) (.-keysFilePath config) (.-upstreamProviderId config))
            ^js runtime-credential-store ((.-runtimeCredentialStore host) credential-store sql-credential-store)
            ^js oauth-manager ((.-oauthManager host) #js {"oauthScopes" (.-openaiOauthScopes config)
                                                          "clientId" (.-openaiOauthClientId config)
                                                          "issuer" (.-openaiOauthIssuer config)
                                                          "clientSecret" (.-openaiOauthClientSecret config)})
            ^js refresh ((.-createTokenRefreshRuntime host)
                         #js {"keyPool" key-pool "runtimeCredentialStore" runtime-credential-store "oauthManager" oauth-manager
                              "sqlCredentialStore" sql-credential-store "log" (.-log app) "config" (.-tokenRefresh plan)})
            ^js token-refresh-manager (.-tokenRefreshManager refresh)
            _ (.startBackgroundRefresh token-refresh-manager
                                       (fn []
                                         (.concat (.getAllExpiredWithRefreshTokens key-pool)
                                                  (.getExpiringAccounts key-pool (.-oauthRefreshProactiveWindowMs config)))))
            refresh-openai-oauth-accounts (app-edge/create-refresh-openai-oauth-accounts-js
                                           key-pool token-refresh-manager (.-openaiProviderId config))
            ^js log (.-log app)
            ^js quota-monitor ((.-quotaMonitor host) runtime-credential-store
                                                     #js {"info" (fn [obj msg] (.info log obj msg))
                                                          "warn" (fn [obj msg] (.warn log obj msg))
                                                          "error" (fn [obj msg] (.error log obj msg))}
                                                     (.-quotaMonitor plan) account-health-store key-pool)
            _ (.start quota-monitor)
            ollama-catalog-routes ((.-buildOllamaCatalogRoutes host) config)
            provider-catalog-routes (.filter ((.-getDeclaredProviderRoutes host) config)
                                             (fn [^js route] (or (not= "factory" (.-providerId route)) (.-includeFactoryCatalogRoutes plan))))
            ^js provider-catalog-store ((.-providerCatalogStore host) config key-pool provider-catalog-routes ollama-catalog-routes)
            get-resolved-model-catalog (fn ^:async resolved-catalog [force-refresh]
                                         (let [^js resolved (await (.getCatalog provider-catalog-store (boolean force-refresh)))]
                                           (.-catalog resolved)))
            relay (atom (federation-relay/create-relay-js))
            get-bridge-advertised (bridge-model-ids-fn app config relay)
            get-merged-model-ids (fn ^:async merged-model-ids [force-refresh]
                                   (let [^js local (await (get-resolved-model-catalog force-refresh))
                                         bridged (await (get-bridge-advertised))]
                                     (app-edge/merge-model-ids-js (.-modelIds local) bridged)))
            fed-deps #js {"app" app "cljsPolicyManifestPath" (policy-manifest config) "sqlFederationStore" sql-federation-store
                          "runtimeCredentialStore" runtime-credential-store "keyPool" key-pool
                          "sqlTenantProviderPolicyStore" sql-tenant-provider-policy-store}
            bridge-deps (fn [] #js {"bridgeRelay" (u @relay) "app" app "config" config "runtimeCredentialStore" runtime-credential-store
                                    "keyPool" key-pool "sqlTenantProviderPolicyStore" sql-tenant-provider-policy-store})
            ^js bridge-agent (when-let [options (federation-autostart/create-env-agent-options-js
                                                 #js {"config" config "keyPool" key-pool "credentialStore" runtime-credential-store "logger" log
                                                      "getResolvedModelCatalog" (fn [] (get-resolved-model-catalog false))
                                                      "handleBridgeRequest" (fn [input] (federation-routing/handle-bridge-request (bridge-deps) input))})]
                               (federation-agent/create-agent-js options))]
        (when (.-allowUnauthenticated config)
          (.warn log "proxy auth disabled via PROXY_ALLOW_UNAUTHENTICATED=true"))
        (app-edge/install-request-hook-js
         app #js {"config" config "sqlCredentialStore" sql-credential-store "sqlAuthPersistence" sql-auth-persistence
                  "proxySettingsStore" proxy-settings-store "requestLogStore" request-log-store
                  "defaultTenantId" (.-defaultTenantId host) "cookieName" (.-proxyAuthCookieName host)})
        (install-telemetry-hooks! app)
        (app-edge/install-public-routes-js app (let [port (.trim (or (aget js/process.env "PROXY_WEB_PORT") "5174"))]
                                                 (if (seq port) port "5174")))
        (let [^js deps #js {"app" app "config" config "keyPool" key-pool "credentialStore" credential-store
                            "runtimeCredentialStore" runtime-credential-store "sqlCredentialStore" sql-credential-store
                            "sqlFederationStore" sql-federation-store "sqlTenantProviderPolicyStore" sql-tenant-provider-policy-store
                            "accountHealthStore" account-health-store "eventStore" event-store
                            "requestLogStore" request-log-store "promptAffinityStore" prompt-affinity-store
                            "providerRoutePheromoneStore" pheromone-store "proxySettingsStore" proxy-settings-store
                            "providerCatalogStore" provider-catalog-store "tokenRefreshManager" token-refresh-manager
                            "dynamicProviderBaseUrlGetter" (if dynamic-base-url-getter
                                                             (fn ^:async dynamic-base-url [id]
                                                               (let [url (await (dynamic-base-url-getter id))]
                                                                 (if (nil? url) js/undefined url)))
                                                             (fn ^:async no-base-url [_] js/undefined))
                            "bridgeRelay" @relay "quotaMonitor" quota-monitor
                            "refreshExpiredOAuthAccount" (.-refreshExpiredOAuthAccount refresh)
                            "refreshFactoryAccount" (.-refreshFactoryAccount refresh)
                            "ensureFreshAccounts" (.-ensureFreshAccounts refresh)
                            "getMergedModelIds" get-merged-model-ids
                            "executeFederatedRequestRouting" (fn ^:async execute-federated [input]
                                                               (await (federation-routing/execute-federated-request-routing fed-deps input)))
                            "injectNativeBridge" (fn ^:async inject-native-bridge [url payload headers]
                                                   (await (federation-routing/inject-native-bridge (bridge-deps) url payload headers)))}
              ui-deps (fn [] #js {"config" config "keyPool" key-pool "requestLogStore" request-log-store
                                  "credentialStore" runtime-credential-store "sqlCredentialStore" sql-credential-store
                                  "sqlFederationStore" sql-federation-store
                                  "sqlTenantProviderPolicyStore" sql-tenant-provider-policy-store
                                  "sqlRequestUsageStore" sql-request-usage-store "authPersistence" sql-auth-persistence
                                  "proxySettingsStore" proxy-settings-store "eventStore" event-store})]
          (routes/register-health-routes-js app #js {"keyPool" key-pool "upstreamProviderId" (.-upstreamProviderId config)
                                                     "proxyAuthTokenConfigured" (boolean (.-proxyAuthToken config))})
          (ring/register! app (models-routes deps))
          (websearch-routes/register-websearch-routes-js app deps)
          (v1-routes/register-chat-routes-js app deps ((.-v1Collaborators routes-host)))
          (v1-routes/register-responses-routes-js app deps ((.-v1Collaborators routes-host)))
          (v1-routes/register-images-routes-js app deps ((.-v1Collaborators routes-host)))
          (media-routes/register-media-routes-js app deps ((.-mediaCollaborators routes-host)))
          (embeddings-routes/register-embeddings-routes-js app deps ((.-embeddingsCollaborators routes-host)))
          (native-ollama-routes/register-native-ollama-routes-js app deps)
          (let [^js ws-relay @relay]
            (ws-routes/register-web-socket-routes-js
             app #js {"proxyAuthToken" (.-proxyAuthToken config) "sqlCredentialStore" sql-credential-store
                      "authPersistence" sql-auth-persistence "proxyTokenPepper" (.-proxyTokenPepper config)
                      "defaultTenantId" (.-defaultTenantId host) "requestLogStore" request-log-store
                      "createBridgeRelay" (fn [] ws-relay)
                      "createRequestLogWsHub" (.-createRequestLogWsHub routes-host)})
            (await ((.-registerBridgeSseRoutes routes-host) app (ui-deps) ws-relay))
            (await ((.-registerRequestLogSseRoutes routes-host) app (ui-deps) request-log-sse-hub))
            (let [^js v1-deps (ui-deps)]
              (aset v1-deps "refreshOpenAiOauthAccounts" refresh-openai-oauth-accounts)
              (aset v1-deps "bridgeRelay" ws-relay)
              (await ((.-registerApiV1Routes routes-host) app v1-deps)))
            ;; Legacy /api/ui analytics + request logs used by Knoxx admin (auth-gated by the request hook).
            (await ((.-registerObservabilityRoutes routes-host) app (ui-deps))))
          (ring/register! app (native-tags-route host get-merged-model-ids))
          (.addHook app "onClose"
                    (fn ^:async on-close []
                      (when bridge-agent (await (.stop bridge-agent)))
                      (await (.stopAndWait token-refresh-manager))
                      (.stop quota-monitor)
                      (when account-health-store (await (.close account-health-store)))
                      (when event-store (await (.close event-store)))
                      (await (.close request-log-sse-hub))
                      (await (.close prompt-affinity-store))
                      (await (.close pheromone-store))
                      (await (.close request-log-store))
                      (await (.close credential-store))
                      (when sql (await ((.-closeConnection host) sql)))))
          (app-edge/install-not-found-handler-js app)
          (when bridge-agent (await (.start bridge-agent)))
          app)))))
