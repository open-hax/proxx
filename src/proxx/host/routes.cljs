(ns proxx.host.routes
  "The route bundles of the host (formerly src/routes/**): the collaborator objects the chat,
  embeddings and media handlers read by name, and the registrars that hand the application's
  stores to each route module's Ring route table.

  The handlers are in `proxx.runtime.routes.*`; every registrar here only chooses the prefix and
  names which of the application's collaborators the module receives."
  (:require ["node:fs/promises" :as fsp]
            ["node:http" :as http]
            ["node:https" :as https]
            ["node:path" :as path]
            [proxx.host.objects :as objects]
            [proxx.host.routing :as hr]
            [proxx.http.route-path :as route-path]
            [proxx.http.url :as url]
            [proxx.policy.manifest-path :refer [policy-manifest-path]]
            [proxx.runtime.attempt-executor :as attempt]
            [proxx.runtime.chroma :as chroma-edge]
            [proxx.runtime.federation-relay :as federation-relay]
            [proxx.runtime.federation-routing :as federation-routing]
            [proxx.runtime.http :as http-edge]
            [proxx.runtime.mcp-seed :as mcp-seed]
            [proxx.runtime.ollama :as ollama]
            [proxx.runtime.ollama-cloud-probe :as ollama-cloud-probe]
            [proxx.runtime.provider-routes :as provider-routes]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.quota :as quota]
            [proxx.runtime.responses :as responses]
            [proxx.runtime.routes :as routes]
            [proxx.runtime.routes.credentials :as credential-routes]
            [proxx.runtime.routes.events :as event-routes]
            [proxx.runtime.routes.federation :as federation-routes]
            [proxx.runtime.routes.hosts :as host-routes]
            [proxx.runtime.routes.observability :as observability-routes]
            [proxx.runtime.routes.sessions :as session-routes]
            [proxx.runtime.routes.settings :as settings-routes]
            [proxx.runtime.routes.streams :as stream-routes]
            [proxx.runtime.routes.ws :as ws-routes]
            [proxx.runtime.session :as session]
            [proxx.runtime.sql :as sql]
            [proxx.runtime.strategy :as strategy]
            [proxx.runtime.tenant-key :as tenant-key]
            [proxx.runtime.routing :as routing]))

(def default-tenant-id (.-defaultTenantId ^js (tenant-key/tenant-api-key-constants-js)))

(def api-v1-prefix "/api/v1")

;; ---------------------------------------------------------------------------
;; Collaborators of the model routes
;; ---------------------------------------------------------------------------

(defn v1-collaborators
  "Collaborators of /v1/chat/completions, /v1/responses and /v1/images/generations."
  []
  #js {"defaultTenantId" default-tenant-id
       "resolveModelRouting" hr/resolve-model-routing
       "resolveCatalogAndAlias" hr/resolve-catalog-and-alias
       "selectProviderStrategy" hr/select-provider-strategy
       "selectExecutionStrategyForProviderRoutes" hr/select-execution-strategy-for-provider-routes
       "executeProviderRoutingPlan" hr/execute-provider-routing-plan
       "inspectProviderAvailability" attempt/inspect-provider-availability-js
       "executeLocalStrategy" hr/execute-local-strategy
       "executeBridgeRequestRouting" federation-routing/execute-bridge-request-routing
       "handleRoutingOutcome" hr/handle-routing-outcome
       "getDeclaredProviderRoutes" hr/declared-provider-routes
       "filterDeclaredProviderRoutes" (fn [manifest input] (provider-routes/filter-declared-provider-routes-js manifest input))
       "filterImagesApiRoutes" hr/filter-images-api-routes
       "filterResponsesApiRoutes" hr/filter-responses-api-routes
       "ensureOllamaContextFits" hr/ensure-ollama-context-fits
       "requestHasExplicitNumCtx" ollama/request-has-explicit-num-ctx-js
       "extractPromptCacheKey" http-edge/extract-prompt-cache-key-js
       "hashPromptCacheKey" http-edge/hash-prompt-cache-key-js
       "summarizeResponsesRequestBody" http-edge/summarize-responses-request-body-js
       "resolvableConcreteModelIdsForProviders" routing/resolvable-concrete-model-ids-for-providers-js
       "shouldUseResponsesUpstream" responses/should-use-responses-upstream-js
       "responsesRequestToChatRequest" responses/responses-request-to-chat-request-js
       "chatCompletionToSse" responses/chat-completion-to-sse-js
       "chatCompletionEventStreamToResponsesEventStream" responses/chat-completion-event-stream-to-responses-event-stream-js
       "chatCompletionToResponsesResponse" responses/chat-completion-to-responses-response-js
       "copyInjectedResponseHeaders" hr/copy-injected-response-headers
       "runCljsQueued" hr/run-queued
       "sendQueueError" proxy/send-queue-error-js
       "toErrorMessage" hr/error-message
       "getActiveCljsRuntime" (fn [] hr/policy-runtime)
       "isOpenAiHttpError" objects/open-ai-http-error?
       "makeOpenAiHttpError" objects/make-open-ai-http-error})

