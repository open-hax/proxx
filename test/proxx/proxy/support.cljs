(ns proxx.proxy.support
  "Test support for the end-to-end proxy tests (formerly the helpers of
  src/tests/proxy.test.ts): a real in-process Fastify application built by the
  host module (`src/app.ts`, loaded through tsx) in front of a real local
  upstream HTTP server whose behaviour each test supplies as a function.

  The application under test is the built CLJS runtime (`dist/cljs`, so run
  `pnpm build:cljs` first) composed over the host's stores and pools; this
  namespace only builds fixtures and never decides anything itself."
  (:require ["node:fs/promises" :as fsp]
            ["node:http" :as http]
            ["node:os" :as os]
            ["node:path" :as path]
            ["node:url" :as url]
            [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Host module (TypeScript through tsx), loaded once per process
;; ---------------------------------------------------------------------------

(def ^:private import-module
  "Dynamic `import()` through Node's main-context loader. The test bundle is
  evaluated by shadow-cljs without an import callback (so a bare `import()` or
  `new Function` throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING); a `vm.Script`
  that names the default loader gets one."
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

;; ---------------------------------------------------------------------------
;; Small fixtures
;; ---------------------------------------------------------------------------

(defn json-str [x] (js/JSON.stringify (clj->js x)))

(defn parse-json [s] (js->clj (js/JSON.parse s)))

(defn make-jwt [payload]
  (let [b64 (fn [x] (.toString (js/Buffer.from (json-str x)) "base64url"))]
    (str (b64 {"alg" "none" "typ" "JWT"}) "." (b64 payload) ".sig")))

(defn bearer-token
  "The token of an `Authorization: Bearer …` request header, or nil."
  [^js request]
  (when-let [auth (aget (.-headers request) "authorization")]
    (when (string? auth) (str/replace auth #"(?i)^Bearer\s+" ""))))

(defn header [^js request name] (aget (.-headers request) name))

(defn sleep [ms] (js/Promise. (fn [resolve _] (js/setTimeout resolve ms))))

(defn json-response
  ([status body] (json-response status {} body))
  ([status headers body]
   {:status status
    :headers (merge {"content-type" "application/json"} headers)
    :body (if (string? body) body (json-str body))}))

(defn embed-response
  "The canned answer to the proxy's own embedding probes (/api/embed, /api/embeddings)."
  []
  (json-response 200 {"embeddings" [[0.1 0.2 0.3]]}))

(defn embed-request? [^js request]
  (contains? #{"/api/embed" "/api/embeddings"} (.-url request)))

(defn chat-completion
  "A minimal single-choice chat completion upstream answer."
  [id model content]
  {"id" id "object" "chat.completion" "created" 1 "model" model
   "choices" [{"index" 0 "message" {"role" "assistant" "content" content} "finish_reason" "stop"}]})

(defn response-output
  "A minimal Responses-API answer carrying one assistant message."
  [{:keys [id message-id model created-at text usage]}]
  (cond-> {"id" id "object" "response" "created_at" created-at "model" model
           "output" [{"id" message-id "type" "message" "role" "assistant"
                      "content" [{"type" "output_text" "text" text}]}]}
    usage (assoc "usage" usage)))

;; ---------------------------------------------------------------------------
;; Environment and fetch scoping
;; ---------------------------------------------------------------------------

(def ^:private ambient-provider-env-names
  ["ROTUSSY_API_KEY" "ROTUSSY_PROVIDER_ID" "FACTORY_API_KEY" "GEMINI_API_KEY" "ZAI_API_KEY"
   "ZHIPU_API_KEY" "MISTRAL_API_KEY" "OPENROUTER_API_KEY" "REQUESTY_API_TOKEN" "REQUESTY_API_KEY"
   "ZEN_API_KEY" "ZENMUX_API_KEY"])

(defonce ^:private ambient-provider-env
  (into {} (map (fn [k] [k (aget js/process.env k)])) ambient-provider-env-names))

(defn- env-get [k] (aget js/process.env k))

(defn- env-set! [k v]
  (if (nil? v) (js-delete js/process.env k) (aset js/process.env k v)))

(defn ^:async with-env
  "Run `f` with the given environment variables set (nil deletes), restoring them afterwards."
  [values f]
  (let [previous (into {} (map (fn [k] [k (env-get k)])) (keys values))]
    (doseq [[k v] values] (env-set! k v))
    (try (await (f))
         (finally (doseq [[k v] previous] (env-set! k v))))))

(defn ^:async with-patched-fetch
  "Run `f` with global fetch replaced by one that asks `handler` first
  (`(handler input init original-fetch)` -> Promise<Response|nil>) and falls
  through to the real fetch when it answers nil."
  [handler f]
  (let [original (.-fetch js/globalThis)]
    (aset js/globalThis "fetch"
          (fn ^:async patched [input init]
            (or (await (handler input init original))
                (await (original input init)))))
    (try (await (f))
         (finally (aset js/globalThis "fetch" original)))))

(defn request-url
  "The URL string of a fetch input (string, URL or Request)."
  [input]
  (cond (string? input) input
        (instance? js/URL input) (.toString input)
        :else (.-url ^js input)))

(defn ^:async with-cleared-ambient-providers [f]
  (let [file-default (fn [k placeholder] (or (env-get k) placeholder))
        values (into {"FACTORY_AUTH_V2_FILE" (file-default "FACTORY_AUTH_V2_FILE" "/tmp/nonexistent-auth-v2-file")
                      "FACTORY_AUTH_V2_KEY" (file-default "FACTORY_AUTH_V2_KEY" "/tmp/nonexistent-auth-v2-key")}
                     (keep (fn [k] (when (= (env-get k) (get ambient-provider-env k)) [k nil])))
                     ambient-provider-env-names)]
    (await (with-env values f))))

;; ---------------------------------------------------------------------------
;; The upstream server and the application
;; ---------------------------------------------------------------------------

(defn- ^:async read-request-body [^js request]
  (js/Promise.
   (fn [resolve reject]
     (let [chunks (array)]
       (.on request "data" (fn [chunk] (.push chunks (if (js/Buffer.isBuffer chunk) chunk (js/Buffer.from chunk)))))
       (.on request "end" (fn [] (resolve (.toString (js/Buffer.concat chunks) "utf8"))))
       (.on request "error" reject)))))

(defn- make-upstream [{:keys [upstream-handler handle-model-catalog]}]
  (.createServer
   http
   (fn ^:async serve [^js request ^js response]
     (let [body (await (read-request-body request))
           catalog? (or (and (= "GET" (.-method request)) (= "/v1/models" (.-url request)))
                        (and (= "GET" (.-method request)) (= "/api/tags" (.-url request))))]
       (if (and catalog? (not handle-model-catalog))
         (do (set! (.-statusCode response) 404)
             (.setHeader response "content-type" "application/json")
             (.end response (json-str {"error" {"message" "catalog not configured"}})))
         (try
           (let [result (await (upstream-handler request body))]
             (set! (.-statusCode response) (:status result))
             (doseq [[k v] (:headers result)] (.setHeader response k v))
             (if-let [stream-body (:stream-body result)]
               (await (stream-body response))
               (.end response (or (:body result) ""))))
           (catch :default error
             (set! (.-statusCode response) 500)
             (.setHeader response "content-type" "application/json")
             (.end response (json-str {"error" {"message" (str error)}})))))))))

(defn- default-config [port {:keys [keys-path models-path request-logs-path prompt-affinity-path settings-path
                                    proxy-auth-token allow-unauthenticated config-overrides]}]
  (let [base (str "http://127.0.0.1:" port)
        override (fn [k default] (get config-overrides k default))]
    {:host "127.0.0.1"
     :port 0
     :upstreamProviderId "vivgrid"
     :disabledProviderIds []
     :upstreamProviderBaseUrls {"vivgrid" base "ollama-cloud" base "ob1" base "openai" base
                                "openrouter" base "requesty" base "gemini" base
                                "zai" (str base "/api/paas/v4") "mistral" (str base "/v1")
                                "rotussy" (str base "/v1") "llamacpp-embed" base}
     :upstreamBaseUrl base
     :openaiProviderId "openai"
     :openaiBaseUrl base
     :openaiApiBaseUrl base
     :openaiImagesUpstreamMode "auto"
     :ollamaBaseUrl base
     :localOllamaEnabled true
     :localOllamaModelPatterns [":2b" ":3b" ":4b" ":7b" ":8b" "mini" "small"]
     :chatCompletionsPath "/v1/chat/completions"
     :openaiChatCompletionsPath "/v1/chat/completions"
     :messagesPath "/v1/messages"
     :messagesModelPrefixes ["claude-"]
     :messagesInterleavedThinkingBeta "interleaved-thinking-2025-05-14"
     :responsesPath "/v1/responses"
     :openaiResponsesPath "/v1/responses"
     :openaiImagesGenerationsPaths ["/v1/images/generations" "/images/generations" "/codex/images/generations"]
     :imageCostUsdDefault 0
     :imageCostUsdByProvider {}
     :imagesGenerationsPath "/v1/images/generations"
     :responsesModelPrefixes ["gpt-"]
     :ollamaChatPath "/api/chat"
     :ollamaV1ChatPath "/v1/chat/completions"
     :factoryModelPrefixes ["factory/" "factory:"]
     :openaiModelPrefixes ["openai/" "openai:"]
     :ollamaModelPrefixes ["ollama/" "ollama:"]
     :llamacppModelPrefixes ["llamacpp/" "llamacpp:" "llamacpp-embed/" "llamacpp-embed:"]
     :keysFilePath keys-path
     :modelsFilePath models-path
     :requestLogsFilePath request-logs-path
     :requestLogsMaxEntries 100000
     :requestLogsFlushMs 0
     :promptAffinityFilePath prompt-affinity-path
     :promptAffinityFlushMs 0
     :settingsFilePath settings-path
     :keyReloadMs 50
     :keyCooldownMs 10000
     :keyCooldownJitterFactor 0
     :enableKeyRandomWalk false
     :ollamaWeeklyCooldownMultiplier 24
     :requestTimeoutMs 2000
     :streamBootstrapTimeoutMs 2000
     :embedMaxContextTokens 262144
     :embedMaxBatchItems 128
     :embedMaxInputChars 250000
     :upstreamTransientRetryCount 2
     :upstreamTransientRetryBackoffMs 1
     :proxyAuthToken proxy-auth-token
     :allowUnauthenticated (if (some? allow-unauthenticated) allow-unauthenticated (nil? proxy-auth-token))
     :githubOAuthCallbackPath "/auth/github/callback"
     :githubAllowedUsers []
     :sessionSecret "test-session-token" ; pragma: allowlist secret
     :openaiOauthScopes "openid profile email offline_access"
     :openaiOauthClientId "app_EMoamEEZ73f0CkXaXp7hrann"
     :openaiOauthIssuer "https://auth.openai.com"
     :proxyTokenPepper (override :proxyTokenPepper "test-proxy-token-pepper")
     :oauthRefreshMaxConcurrency (override :oauthRefreshMaxConcurrency 32)
     :oauthRefreshBackgroundIntervalMs (override :oauthRefreshBackgroundIntervalMs 15000)
     :oauthRefreshProactiveWindowMs (override :oauthRefreshProactiveWindowMs (* 30 60000))
     :concurrencyThrottleMaxRetries (override :concurrencyThrottleMaxRetries 3)
     :concurrencyThrottleThresholdMs (override :concurrencyThrottleThresholdMs 30000)
     :cljsPolicyManifestPath "resources/policies/runtime/00-manifest.edn"
     :cljsPolicyAuthoritative (override :cljsPolicyAuthoritative false)
     :cljsPolicyShadowMode (override :cljsPolicyShadowMode false)}))

(defn- merge-config [defaults overrides]
  (-> (merge defaults overrides)
      (assoc :upstreamProviderBaseUrls
             (merge (:upstreamProviderBaseUrls defaults) (:upstreamProviderBaseUrls overrides)))))

(defn- write-json! [file value]
  (.writeFile fsp file (js/JSON.stringify (clj->js value) nil 2) "utf8"))

(defn ^:async with-proxy-app
  "Start an upstream HTTP server driven by `:upstream-handler` and the proxy
  application in front of it, run `(f {:app :upstream :temp-dir})` and tear both
  down. `:upstream-handler` is `(fn [request body])` returning (a Promise of)
  `{:status :headers :body}` or `{:status :headers :stream-body (fn [response])}`.
  Options: `:keys`, `:keys-payload`, `:request-logs-payload`, `:models`,
  `:handle-model-catalog`, `:proxy-auth-token`, `:allow-unauthenticated`,
  `:config-overrides` (camelCase keyword -> value, merged over the defaults)."
  [{:keys [keys keys-payload request-logs-payload models config-overrides] :as options} f]
  (let [temp-dir (await (.mkdtemp fsp (.join path (.tmpdir os) "open-hax-proxy-test-")))
        file (fn [name] (.join path temp-dir name))
        keys-path (file "keys.json")
        models-path (file "models.json")
        request-logs-path (file "request-logs.jsonl")
        _ (await (write-json! keys-path (or keys-payload {"keys" (vec keys)})))
        _ (when (some? request-logs-payload) (await (write-json! request-logs-path request-logs-payload)))
        _ (when models (await (write-json! models-path models)))
        ^js upstream (make-upstream options)]
    (.listen upstream 0 "127.0.0.1")
    (await (js/Promise. (fn [resolve _] (.once upstream "listening" resolve))))
    (let [port (.-port ^js (.address upstream))
          config (-> (default-config port (assoc options
                                                 :keys-path keys-path :models-path models-path
                                                 :request-logs-path request-logs-path
                                                 :prompt-affinity-path (file "prompt-affinity.json")
                                                 :settings-path (file "proxy-settings.json")))
                     (merge-config config-overrides))
          ;; undefined (not null) is how the host spells "unset"
          js-config (let [o (clj->js (into {} (remove (comp nil? val)) config))] o)
          {:keys [^js app ^js runtime]} (await (host))]
      (await
       (with-cleared-ambient-providers
         (fn ^:async run []
           (let [previous (.getActiveCljsRuntime runtime)
                 ^js application (await (.createApp app js-config))]
             (try (await (f {:app application :upstream upstream :temp-dir temp-dir}))
                  (finally
                    (await (.close application))
                    (.setActiveCljsRuntime runtime previous)
                    (await (js/Promise. (fn [resolve reject]
                                          (.close upstream (fn [error] (if error (reject error) (resolve nil)))))))
                    (await (.rm fsp temp-dir #js {"recursive" true "force" true}))))))))
      nil)))

(defn ^:async with-env-proxy-app
  "`with-env` around `with-proxy-app`."
  [env options f]
  (await (with-env env (fn ^:async run [] (await (with-proxy-app options f))))))

(defn ^:async with-zai-proxy-app
  "The z.ai variant: ZAI_API_KEY configured, z.ai the default upstream provider, local ollama off."
  [upstream-handler f]
  (await
   (with-env {"ZAI_API_KEY" "zai-key-1" ; pragma: allowlist secret
              "ZAI_PROVIDER_ID" nil "ROTUSSY_API_KEY" nil "ROTUSSY_PROVIDER_ID" nil
              "GEMINI_API_KEY" nil "OPENROUTER_API_KEY" nil "REQUESTY_API_TOKEN" nil "REQUESTY_API_KEY" nil}
     (fn ^:async run []
       (await (with-proxy-app {:keys [] :keys-payload {"providers" {}}
                               :config-overrides {:upstreamProviderId "zai" :localOllamaEnabled false}
                               :upstream-handler upstream-handler}
                f))))))

;; ---------------------------------------------------------------------------
;; Calling the application
;; ---------------------------------------------------------------------------

(defn ^:async inject
  "`app.inject` with plain-data options; the result is
  `{:status :headers :json :text}` (`:json` nil unless the body is JSON)."
  [^js app options]
  (let [^js res (await (.inject app (clj->js options)))]
    {:status (.-statusCode res)
     :headers (js->clj (.-headers res))
     :text (.-payload res)
     :json (try (js->clj (.json res)) (catch :default _ nil))}))

(defn ^:async post-json
  "POST a JSON `payload` to `url` with the given extra `headers`."
  ([app url payload] (post-json app url payload {}))
  ([app url payload headers]
   (await (inject app {:method "POST" :url url
                       :headers (merge {"content-type" "application/json"} headers)
                       :payload payload}))))

(def local-auth {"authorization" "Bearer local-test"})
