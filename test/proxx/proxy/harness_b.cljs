(ns proxx.proxy.harness-b
  "Harness for the end-to-end proxy tests (formerly `withProxyApp` and friends in
  src/tests/proxy.test.ts): a real in-process Fastify application (`proxx.app.main`
  over the TypeScript host's stores, loaded through tsx) in front of a real local
  HTTP server standing in for the upstream providers.

  Requires the release runtime (`pnpm build:cljs`): the host's stores call the
  built kernels.

  The upstream handler is `(fn [request body])` -> `{:status :headers :body}` or
  `{:status :headers :stream-body (fn [response])}`, possibly returning a Promise;
  `request` is the Node IncomingMessage, `body` the request text."
  (:require ["node:fs/promises" :as fsp]
            ["node:http" :as http]
            ["node:os" :as os]
            ["node:path" :as path]
            ["node:url" :as url]
            [clojure.string :as str]
            [proxx.app.main :as app-main]))

(def ^:private ambient-provider-env-names
  ["ROTUSSY_API_KEY" "ROTUSSY_PROVIDER_ID" "FACTORY_API_KEY" "GEMINI_API_KEY" "ZAI_API_KEY" "ZHIPU_API_KEY"
   "MISTRAL_API_KEY" "OPENROUTER_API_KEY" "REQUESTY_API_TOKEN" "REQUESTY_API_KEY" "ZEN_API_KEY" "ZENMUX_API_KEY"])

(def ^:private ambient-provider-env
  (into {} (map (fn [k] [k (aget js/process.env k)])) ambient-provider-env-names))

(def ^:private import-module
  "Dynamic `import()` hidden from Closure, as in proxx.app.entry."
  (js/Function. "specifier" "return import(specifier)"))

(defonce ^:private host-module (atom nil))

(defn- ^:async load-host
  "The TypeScript host (src/app.ts) through tsx, with the built CLJS runtime made active."
  []
  (or @host-module
      (let [^js tsx (js/require "tsx/esm/api")
            cwd (js/process.cwd)
            ^js module (await (.tsImport tsx (.resolve path cwd "src/app.ts")
                                         (.-href (.pathToFileURL url (str cwd "/")))))]
        (await (.prepare module))
        (reset! host-module module))))

(defn with-env
  "Run async `f` with env vars set (nil deletes), restoring them afterwards."
  [values f]
  (let [previous (into {} (map (fn [k] [k (aget js/process.env k)])) (keys values))
        apply! (fn [m] (doseq [[k v] m]
                         (if (nil? v)
                           (js-delete js/process.env k)
                           (aset js/process.env k v))))]
    (apply! values)
    (-> (js/Promise.resolve (f))
        (.finally (fn [] (apply! previous))))))

(defn with-cleared-ambient-providers [f]
  (let [env js/process.env
        values (merge {"FACTORY_AUTH_V2_FILE" (or (aget env "FACTORY_AUTH_V2_FILE") "/tmp/nonexistent-auth-v2-file")
                       "FACTORY_AUTH_V2_KEY" (or (aget env "FACTORY_AUTH_V2_KEY") "/tmp/nonexistent-auth-v2-key")}
                      (into {} (keep (fn [k] (when (= (aget env k) (get ambient-provider-env k)) [k nil])))
                            ambient-provider-env-names))]
    (with-env values f)))