(defn embeddings-collaborators []
  #js {"defaultTenantId" default-tenant-id
       "resolveModelRouting" hr/resolve-model-routing
       "getDeclaredProviderRoutes" hr/declared-provider-routes
       "filterDeclaredProviderRoutes" (fn [manifest input] (provider-routes/filter-declared-provider-routes-js manifest input))
       "stripModelPrefix" routing/strip-model-prefix-js
       "isOpenAiCompatEmbedProvider" (fn [provider-id] (strategy/is-compat-embedding-provider-js provider-id js/undefined))
       "normalizeLlamacppModelName" strategy/normalize-llamacpp-model-name-js
       "ensureNativeOllamaEmbedContextFits" hr/ensure-native-ollama-embed-context-fits
       "runCljsQueued" hr/run-queued
       "sendQueueError" proxy/send-queue-error-js
       "joinUrl" url/join-url
       "fetchWithResponseTimeout" http-edge/fetch-with-response-timeout-js
       "toErrorMessage" hr/error-message
       "getActiveCljsRuntime" (fn [] hr/policy-runtime)
       "makeOpenAiHttpError" objects/make-open-ai-http-error})

;; --- media ---

(defn- headers->incoming [^js headers]
  (let [result #js {}]
    (.forEach headers (fn [value name] (aset result name value)))
    result))

(defn- headers-from-incoming [^js incoming]
  (let [result (js/Headers.)]
    (doseq [k (js/Object.keys incoming)]
      (let [v (aget incoming k)]
        (cond (js/Array.isArray v) (doseq [entry (array-seq v)] (.append result k entry))
              (string? v) (.set result k v)
              (number? v) (.set result k (str v)))))
    result))

(defn- post-media-json
  "POST `body-text` to `upstream-url`; resolves to {status, headers (Headers), text}."
  [upstream-url headers body-text timeout-ms]
  (js/Promise.
   (fn [resolve reject]
     (let [parsed (js/URL. upstream-url)
           request-fn (if (= "http:" (.-protocol parsed)) (.-request http) (.-request https))
           ^js upstream-request
           (request-fn parsed
                       #js {"method" "POST" "headers" (headers->incoming (js/Headers. headers)) "timeout" timeout-ms}
                       (fn [^js upstream-response]
                         (let [chunks #js []]
                           (.on upstream-response "data"
                                (fn [chunk] (.push chunks (if (js/Buffer.isBuffer chunk) chunk (js/Buffer.from chunk)))))
                           (.on upstream-response "end"
                                (fn []
                                  (resolve #js {"status" (or (.-statusCode upstream-response) 502)
                                                "headers" (headers-from-incoming (.-headers upstream-response))
                                                "text" (.toString (js/Buffer.concat chunks) "utf8")}))))))]
       (.on upstream-request "timeout"
            (fn [] (.destroy upstream-request (js/Error. (str "BlazeAPI media request timed out after " timeout-ms "ms")))))
       (.on upstream-request "error" reject)
       (.write upstream-request body-text)
       (.end upstream-request)))))

(defn- ^:async save-generated-audio
  "Write the generated audio and its transcript beside it; resolves to the byte length. A failed
  write is not an error of the request."
  [^js input]
  (let [audio-bytes (js/Buffer.from (.-rawAudio input) (if (= "hex" (.-encoding input)) "hex" "base64"))
        file-path (.-filePath input)]
    (try (await (.mkdir fsp "/app/data/blaze_generated" #js {"recursive" true}))
         (await (.writeFile fsp file-path audio-bytes))
         (await (.writeFile fsp (.replace file-path (js/RegExp. "\\.(mp3|wav)$" "i") ".json") (.-text input) "utf8"))
         (catch :default _ nil))
    (.-length audio-bytes)))

(defn media-collaborators []
  #js {"postMediaJson" post-media-json
       "saveGeneratedAudio" save-generated-audio
       "buildCredentialHeaders" (fn [client-headers account]
                                  (js/Headers. (proxy/upstream-headers-for-credential-js client-headers account js/undefined)))
       "copyUpstreamHeaders" (fn [^js reply ^js upstream-headers]
                               (doseq [[k v] (array-seq (proxy/forwardable-response-headers-js
                                                         (js/Array.from (.entries upstream-headers))))]
                                 (.header reply k v)))
       "toErrorMessage" hr/error-message
       "joinUrl" url/join-url
       "getActiveCljsRuntime" (fn [] hr/policy-runtime)})

;; ---------------------------------------------------------------------------
;; UI / API routes
;; ---------------------------------------------------------------------------

(defn- auth-deps
  "What the authenticated stream routes need to resolve a caller."
  [^js deps]
  #js {"proxyAuthToken" (.-proxyAuthToken ^js (.-config deps))
       "sqlCredentialStore" (.-sqlCredentialStore deps)
       "authPersistence" (.-authPersistence deps)
       "proxyTokenPepper" (.-proxyTokenPepper ^js (.-config deps))
       "defaultTenantId" default-tenant-id})

(defn ^:async register-web-socket-routes
  "Upgrade handlers for the bridge and request-log sockets. Resolves to {bridgeRelay, requestLogWsHub}."
  [app deps]
  (let [^js ad (auth-deps deps)]
    (aset ad "requestLogStore" (.-requestLogStore ^js deps))
    (aset ad "createBridgeRelay" federation-relay/create-relay-js)
    (aset ad "createRequestLogWsHub" objects/create-request-log-ws-hub)
    (ws-routes/register-web-socket-routes-js app ad)))

(defn ^:async register-bridge-sse-routes [app deps bridge-relay]
  (stream-routes/register-bridge-sse-routes-js app (auth-deps deps) bridge-relay))

(defn ^:async register-request-log-sse-routes [app deps hub]
  (stream-routes/register-request-log-sse-routes-js app (auth-deps deps) hub))

(def ^:private warm-import-threshold
  (sql/federation-warm-import-threshold-js (aget js/process.env "FEDERATION_WARM_IMPORT_REQUEST_THRESHOLD")))

(defn- warm-import?
  ([warm-request-count] (warm-import? warm-request-count warm-import-threshold))
  ([warm-request-count threshold]
   (sql/federation-should-warm-import-js warm-request-count (if (undefined? threshold) warm-import-threshold threshold))))

(defn- federation-deps [^js app ^js deps]
  #js {"env" js/process.env
       "openaiProviderId" (.-openaiProviderId ^js (.-config deps))
       "sqlFederationStore" (.-sqlFederationStore deps)
       "sqlTenantProviderPolicyStore" (.-sqlTenantProviderPolicyStore deps)
       "sqlRequestUsageStore" (.-sqlRequestUsageStore deps)
       "sqlCredentialStore" (.-sqlCredentialStore deps)
       "credentialStore" (.-credentialStore deps)
       "keyPool" (.-keyPool deps)
       "requestLogStore" (.-requestLogStore deps)
       "bridgeRelay" (.-bridgeRelay deps)
       "refreshOpenAiOauthAccounts" (.-refreshOpenAiOauthAccounts deps)
       "shouldWarmImportProjectedAccount" warm-import?
       "log" (.-log app)})

