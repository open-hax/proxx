(ns proxx.proxy.harness-d
  "In-process proxy harness for the CLJS ports of src/tests/proxy.test.ts.

   `with-proxy-app` mirrors the TS `withProxyApp`: a real loopback upstream
   (node:http), a temp directory with keys.json, and the application built by
   `proxx.host/create-app-js`, the same CLJS host the server runs."
  (:require [clojure.string :as str]
            [proxx.host :as host]))

(def ^:private fs (js/require "node:fs/promises"))
(def ^:private http (js/require "node:http"))
(def ^:private os (js/require "node:os"))
(def ^:private path (js/require "node:path"))
(def ^:private url-mod (js/require "node:url"))

;; ---------------------------------------------------------------- small utils

(defn ^:async sleep [ms]
  (js/Promise. (fn [resolve _] (js/setTimeout resolve ms))))

(defn json-str [x] (js/JSON.stringify (clj->js x)))

(defn parse-json [s] (js->clj (js/JSON.parse s)))

(defn includes? [s sub] (str/includes? (str s) sub))

(defn bearer-key
  "The key in the request's `Authorization: Bearer <key>` header, or nil."
  [^js request]
  (let [auth (aget (.-headers request) "authorization")]
    (when (string? auth) (str/replace auth #"(?i)^Bearer\s+" ""))))

(defn header [^js request name] (aget (.-headers request) name))

(defn chat-chunk
  "One chat.completion.chunk as an SSE `data:` frame."
  [id model delta finish-reason]
  (str "data: "
       (json-str {"id" id "object" "chat.completion.chunk" "created" 1772516802 "model" model
                  "choices" [{"index" 0 "delta" delta "finish_reason" finish-reason}]})
       "\n\n"))

(defn sse-done [] "data: [DONE]\n\n")

(defn parse-sse-data-payloads
  "The `data:` payloads of an SSE body, asserting that each frame is a single data line."
  [payload]
  (->> (str/split (str/replace payload "\r\n" "\n") #"\n\n")
       (map str/trim)
       (remove str/blank?)
       (mapv (fn [block]
               (let [lines (str/split block #"\n")]
                 (assert (= 1 (count lines)) (str "SSE frame is not a single line: " block))
                 (assert (str/starts-with? (first lines) "data: "))
                 (subs (first lines) (count "data: ")))))))

;; ------------------------------------------------------------------------ env

(def ^:private ambient-provider-env-names
  ["ROTUSSY_API_KEY" "ROTUSSY_PROVIDER_ID" "FACTORY_API_KEY" "GEMINI_API_KEY" "ZAI_API_KEY" "ZHIPU_API_KEY"
   "MISTRAL_API_KEY" "OPENROUTER_API_KEY" "REQUESTY_API_TOKEN" "REQUESTY_API_KEY" "ZEN_API_KEY" "ZENMUX_API_KEY"])

(def ^:private ambient-provider-env
  (into {} (map (fn [n] [n (aget js/process.env n)])) ambient-provider-env-names))

(defn- set-env! [name value]
  (if (nil? value)
    (js-delete js/process.env name)
    (aset js/process.env name value)))

(defn ^:async with-env
  "Run async `f` with the given env values (nil deletes), restoring afterwards."
  [values f]
  (let [previous (into {} (map (fn [[k _]] [k (aget js/process.env k)])) values)]
    (doseq [[k v] values] (set-env! k v))
    (try
      (await (f))
      (finally
        (doseq [[k v] previous] (set-env! k v))))))

(defn ^:async with-cleared-ambient-providers [f]
  (let [values (reduce (fn [m n] (if (= (aget js/process.env n) (get ambient-provider-env n)) (assoc m n nil) m))
                       {"FACTORY_AUTH_V2_FILE" (or (aget js/process.env "FACTORY_AUTH_V2_FILE") "/tmp/nonexistent-auth-v2-file")
                        "FACTORY_AUTH_V2_KEY" (or (aget js/process.env "FACTORY_AUTH_V2_KEY") "/tmp/nonexistent-auth-v2-key")}
                       ambient-provider-env-names)]
    (await (with-env values f))))

;; ------------------------------------------------------------------- the app

(defn- ^:async read-request-body [^js request]
  (let [chunks (atom [])]
    (await (js/Promise.
            (fn [resolve reject]
              (.on request "data" (fn [c] (swap! chunks conj (if (js/Buffer.isBuffer c) c (js/Buffer.from c)))))
              (.on request "end" resolve)
              (.on request "error" reject))))
    (.toString (js/Buffer.concat (clj->js @chunks)) "utf8")))

(defn- ^:async handle-upstream [handler catalog? ^js request ^js response]
  (let [body (await (read-request-body request))
        method (.-method request) url (.-url request)
        bypass? (or (and (= "GET" method) (= "/v1/models" url))
                    (and (= "GET" method) (= "/api/tags" url)))]
    (if (and bypass? (not catalog?))
      (do (set! (.-statusCode response) 404)
          (.setHeader response "content-type" "application/json")
          (.end response (json-str {"error" {"message" "catalog not configured"}})))
      (try
        (let [result (await (handler request body))]
          (set! (.-statusCode response) (:status result))
          (doseq [[k v] (:headers result)] (.setHeader response (name k) v))
          (if-let [stream-body (:stream-body result)]
            (await (stream-body response))
            (.end response (or (:body result) ""))))
        (catch :default e
          (set! (.-statusCode response) 500)
          (.setHeader response "content-type" "application/json")
          (.end response (json-str {"error" {"message" (str e)}})))))))

(defn- base-config [port keys-path models-path logs-path affinity-path settings-path opts]
  (let [base (str "http://127.0.0.1:" port)
        ov (:config-overrides opts)
        ovg (fn [k default] (if (contains? ov k) (get ov k) default))
        proxy-auth-token (:proxy-auth-token opts)]
    {"host" "127.0.0.1" "port" 0 "upstreamProviderId" "vivgrid" "disabledProviderIds" []
     "upstreamProviderBaseUrls" {"vivgrid" base "ollama-cloud" base "ob1" base "openai" base "openrouter" base
                                 "requesty" base "gemini" base "zai" (str base "/api/paas/v4")
                                 "mistral" (str base "/v1") "rotussy" (str base "/v1") "llamacpp-embed" base}
     "upstreamBaseUrl" base "openaiProviderId" "openai" "openaiBaseUrl" base "openaiApiBaseUrl" base
     "openaiImagesUpstreamMode" "auto" "ollamaBaseUrl" base "localOllamaEnabled" true
     "localOllamaModelPatterns" [":2b" ":3b" ":4b" ":7b" ":8b" "mini" "small"]
     "chatCompletionsPath" "/v1/chat/completions" "openaiChatCompletionsPath" "/v1/chat/completions"
     "messagesPath" "/v1/messages" "messagesModelPrefixes" ["claude-"]
     "messagesInterleavedThinkingBeta" "interleaved-thinking-2025-05-14"
     "responsesPath" "/v1/responses" "openaiResponsesPath" "/v1/responses"
     "openaiImagesGenerationsPaths" ["/v1/images/generations" "/images/generations" "/codex/images/generations"]
     "imageCostUsdDefault" 0 "imageCostUsdByProvider" {} "imagesGenerationsPath" "/v1/images/generations"
     "responsesModelPrefixes" ["gpt-"] "ollamaChatPath" "/api/chat" "ollamaV1ChatPath" "/v1/chat/completions"
     "factoryModelPrefixes" ["factory/" "factory:"] "openaiModelPrefixes" ["openai/" "openai:"]
     "ollamaModelPrefixes" ["ollama/" "ollama:"]
     "llamacppModelPrefixes" ["llamacpp/" "llamacpp:" "llamacpp-embed/" "llamacpp-embed:"]
     "keysFilePath" keys-path "modelsFilePath" models-path "requestLogsFilePath" logs-path
     "requestLogsMaxEntries" 100000 "requestLogsFlushMs" 0 "promptAffinityFilePath" affinity-path
     "promptAffinityFlushMs" 0 "settingsFilePath" settings-path "keyReloadMs" 50 "keyCooldownMs" 10000
     "keyCooldownJitterFactor" 0 "enableKeyRandomWalk" false "ollamaWeeklyCooldownMultiplier" 24
     "requestTimeoutMs" 2000 "streamBootstrapTimeoutMs" 2000 "embedMaxContextTokens" 262144
     "embedMaxBatchItems" 128 "embedMaxInputChars" 250000 "upstreamTransientRetryCount" 2
     "upstreamTransientRetryBackoffMs" 1
     "proxyAuthToken" proxy-auth-token
     "allowUnauthenticated" (if (contains? opts :allow-unauthenticated) (:allow-unauthenticated opts) (nil? proxy-auth-token))
     "githubOAuthCallbackPath" "/auth/github/callback" "githubAllowedUsers" []
     "sessionSecret" "test-session-token" ; pragma: allowlist secret
     "openaiOauthScopes" "openid profile email offline_access"
     "openaiOauthClientId" "app_EMoamEEZ73f0CkXaXp7hrann" "openaiOauthIssuer" "https://auth.openai.com"
     "proxyTokenPepper" (ovg "proxyTokenPepper" "test-proxy-token-pepper")
     "oauthRefreshMaxConcurrency" (ovg "oauthRefreshMaxConcurrency" 32)
     "oauthRefreshBackgroundIntervalMs" (ovg "oauthRefreshBackgroundIntervalMs" 15000)
     "oauthRefreshProactiveWindowMs" (ovg "oauthRefreshProactiveWindowMs" (* 30 60000))
     "concurrencyThrottleMaxRetries" (ovg "concurrencyThrottleMaxRetries" 3)
     "concurrencyThrottleThresholdMs" (ovg "concurrencyThrottleThresholdMs" 30000)
     "cljsPolicyManifestPath" "resources/policies/runtime/00-manifest.edn"
     "cljsPolicyAuthoritative" (ovg "cljsPolicyAuthoritative" false)
     "cljsPolicyShadowMode" (ovg "cljsPolicyShadowMode" false)}))

(defn- merge-config [defaults overrides]
  (-> (merge defaults overrides)
      (assoc "upstreamProviderBaseUrls"
             (merge (get defaults "upstreamProviderBaseUrls") (get overrides "upstreamProviderBaseUrls")))))

(defn ^:async with-proxy-app
  "Run async `f` with `{:app :upstream :temp-dir :upstream-port}`.
   opts: :keys :keys-payload :request-logs-payload :models :handle-model-catalog
   :proxy-auth-token :allow-unauthenticated :config-overrides (string-keyed map)
   :upstream-handler (fn [request body] -> {:status :headers :body :stream-body} or a promise of it)."
  [opts f]
  (let [temp-dir (await (.mkdtemp fs (.join path (.tmpdir os) "open-hax-proxy-test-")))
        file (fn [n] (.join path temp-dir n))
        keys-path (file "keys.json") models-path (file "models.json") logs-path (file "request-logs.jsonl")
        keys-payload (or (:keys-payload opts) {"keys" (:keys opts)})]
    (await (.writeFile fs keys-path (js/JSON.stringify (clj->js keys-payload) nil 2) "utf8"))
    (when (some? (:request-logs-payload opts))
      (await (.writeFile fs logs-path (js/JSON.stringify (clj->js (:request-logs-payload opts)) nil 2) "utf8")))
    (when (:models opts)
      (await (.writeFile fs models-path (js/JSON.stringify (clj->js (:models opts)) nil 2) "utf8")))
    (let [upstream (.createServer http (fn [req res] (handle-upstream (:upstream-handler opts) (:handle-model-catalog opts) req res)))]
      (.listen upstream 0 "127.0.0.1")
      (await (js/Promise. (fn [resolve _] (.once upstream "listening" resolve))))
      (let [port (.-port (.address upstream))
            config (merge-config (base-config port keys-path models-path logs-path (file "prompt-affinity.json")
                                              (file "proxy-settings.json") opts)
                                 (:config-overrides opts))]
        (await
         (with-cleared-ambient-providers
           (fn ^:async run []
            (let [_ nil]
              (let [^js app (await (host/create-app-js (clj->js config)))]
                (try
                  (await (f {:app app :upstream upstream :temp-dir temp-dir :upstream-port port}))
                  (finally
                    (await (.close app))
                    (await (js/Promise. (fn [resolve reject]
                                          (.close upstream (fn [err] (if err (reject err) (resolve nil))))))))))))))
        (await (.rm fs temp-dir #js {:recursive true :force true}))))))

(defn ^:async with-zai-proxy-app
  "As the TS `withZaiProxyApp`: only the environment-seeded zai provider."
  [upstream-handler f]
  (await (with-env {"ZAI_API_KEY" "zai-key-1" ; pragma: allowlist secret
                    "ZAI_PROVIDER_ID" nil "ROTUSSY_API_KEY" nil "ROTUSSY_PROVIDER_ID" nil
                    "GEMINI_API_KEY" nil "OPENROUTER_API_KEY" nil "REQUESTY_API_TOKEN" nil "REQUESTY_API_KEY" nil}
           (fn ^:async run []
            (await (with-proxy-app {:keys [] :keys-payload {"providers" {}}
                                    :config-overrides {"upstreamProviderId" "zai" "localOllamaEnabled" false}
                                    :upstream-handler upstream-handler}
                     f))))))

(defn ^:async inject
  "app.inject as a map: {:status :headers :body :json :res}. `opts` is a Clojure map; payload is sent as JSON."
  [^js app opts]
  (let [^js res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res)
     :headers (js->clj (.-headers res))
     :body (.-payload res)
     :json (try (js->clj (.json res)) (catch :default _ nil))
     :res res}))

(defn ^:async chat
  "POST /v1/chat/completions with `payload`."
  [app payload & [extra]]
  (await (inject app (merge {:method "POST" :url "/v1/chat/completions"
                             :headers {"content-type" "application/json"}
                             :payload payload}
                            extra))))
