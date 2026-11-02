(ns proxx.runtime.host-support
  "Fixtures for the tests that run the whole application (formerly the helpers duplicated
  at the top of the federation bridge and observability TypeScript tests): the host
  module (`src/app.ts`, loaded through tsx) composes the CLJS application over the
  host's stores and pools, in front of a local upstream HTTP server.

  The application under test is the built CLJS runtime (`dist/cljs`, so run
  `pnpm build:cljs` first). This namespace builds fixtures and never decides anything."
  (:require ["node:fs/promises" :as fsp]
            ["node:http" :as http]
            ["node:os" :as os]
            ["node:path" :as path]
            ["node:url" :as url]
            ["ws" :as ws]))

;; ---------------------------------------------------------------------------
;; The host module (TypeScript through tsx), loaded once per process
;; ---------------------------------------------------------------------------

(def ^:private import-module
  "Dynamic `import()` through Node's main-context loader (the test bundle is evaluated
  without an import callback, so a bare `import()` throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING)."
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

(defn ^:async host
  "{:app <src/app.ts module> :runtime <src/lib/cljs-runtime.ts module>}"
  []
  (when-not @host-modules
    (reset! host-modules (load-host-modules)))
  (await @host-modules))

;; ---------------------------------------------------------------------------
;; Small helpers
;; ---------------------------------------------------------------------------

(defn sleep [ms] (js/Promise. (fn [resolve _] (js/setTimeout resolve ms))))

(defn once
  "A promise of the argument array of the next `event` on `emitter`."
  [^js emitter event]
  (js/Promise. (fn [resolve reject]
                 (let [on-error (fn [e] (reject e))]
                   (.once emitter event (fn [& args]
                                          (.removeListener emitter "error" on-error)
                                          (resolve (to-array args))))
                   (when-not (= "error" event) (.once emitter "error" on-error))))))

(defn ^:async wait-for
  "Poll `predicate` (a fn returning a value or a Promise) until truthy; throw after `timeout-ms`."
  ([predicate] (wait-for predicate 5000))
  ([predicate timeout-ms]
   (let [deadline (+ (js/Date.now) timeout-ms)]
     (loop []
       (cond
         (await (predicate)) nil
         (< (js/Date.now) deadline) (do (await (sleep 25)) (recur))
         :else (throw (js/Error. (str "condition not met within " timeout-ms "ms"))))))))

(defn ^:async with-env
  "Run async `f` with process.env names set to `values` ({name string-or-nil}; nil deletes), then restore."
  [values f]
  (let [env (.-env js/process)
        previous (into {} (map (fn [k] [k (aget env k)])) (keys values))
        apply-env! (fn [m] (doseq [[k v] m] (if (nil? v) (js-delete env k) (aset env k v))))]
    (apply-env! values)
    (try (await (f))
         (finally (apply-env! previous)))))

(defn ^:async inject
  "`app.inject` with plain-data options; the result is `{:status :headers :json :text}`
  (`:json` nil unless the body is JSON). JSON is kept as parsed JS data, converted by `js->clj`."
  [^js app options]
  (let [^js res (await (.inject app (clj->js options)))]
    {:status (.-statusCode res)
     :headers (js->clj (.-headers res))
     :text (.-payload res)
     :json (try (js->clj (.json res)) (catch :default _ nil))}))

(defn ^:async close-server [^js server]
  (js/Promise. (fn [resolve reject] (.close server (fn [error] (if error (reject error) (resolve nil)))))))

(defn ^:async listen-server
  "Listen on an ephemeral loopback port; resolves with the port."
  [^js server]
  (.listen server 0 "127.0.0.1")
  (await (once server "listening"))
  (.-port ^js (.address server)))

;; ---------------------------------------------------------------------------
;; WebSocket clients
;; ---------------------------------------------------------------------------