(defn- register-federation [app deps]
  (federation-routes/register-federation-routes-js app (federation-deps app deps) api-v1-prefix))

(defn- register-settings [^js app ^js deps]
  (settings-routes/register-settings-routes-js
   app #js {"proxySettingsStore" (.-proxySettingsStore deps)
            "sqlCredentialStore" (.-sqlCredentialStore deps)
            "authPersistence" (.-authPersistence deps)
            "proxyTokenPepper" (.-proxyTokenPepper ^js (.-config deps))
            "log" (.-log app)}
   (route-path/join api-v1-prefix "")))

(defn- nullish-env [k default]
  (let [v (aget js/process.env k)] (if (nil? v) default v)))

(defn- register-sessions [^js app ^js deps]
  (let [ollama-base-url (.-ollamaBaseUrl ^js (.-config deps))
        _ (objects/register-ollama-embedding-function!)
        session-store (session/create-session-store-js (.resolve path (js/process.cwd) "data/sessions.json"))
        session-index (chroma-edge/create-chroma-session-index-js
                       #js {"url" (nullish-env "CHROMA_URL" "http://127.0.0.1:8000")
                            "collectionName" (nullish-env "CHROMA_COLLECTION" "open_hax_proxy_sessions")}
                       #js {"ChromaClient" (objects/chroma-client-class)
                            "IncludeEnum" (objects/chroma-include-enum)
                            "embeddingFunction" (objects/make-ollama-embedding-function
                                                 ollama-base-url (nullish-env "CHROMA_EMBED_MODEL" "nomic-embed-text:latest"))})]
    (session-routes/register-session-routes-js
     app #js {"sessionStore" session-store
              "sessionIndex" session-index
              "warn" (fn [error]
                       (.warn (.-log app) #js {"error" (hr/error-message error)}
                              "failed to warm semantic session index from stored sessions"))}
     api-v1-prefix)))

