(ns proxx.support.app
  "A real in-process Proxx application in front of a real local upstream HTTP
  server whose behaviour each test supplies as a function (the fixture the
  TypeScript `withProxyApp` helpers built).

  The application is `proxx.app.main/create-app-js` over the host module
  (`src/app.ts`, loaded through tsx: the stores and route collaborators are
  still TypeScript classes); the decisions run in the built CLJS runtime
  (`dist/cljs`, so run `pnpm build:cljs` before the tests that use this)."
  (:require ["node:fs/promises" :as fsp]
            ["node:http" :as http]
            ["node:os" :as os]
            ["node:path" :as path]
            ["node:url" :as url]
            [proxx.app.main :as app-main]))

(set! *warn-on-infer* false)

(def ^:private import-module
  "Dynamic `import()` through Node's main-context loader. The test bundle is
  evaluated by shadow-cljs without an import callback (so a bare `import()` throws
  ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING); a `vm.Script` naming the default loader gets one."
  (let [^js vm (js/require "node:vm")
        script (vm.Script. "(specifier) => import(specifier)"
                           #js {"importModuleDynamically" (.. vm -constants -USE_MAIN_CONTEXT_DEFAULT_LOADER)})]
    (.runInThisContext script)))

(defn- file-url [relative]
  (.-href (.pathToFileURL url (.resolve path (js/process.cwd) relative))))

(defonce ^:private host-modules (atom nil))

(defn- ^:async load-host-modules []
  (let [^js tsx (await (import-module (file-url "node_modules/tsx/dist/esm/api/index.mjs")))]
    (.register tsx)
    (let [^js app-module (await (import-module (file-url "src/app.ts")))
          ^js runtime-module (await (import-module (file-url "src/lib/cljs-runtime.ts")))]
      (await (.prepare app-module))
      {:app app-module :runtime runtime-module})))

(defn- ^:async host []
  (when-not @host-modules
    (reset! host-modules (load-host-modules)))
  (await @host-modules))

(defn- read-request-body [^js request]
  (js/Promise. (fn [resolve reject]
                 (let [chunks #js []]
                   (.on request "data" (fn [chunk] (.push chunks chunk)))
                   (.on request "end" (fn [] (resolve (.toString (js/Buffer.concat chunks) "utf8"))))
                   (.on request "error" reject)))))

(defn- ^:async start-upstream
  "A local HTTP server answering with `(handler request body)` => Promise of
  `{:status :headers :body}`. Model-catalog probes get a 404 unless `handle-catalog?`."
  [handler handle-catalog?]
  (let [server (.createServer
                http
                (fn ^:async on-request [^js request ^js response]
                  (let [body (await (read-request-body request))
                        bypass? (or (and (= "GET" (.-method request)) (= "/v1/models" (.-url request)))
                                    (and (= "GET" (.-method request)) (= "/api/tags" (.-url request))))]
                    (if (and bypass? (not handle-catalog?))
                      (do (aset response "statusCode" 404)
                          (.setHeader response "content-type" "application/json")
                          (.end response (js/JSON.stringify #js {:error #js {:message "catalog not configured"}})))
                      (try
                        (let [result (await (handler request body))]
                          (aset response "statusCode" (:status result))
                          (doseq [[k v] (:headers result)] (.setHeader response (name k) v))
                          (.end response (:body result)))
                        (catch :default error
                          (aset response "statusCode" 500)
                          (.setHeader response "content-type" "application/json")
                          (.end response (js/JSON.stringify #js {:error #js {:message (str error)}}))))))))]
    (.listen server 0 "127.0.0.1")
    (await (js/Promise. (fn [resolve _] (.once server "listening" resolve))))
    server))

(defn- proxy-config
  "The ProxyConfig the TypeScript fixture built by hand, pointed at `base-url`."
  [{:keys [base-url keys-path models-path request-logs-path prompt-affinity-path settings-path overrides]}]
  (let [m (merge
           {"host" "127.0.0.1" "port" 0 "upstreamProviderId" "vivgrid" "disabledProviderIds" []
            "upstreamProviderBaseUrls" {"vivgrid" base-url "ollama-cloud" base-url "openai" base-url
                                        "openrouter" base-url "requesty" base-url "gemini" base-url "factory" base-url}
            "upstreamBaseUrl" base-url "openaiProviderId" "openai" "openaiBaseUrl" base-url "openaiApiBaseUrl" base-url
            "openaiImagesUpstreamMode" "auto" "ollamaBaseUrl" base-url "localOllamaEnabled" false "localOllamaModelPatterns" []
            "chatCompletionsPath" "/v1/chat/completions" "openaiChatCompletionsPath" "/v1/chat/completions"
            "messagesPath" "/v1/messages" "messagesModelPrefixes" ["claude-"]
            "messagesInterleavedThinkingBeta" "interleaved-thinking-2025-05-14"
            "responsesPath" "/v1/responses" "openaiResponsesPath" "/v1/responses"
            "openaiImagesGenerationsPaths" ["/v1/images/generations" "/images/generations" "/codex/images/generations"]
            "imageCostUsdDefault" 0 "imageCostUsdByProvider" {} "imagesGenerationsPath" "/v1/images/generations"
            "responsesModelPrefixes" ["gpt-"] "ollamaChatPath" "/api/chat" "ollamaV1ChatPath" "/v1/chat/completions"
            "factoryModelPrefixes" ["factory/" "factory:"] "openaiModelPrefixes" ["openai/" "openai:"]
            "ollamaModelPrefixes" ["ollama/" "ollama:"]
            "keysFilePath" keys-path "modelsFilePath" models-path "requestLogsFilePath" request-logs-path
            "requestLogsMaxEntries" 100000 "requestLogsFlushMs" 0
            "promptAffinityFilePath" prompt-affinity-path "promptAffinityFlushMs" 0 "settingsFilePath" settings-path
            "keyReloadMs" 50 "keyCooldownMs" 10000 "keyCooldownJitterFactor" 0.4 "enableKeyRandomWalk" true
            "ollamaWeeklyCooldownMultiplier" 24 "requestTimeoutMs" 2000 "streamBootstrapTimeoutMs" 2000
            "embedMaxContextTokens" 262144 "embedMaxBatchItems" 128 "embedMaxInputChars" 250000
            "upstreamTransientRetryCount" 0 "upstreamTransientRetryBackoffMs" 1
            "allowUnauthenticated" true "githubOAuthCallbackPath" "/auth/github/callback" "githubAllowedUsers" []
            "sessionSecret" "test-session-token" ; pragma: allowlist secret
            "openaiOauthScopes" "openid profile email offline_access"
            "openaiOauthClientId" "app_EMoamEEZ73f0CkXaXp7hrann" "openaiOauthIssuer" "https://auth.openai.com"}
           overrides)
        m (merge {"proxyTokenPepper" "test-proxy-token-pepper" "oauthRefreshMaxConcurrency" 32
                  "oauthRefreshBackgroundIntervalMs" 15000 "oauthRefreshProactiveWindowMs" (* 30 60000)
                  "concurrencyThrottleMaxRetries" 3 "concurrencyThrottleThresholdMs" 30000}
                 m)]
    (clj->js m)))

(defn ^:async with-proxy-app
  "Run async `f` with `{:app :upstream :temp-dir}`: an application whose provider
  base URLs all point at a local upstream answering through `:upstream-handler`.
  Options: `:keys-payload` (clj, written as keys.json), `:models`,
  `:handle-model-catalog`, `:config-overrides` (map of ProxyConfig property -> value)."
  [{:keys [keys-payload models handle-model-catalog config-overrides upstream-handler]} f]
  (let [temp-dir (await (.mkdtemp fsp (.join path (.tmpdir os) "proxx-app-test-")))
        keys-path (.join path temp-dir "keys.json")
        models-path (.join path temp-dir "models.json")
        _ (await (.writeFile fsp keys-path (js/JSON.stringify (clj->js keys-payload) nil 2) "utf8"))
        _ (when models (await (.writeFile fsp models-path (js/JSON.stringify (clj->js models) nil 2) "utf8")))
        upstream (await (start-upstream upstream-handler handle-model-catalog))
        base-url (str "http://127.0.0.1:" (.-port (.address upstream)))
        config (proxy-config {:base-url base-url :keys-path keys-path :models-path models-path
                              :request-logs-path (.join path temp-dir "request-logs.jsonl")
                              :prompt-affinity-path (.join path temp-dir "prompt-affinity.json")
                              :settings-path (.join path temp-dir "proxy-settings.json")
                              :overrides config-overrides})
        {:keys [app runtime]} (await (host))
        ^js runtime-module runtime
        previous-runtime (.getActiveCljsRuntime runtime-module)
        ^js application (await (app-main/create-app-js config (.-host ^js app)))]
    (try
      (await (f {:app application :upstream upstream :temp-dir temp-dir}))
      (finally
        (await (.close application))
        (.setActiveCljsRuntime runtime-module previous-runtime)
        (await (js/Promise. (fn [resolve reject] (.close upstream (fn [error] (if error (reject error) (resolve nil)))))))
        (await (.rm fsp temp-dir #js {:recursive true :force true}))))))