(defn ^:async open-websocket [url headers]
  (let [^js socket (ws/WebSocket. url #js {"headers" (clj->js headers)})]
    (await (once socket "open"))
    socket))

(defn ^:async next-json-message
  "The next text message on `socket`, parsed (string-keyed map)."
  [^js socket]
  (let [[data] (await (once socket "message"))
        text (if (string? data) data (.toString (js/Buffer.from data) "utf8"))]
    (js->clj (js/JSON.parse text))))

(defn ^:async close-websocket [^js socket]
  (.close socket)
  (await (once socket "close")))

;; ---------------------------------------------------------------------------
;; Fixtures: temp files, upstream, configuration, application
;; ---------------------------------------------------------------------------

(defn json-str [x] (js/JSON.stringify (clj->js x) nil 2))

(defn ^:async create-fixture-dir
  "A temp dir holding keys/models JSON (defaults mirror the TypeScript fixtures); resolves with
  `{:temp-dir :paths {:keys-path :models-path :request-logs-path :prompt-affinity-path :settings-path}}`.
  Pass `:keys-payload`/`:models-payload` to override, `:prompt-affinity-payload`/`:settings-payload` to pre-create."
  [prefix {:keys [keys-payload models-payload prompt-affinity-payload settings-payload]}]
  (let [temp-dir (await (.mkdtemp fsp (.join path (.tmpdir os) prefix)))
        file (fn [name] (.join path temp-dir name))
        paths {:keys-path (file "keys.json") :models-path (file "models.json")
               :request-logs-path (file "request-logs.jsonl") :prompt-affinity-path (file "prompt-affinity.json")
               :settings-path (file "proxy-settings.json")}]
    (await (.writeFile fsp (:keys-path paths) (json-str (or keys-payload {"keys" ["test-key-1"]})) "utf8"))
    (await (.writeFile fsp (:models-path paths)
                       (json-str (or models-payload {"object" "list" "data" [{"id" "gpt-5.4-mini"}]})) "utf8"))
    (when prompt-affinity-payload
      (await (.writeFile fsp (:prompt-affinity-path paths) (json-str prompt-affinity-payload) "utf8")))
    (when settings-payload
      (await (.writeFile fsp (:settings-path paths) (json-str settings-payload) "utf8")))
    {:temp-dir temp-dir :paths paths}))

(defn ^:async remove-dir [dir]
  (await (.rm fsp dir #js {"recursive" true "force" true})))

(defn ok-upstream
  "A local upstream answering every request `{ok: true}` (unless `handler` is given: `(fn [req res])`)."
  ([] (ok-upstream (fn [_ ^js res]
                     (set! (.-statusCode res) 200)
                     (.setHeader res "content-type" "application/json")
                     (.end res (js/JSON.stringify #js {"ok" true})))))
  ([handler] (.createServer http (fn [req res] (handler req res)))))

(defn proxy-config
  "The ProxyConfig map the tests used, for an upstream on `port`. Options:
  :paths (from create-fixture-dir), :auth-token, :allow-unauthenticated, :overrides (camelCase keyword -> value)."
  [port {:keys [paths auth-token allow-unauthenticated overrides]}]
  (let [base (str "http://127.0.0.1:" port)]
    (merge
     {:host "127.0.0.1" :port 0
      :upstreamProviderId "vivgrid" :disabledProviderIds []
      :upstreamProviderBaseUrls {"vivgrid" base "ollama-cloud" base "ob1" base "openai" base "openrouter" base
                                 "requesty" base "gemini" base "zai" (str base "/api/paas/v4") "mistral" (str base "/v1")}
      :upstreamBaseUrl base
      :openaiProviderId "openai" :openaiBaseUrl base :openaiApiBaseUrl base :openaiImagesUpstreamMode "auto"
      :ollamaBaseUrl base :localOllamaEnabled true
      :localOllamaModelPatterns [":2b" ":3b" ":4b" ":7b" ":8b" "mini" "small"]
      :chatCompletionsPath "/v1/chat/completions" :openaiChatCompletionsPath "/v1/chat/completions"
      :messagesPath "/v1/messages" :messagesModelPrefixes ["claude-"]
      :messagesInterleavedThinkingBeta "interleaved-thinking-2025-05-14"
      :responsesPath "/v1/responses" :openaiResponsesPath "/v1/responses"
      :openaiImagesGenerationsPaths ["/v1/images/generations" "/images/generations" "/codex/images/generations"]
      :imageCostUsdDefault 0 :imageCostUsdByProvider {} :imagesGenerationsPath "/v1/images/generations"
      :responsesModelPrefixes ["gpt-"] :ollamaChatPath "/api/chat" :ollamaV1ChatPath "/v1/chat/completions"
      :factoryModelPrefixes ["factory/" "factory:"] :openaiModelPrefixes ["openai/" "openai:"]
      :ollamaModelPrefixes ["ollama/" "ollama:"]
      :keysFilePath (:keys-path paths) :modelsFilePath (:models-path paths)
      :requestLogsFilePath (:request-logs-path paths) :requestLogsMaxEntries 100000 :requestLogsFlushMs 0
      :promptAffinityFilePath (:prompt-affinity-path paths) :promptAffinityFlushMs 0
      :settingsFilePath (:settings-path paths)
      :keyReloadMs 50 :keyCooldownMs 10000 :keyCooldownJitterFactor 0.4 :enableKeyRandomWalk true
      :ollamaWeeklyCooldownMultiplier 24 :requestTimeoutMs 2000 :streamBootstrapTimeoutMs 2000
      :embedMaxContextTokens 262144 :embedMaxBatchItems 128 :embedMaxInputChars 250000
      :upstreamTransientRetryCount 1 :upstreamTransientRetryBackoffMs 1
      :proxyAuthToken auth-token :allowUnauthenticated (boolean allow-unauthenticated)
      :githubOAuthCallbackPath "/auth/github/callback" :githubAllowedUsers []
      :sessionSecret "test-session-token" ; pragma: allowlist secret
      :openaiOauthScopes "openid profile email offline_access"
      :openaiOauthClientId "app_EMoamEEZ73f0CkXaXp7hrann" :openaiOauthIssuer "https://auth.openai.com"
      :proxyTokenPepper "test-proxy-token-pepper"
      :oauthRefreshMaxConcurrency 32 :oauthRefreshBackgroundIntervalMs 15000
      :oauthRefreshProactiveWindowMs (* 30 60000)
      :concurrencyThrottleMaxRetries 3 :concurrencyThrottleThresholdMs 30000}
     overrides)))

(defn ^:async create-app
  "`createApp(config)` of the host; `config` is a map from `proxy-config` (nil values are left unset)."
  [config]
  (let [{:keys [^js app]} (await (host))]
    (await (.createApp app (clj->js (into {} (remove (comp nil? val)) config))))))

(defn app-port [^js app] (.-port ^js (.address (.-server app))))

(defn ^:async listen-app [^js app]
  (await (.listen app #js {"host" "127.0.0.1" "port" 0}))
  (app-port app))

(defn ^:async with-ok-upstream
  "Run `(f upstream-port)` with a started `{ok: true}` upstream (or `handler`), closing it afterwards."
  ([f] (await (with-ok-upstream nil f)))
  ([handler f]
   (let [^js upstream (if handler (ok-upstream handler) (ok-upstream))
         port (await (listen-server upstream))]
     (try (await (f port))
          (finally (await (close-server upstream)))))))