(def ^:private route-contexts
  "Per credential store: the OAuth managers its routes share (the same store is registered under
  more than one prefix)."
  (js/WeakMap.))

(defn- credential-route-context [^js deps]
  (let [store (.-credentialStore deps)]
    (or (.get route-contexts store)
        (let [^js config (.-config deps)
              context #js {"credentialStore" store
                           "openAiOAuthManager" (objects/create-openai-oauth-manager
                                                 #js {"allowHostRoutedCallbacks" (.-openaiOauthAllowHostRoutedCallbacks config)
                                                      "oauthScopes" (.-openaiOauthScopes config)
                                                      "clientId" (.-openaiOauthClientId config)
                                                      "issuer" (.-openaiOauthIssuer config)
                                                      "clientSecret" (.-openaiOauthClientSecret config)})
                           "factoryOAuthManager" (objects/create-factory-oauth-manager #js {})
                           "pendingOpenAiBrowserReauthTargets" (js/Map.)}]
          (.set route-contexts store context)
          context))))

(defn- register-credentials [^js app ^js deps]
  (let [^js context (credential-route-context deps)]
    (credential-routes/register-credential-routes-js
     app #js {"config" (.-config deps)
              "keyPool" (.-keyPool deps)
              "credentialStore" (.-credentialStore context)
              "requestLogStore" (.-requestLogStore deps)
              "sqlCredentialStore" (.-sqlCredentialStore deps)
              "sqlRequestUsageStore" (.-sqlRequestUsageStore deps)
              "refreshOpenAiOauthAccounts" (.-refreshOpenAiOauthAccounts deps)
              "openAiOAuthManager" (.-openAiOAuthManager context)
              "factoryOAuthManager" (.-factoryOAuthManager context)
              "pendingOpenAiBrowserReauthTargets" (.-pendingOpenAiBrowserReauthTargets context)
              "fetchOpenAiQuotaSnapshots" (fn [store options] (quota/fetch-openai-quota-snapshots-js (policy-manifest-path) store options))
              "probeOpenAiAccount" (fn [store options] (quota/probe-openai-account-js (policy-manifest-path) store options))
              "probeOllamaCloudAccount" ollama-cloud-probe/probe-ollama-cloud-account-js
              "log" (.-log app)}
     (route-path/join api-v1-prefix "")
     true)))

(defn register-observability-routes
  "Request-log, analytics, tool and MCP routes; `options` is {prefix, include* flags} (the legacy
  /api/ui surface passes none)."
  [app ^js deps options]
  (observability-routes/register-observability-routes-js
   app #js {"requestLogStore" (.-requestLogStore deps)
            "keyPool" (.-keyPool deps)
            "credentialStore" (.-credentialStore deps)
            "sqlRequestUsageStore" (.-sqlRequestUsageStore deps)
            "getToolSeedForModel" mcp-seed/get-tool-seed-for-model-js
            "loadMcpSeeds" mcp-seed/load-mcp-seeds-js}
   options))

(defn ^:async register-api-v1-routes
  "The /api/v1 surface, in registration order."
  [app deps]
  (register-federation app deps)
  (register-settings app deps)
  (register-sessions app deps)
  (register-credentials app deps)
  (host-routes/register-host-routes-js app js/process.env api-v1-prefix)
  (event-routes/register-event-routes-js app (.-eventStore ^js deps))
  (register-observability-routes app deps #js {"prefix" api-v1-prefix})
  (routes/register-api-v1-index-route-js app))

(defn federation-route-path
  "Path of a federation route under the legacy /api/ui prefix unless `options.prefix` says otherwise."
  [suffix ^js options]
  (route-path/join (or (some-> options .-prefix) "/api/ui") suffix))

(defn execute-federated-request-routing [deps input]
  (federation-routing/execute-federated-request-routing
   deps input #js {"resolveFederationRoutePath" federation-route-path}))