(defn bearer
  "The token of an `Authorization: Bearer …` header value, or nil when absent."
  [auth]
  (when (string? auth) (str/replace auth #"(?i)^Bearer\s+" "")))

(defn req-header [^js request name]
  (let [v (aget (.-headers request) name)]
    (when (string? v) v)))

(defn parse-json [s] (js->clj (js/JSON.parse s) :keywordize-keys true))

(defn json-body [x] (js/JSON.stringify (clj->js x)))

(def json-headers {"content-type" "application/json"})

(defn- read-request-body [^js request]
  (js/Promise.
   (fn [resolve reject]
     (let [chunks #js []]
       (.on request "data" (fn [c] (.push chunks c)))
       (.on request "end" (fn [] (resolve (.toString (js/Buffer.concat chunks) "utf8"))))
       (.on request "error" reject)))))

(defn- default-config [port keys-path models-path logs-path affinity-path settings-path opts]
  (let [base (str "http://127.0.0.1:" port)
        o (:config-overrides opts)
        base-urls {"vivgrid" base "ollama-cloud" base "ob1" base "openai" base "openrouter" base
                   "requesty" base "gemini" base
                   "zai" (str base "/api/paas/v4") "mistral" (str base "/v1") "rotussy" (str base "/v1")
                   "llamacpp-embed" base}
        auth (:proxy-auth-token opts)
        config (cond-> {:host "127.0.0.1" :port 0
                        :upstreamProviderId "vivgrid"
                        :disabledProviderIds []
                        :upstreamProviderBaseUrls base-urls
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
                        :requestLogsFilePath logs-path
                        :requestLogsMaxEntries 100000
                        :requestLogsFlushMs 0
                        :promptAffinityFilePath affinity-path
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
                        :allowUnauthenticated (if (contains? opts :allow-unauthenticated)
                                                (:allow-unauthenticated opts)
                                                (nil? auth))
                        :githubOAuthCallbackPath "/auth/github/callback"
                        :githubAllowedUsers []
                        :sessionSecret "test-session-token" ; pragma: allowlist secret
                        :openaiOauthScopes "openid profile email offline_access"
                        :openaiOauthClientId "app_EMoamEEZ73f0CkXaXp7hrann"
                        :openaiOauthIssuer "https://auth.openai.com"
                        :proxyTokenPepper (or (:proxyTokenPepper o) "test-proxy-token-pepper")
                        :oauthRefreshMaxConcurrency (or (:oauthRefreshMaxConcurrency o) 32)
                        :oauthRefreshBackgroundIntervalMs (or (:oauthRefreshBackgroundIntervalMs o) 15000)
                        :oauthRefreshProactiveWindowMs (or (:oauthRefreshProactiveWindowMs o) (* 30 60000))
                        :concurrencyThrottleMaxRetries (or (:concurrencyThrottleMaxRetries o) 3)
                        :concurrencyThrottleThresholdMs (or (:concurrencyThrottleThresholdMs o) 30000)
                        :cljsPolicyManifestPath "resources/policies/runtime/00-manifest.edn"
                        :cljsPolicyAuthoritative (boolean (:cljsPolicyAuthoritative o))
                        :cljsPolicyShadowMode (boolean (:cljsPolicyShadowMode o))}
                 auth (assoc :proxyAuthToken auth))]
    (-> (merge config (dissoc o :upstreamProviderBaseUrls))
        (assoc :upstreamProviderBaseUrls (merge base-urls (:upstreamProviderBaseUrls o))))))

(defn- ^:async handle-upstream [opts ^js request ^js response]
  (let [body (await (read-request-body request))
        bypass? (or (and (= "GET" (.-method request)) (= "/v1/models" (.-url request)))
                    (and (= "GET" (.-method request)) (= "/api/tags" (.-url request))))]
    (if (and bypass? (not (:handle-model-catalog opts)))
      (do (set! (.-statusCode response) 404)
          (.setHeader response "content-type" "application/json")
          (.end response (json-body {:error {:message "catalog not configured"}})))
      (try
        (let [result (await ((:upstream-handler opts) request body))]
          (set! (.-statusCode response) (:status result))
          (doseq [[k v] (:headers result)] (.setHeader response (name k) v))
          (if-let [stream (:stream-body result)]
            (await (stream response))
            (.end response (or (:body result) ""))))
        (catch :default error
          (set! (.-statusCode response) 500)
          (.setHeader response "content-type" "application/json")
          (.end response (json-body {:error {:message (str error)}})))))))

(defn- ^:async write-json! [file data]
  (await (.writeFile fsp file (js/JSON.stringify (clj->js data) nil 2) "utf8")))

(defn ^:async with-proxy-app
  "Start an upstream server and a proxy application over `opts`, call async `(f {:app :upstream :temp-dir})`,
  and tear both down. `opts`:
    :keys :keys-payload :request-logs-payload :models :handle-model-catalog
    :proxy-auth-token :allow-unauthenticated :config-overrides (camelCase keyword keys)
    :upstream-handler"
  [opts f]
  (let [temp-dir (await (.mkdtemp fsp (.join path (.tmpdir os) "open-hax-proxy-test-")))
        file (fn [n] (.join path temp-dir n))
        keys-path (file "keys.json")
        models-path (file "models.json")
        logs-path (file "request-logs.jsonl")]
    (await (write-json! keys-path (or (:keys-payload opts) {:keys (:keys opts)})))
    (when (contains? opts :request-logs-payload)
      (await (write-json! logs-path (:request-logs-payload opts))))
    (when (:models opts)
      (await (write-json! models-path (:models opts))))
    (let [upstream (.createServer http (fn [request response] (handle-upstream opts request response)))]
      (.listen upstream 0 "127.0.0.1")
      (await (js/Promise. (fn [resolve] (.once upstream "listening" resolve))))
      (let [port (.-port (.address upstream))
            config (clj->js (default-config port keys-path models-path logs-path (file "prompt-affinity.json")
                                            (file "proxy-settings.json") opts))]
        (await (with-cleared-ambient-providers
                 (fn ^:async run []
                   (let [^js host-mod (await (load-host))
                         ^js app (await (app-main/create-app-js config (.-host host-mod)))]
                     (try
                       (await (f {:app app :upstream upstream :temp-dir temp-dir}))
                       (finally
                         (await (.close app))
                         (await (js/Promise. (fn [resolve reject]
                                               (.close upstream (fn [error] (if error (reject error) (resolve nil)))))))
                         (await (.rm fsp temp-dir #js {:recursive true :force true}))))))))))))

(defn ^:async inject
  "app.inject with a Clojure request map; the result is `{:status :headers :json :text}`
  (`:json` keywordized, nil when the body is not JSON)."
  [^js app {:keys [method url headers payload]}]
  (let [^js res (await (.inject app (clj->js (cond-> {:method method :url url}
                                               headers (assoc :headers headers)
                                               (some? payload) (assoc :payload payload)))))]
    {:status (.-statusCode res)
     :headers (js->clj (.-headers res))
     :json (try (js->clj (.json res) :keywordize-keys true) (catch :default _ nil))
     :text (.-payload res)}))

(defn chat
  "POST /v1/chat/completions with `payload` (extra request `headers` merged over the JSON content type)."
  ([app payload] (chat app payload nil))
  ([app payload headers]
   (inject app {:method "POST" :url "/v1/chat/completions"
                :headers (merge json-headers headers) :payload payload})))

(defn sleep [ms] (js/Promise. (fn [resolve] (js/setTimeout resolve ms))))

(defn- ^:async with-global
  "Run async `f` with `(aget js/globalThis name)` replaced, then restore it."
  [name value f]
  (let [original (aget js/globalThis name)]
    (aset js/globalThis name value)
    (try (await (f)) (finally (aset js/globalThis name original)))))

(defn ^:async with-frozen-clock
  "Run async `(f)` with `Date.now` reading the atom `now`."
  [now f]
  (let [original (.-now js/Date)]
    (aset js/Date "now" (fn [] @now))
    (try (await (f)) (finally (aset js/Date "now" original)))))

(defn ^:async with-patched-fetch
  "Run async `f` with fetch calls first offered to `(handler input init original-fetch)`
  (a Response, or nil to fall through to the real fetch)."
  [handler f]
  (let [original (aget js/globalThis "fetch")]
    (await (with-global "fetch"
             (fn ^:async patched [input init]
               (or (await (handler input init original))
                   (original input init)))
             f))))

(defn json-reply
  "An upstream reply: `status`, a JSON `body` (Clojure data) and optional extra headers."
  ([status body] (json-reply status body nil))
  ([status body headers]
   {:status status :headers (merge json-headers headers) :body (json-body body)}))

(defn hello
  "The `hello` chat request of the proxy tests for `model`, with `extra` fields merged over it."
  ([model] (hello model nil))
  ([model extra] (merge {:model model :messages [{:role "user" :content "hello"}] :stream false} extra)))

(defn make-jwt
  "An unsigned JWT (`alg: none`) carrying `payload` (Clojure data)."
  [payload]
  (let [b64url (fn [x] (.toString (js/Buffer.from (js/JSON.stringify (clj->js x))) "base64url"))]
    (str (b64url {:alg "none" :typ "JWT"}) "." (b64url payload) ".sig")))
