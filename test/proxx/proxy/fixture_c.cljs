(ns proxx.proxy.fixture-c
  "Black-box fixture for the proxy integration tests ported from
  `src/tests/proxy.test.ts` (lines 6800-10200).

  It builds the real application (`proxx.host/create-app-js`) against a loopback upstream whose
  behaviour each test supplies, then drives it through Fastify `inject`.
"
  (:require [clojure.string :as str]
            [proxx.host :as host]))

(def ^:private fs (js/require "node:fs/promises"))
(def ^:private http (js/require "node:http"))
(def ^:private os (js/require "node:os"))
(def ^:private path (js/require "node:path"))
(def ^:private url (js/require "node:url"))
(def ^:private events (js/require "node:events"))

;; ---------------------------------------------------------------------------
;; environment
;; ---------------------------------------------------------------------------

(def ^:private ambient-provider-env-names
  ["ROTUSSY_API_KEY" "ROTUSSY_PROVIDER_ID" "FACTORY_API_KEY" "GEMINI_API_KEY" "ZAI_API_KEY" "ZHIPU_API_KEY"
   "MISTRAL_API_KEY" "OPENROUTER_API_KEY" "REQUESTY_API_TOKEN" "REQUESTY_API_KEY" "ZEN_API_KEY" "ZENMUX_API_KEY"])

(def ^:private ambient-provider-env
  (into {} (map (fn [n] [n (aget js/process.env n)])) ambient-provider-env-names))

(defn- env-set! [k v]
  (if (nil? v)
    (js-delete js/process.env k)
    (aset js/process.env k v)))

(defn ^:async with-env
  "Run async `f` with process env vars set (nil deletes), restoring them afterwards."
  [values f]
  (let [previous (into {} (map (fn [k] [k (aget js/process.env k)])) (keys values))]
    (doseq [[k v] values] (env-set! k v))
    (try
      (await (f))
      (finally
        (doseq [[k v] previous] (env-set! k v))))))

(defn- ^:async with-cleared-ambient-providers [f]
  (let [values (reduce (fn [m n]
                         (if (= (aget js/process.env n) (get ambient-provider-env n))
                           (assoc m n nil)
                           m))
                       {"FACTORY_AUTH_V2_FILE" (or (aget js/process.env "FACTORY_AUTH_V2_FILE") "/tmp/nonexistent-auth-v2-file")
                        "FACTORY_AUTH_V2_KEY" (or (aget js/process.env "FACTORY_AUTH_V2_KEY") "/tmp/nonexistent-auth-v2-key")}
                       ambient-provider-env-names)]
    (await (with-env values f))))

(defn ^:async with-patched-fetch
  "Run async `f` with globalThis.fetch replaced. `handler` is
  `(fn [input init original-fetch])` returning a Response (or promise) or nil to fall through."
  [handler f]
  (let [original js/globalThis.fetch]
    (aset js/globalThis "fetch"
          (fn [input init]
            (-> (js/Promise.resolve (handler input init original))
                (.then (fn [response] (or response (original input init)))))))
    (try
      (await (f))
      (finally
        (aset js/globalThis "fetch" original)))))

;; ---------------------------------------------------------------------------
;; the application under test
;; ---------------------------------------------------------------------------

(defn- default-config [port keys-path models-path logs-path affinity-path settings-path opts]
  (let [base (str "http://127.0.0.1:" port)
        o (:config-overrides opts)
        pick (fn [k default] (if (contains? o k) (get o k) default))]
    {:host "127.0.0.1"
     :port 0
     :upstreamProviderId "vivgrid"
     :disabledProviderIds []
     :upstreamProviderBaseUrls {"vivgrid" base "ollama-cloud" base "ob1" base "openai" base "openrouter" base
                                "requesty" base "gemini" base
                                "zai" (str base "/api/paas/v4")
                                "mistral" (str base "/v1")
                                "rotussy" (str base "/v1")
                                "llamacpp-embed" base}
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
     :proxyAuthToken (:proxy-auth-token opts)
     :allowUnauthenticated (if (contains? opts :allow-unauthenticated)
                             (:allow-unauthenticated opts)
                             (nil? (:proxy-auth-token opts)))
     :databaseUrl nil
     :githubOAuthClientId nil
     :githubOAuthClientSecret nil
     :githubOAuthCallbackPath "/auth/github/callback"
     :githubAllowedUsers []
     :sessionSecret "test-session-token" ; pragma: allowlist secret
     :openaiOauthScopes "openid profile email offline_access"
     :openaiOauthClientId "app_EMoamEEZ73f0CkXaXp7hrann"
     :openaiOauthIssuer "https://auth.openai.com"
     :proxyTokenPepper (pick :proxyTokenPepper "test-proxy-token-pepper")
     :oauthRefreshMaxConcurrency (pick :oauthRefreshMaxConcurrency 32)
     :oauthRefreshBackgroundIntervalMs (pick :oauthRefreshBackgroundIntervalMs 15000)
     :oauthRefreshProactiveWindowMs (pick :oauthRefreshProactiveWindowMs (* 30 60000))
     :concurrencyThrottleMaxRetries (pick :concurrencyThrottleMaxRetries 3)
     :concurrencyThrottleThresholdMs (pick :concurrencyThrottleThresholdMs 30000)
     :cljsPolicyManifestPath "resources/policies/runtime/00-manifest.edn"
     :cljsPolicyAuthoritative (pick :cljsPolicyAuthoritative false)
     :cljsPolicyShadowMode (pick :cljsPolicyShadowMode false)}))

(defn- ->config [base opts]
  (let [o (:config-overrides opts)]
    (-> (merge base o)
        (assoc :upstreamProviderBaseUrls (merge (:upstreamProviderBaseUrls base)
                                                (:upstreamProviderBaseUrls o)))
        (->> (remove (comp nil? val)) (into {}))   ; undefined (not null) is how the host spells "unset"
        clj->js)))

(defn- read-body [^js request]
  (js/Promise.
   (fn [resolve reject]
     (let [chunks (array)]
       (.on request "data" (fn [chunk] (.push chunks (if (js/Buffer.isBuffer chunk) chunk (js/Buffer.from chunk)))))
       (.on request "end" (fn [] (resolve (.toString (js/Buffer.concat chunks) "utf8"))))
       (.on request "error" reject)))))

(defn- ^:async serve-upstream [handler catalog? ^js request ^js response]
  (let [body (await (read-body request))
        method (.-method request)
        url-path (.-url request)
        bypass? (or (and (= method "GET") (= url-path "/v1/models"))
                    (and (= method "GET") (= url-path "/api/tags")))]
    (if (and bypass? (not catalog?))
      (do (set! (.-statusCode response) 404)
          (.setHeader response "content-type" "application/json")
          (.end response (js/JSON.stringify #js {"error" #js {"message" "catalog not configured"}})))
      (try
        (let [result (await (js/Promise.resolve (handler request body)))]
          (set! (.-statusCode response) (:status result))
          (doseq [[k v] (:headers result)]
            (.setHeader response (name k) v))
          (if-let [stream-body (:stream-body result)]
            (await (stream-body response))
            (.end response (or (:body result) ""))))
        (catch :default e
          (set! (.-statusCode response) 500)
          (.setHeader response "content-type" "application/json")
          (.end response (js/JSON.stringify #js {"error" #js {"message" (str e)}})))))))

(defn- ^:async temp-dir []
  (await (.mkdtemp fs (.join path (.tmpdir os) "open-hax-proxy-test-"))))

(defn ^:async with-proxy-app
  "Run async `f` with `{:app :upstream :temp-dir}`.

  Options: `:keys` `:keys-payload` `:request-logs-payload` `:models` `:handle-model-catalog`
  `:proxy-auth-token` `:allow-unauthenticated` `:config-overrides` (camelCase keyword
  config names) and `:upstream-handler` `(fn [request body])` returning (a promise of)
  `{:status :headers :body :stream-body}`."
  [opts f]
  (let [dir (await (temp-dir))
        keys-path (.join path dir "keys.json")
        models-path (.join path dir "models.json")
        logs-path (.join path dir "request-logs.jsonl")
        affinity-path (.join path dir "prompt-affinity.json")
        settings-path (.join path dir "proxy-settings.json")
        pretty (fn [data] (js/JSON.stringify (clj->js data) nil 2))]
    (await (.writeFile fs keys-path (pretty (or (:keys-payload opts) {:keys (:keys opts)})) "utf8"))
    (when (contains? opts :request-logs-payload)
      (await (.writeFile fs logs-path (pretty (:request-logs-payload opts)) "utf8")))
    (when (:models opts)
      (await (.writeFile fs models-path (pretty (:models opts)) "utf8")))
    (let [upstream (.createServer http (fn [req res] (serve-upstream (:upstream-handler opts) (:handle-model-catalog opts) req res)))
          _ (.listen upstream 0 "127.0.0.1")
          _ (await (.once events upstream "listening"))
          port (.-port (.address upstream))
          config (->config (default-config port keys-path models-path logs-path affinity-path settings-path opts) opts)
          ]
      (await
       (with-cleared-ambient-providers
         (^:async fn []
           (let [^js app (await (host/create-app-js config))]
             (try
               (await (f {:app app :upstream upstream :temp-dir dir}))
               (finally
                 (await (.close app))
                 (await (js/Promise. (fn [resolve reject]
                                       (.close upstream (fn [err] (if err (reject err) (resolve nil)))))))
                 (await (.rm fs dir #js {"recursive" true "force" true}))))))))))) 

;; ---------------------------------------------------------------------------
;; talking to it
;; ---------------------------------------------------------------------------

(def json-headers {"content-type" "application/json"})

(defn ^:async inject
  "Fastify `inject`. Returns `{:status :headers :body :json}` with `:json` the parsed body
  (string keys) or nil when the body is not JSON."
  [^js app {:keys [method url headers payload]}]
  (let [^js res (await (.inject app (clj->js (cond-> {:method method :url url}
                                               headers (assoc :headers headers)
                                               (some? payload) (assoc :payload payload)))))]
    {:status (.-statusCode res)
     :headers (js->clj (.-headers res))
     :body (.-payload res)
     :json (try (js->clj (.json res)) (catch :default _ nil))}))

(defn post-json [app url payload & [headers]]
  (inject app {:method "POST" :url url :headers (merge json-headers headers) :payload payload}))

(defn req-header
  "A request header as a string, or nil."
  [^js request name]
  (let [v (aget (.-headers request) name)]
    (when (string? v) v)))

(defn req-url [^js request] (.-url request))
(defn req-method [^js request] (.-method request))

(defn bearer
  "The authorization header with its `Bearer ` prefix removed."
  [request]
  (some-> (req-header request "authorization") (str/replace #"(?i)^Bearer\s+" "")))

(defn parse-json [s] (js->clj (js/JSON.parse s)))

(defn json-str [data] (js/JSON.stringify (clj->js data)))

(defn json-reply
  ([data] (json-reply 200 data))
  ([status data] {:status status :headers json-headers :body (json-str data)}))

(defn sse-frame [event data]
  (str "event: " event "\ndata: " (json-str data) "\n\n"))

(defn sse-reply [& frames]
  {:status 200 :headers {"content-type" "text/event-stream; charset=utf-8"} :body (apply str frames)})

(defn sse-data-payloads
  "The `data:` payloads of an SSE body, asserting each frame is exactly one `data: ` line."
  [payload]
  (->> (str/split (str/replace payload "\r\n" "\n") #"\n\n")
       (map str/trim)
       (remove empty?)
       (mapv (fn [block]
               (let [lines (str/split block #"\n")]
                 (assert (= 1 (count lines)) (str "SSE frame is not a single line: " block))
                 (assert (str/starts-with? (first lines) "data: ") block)
                 (subs (first lines) (count "data: ")))))))

(def oauth-openai-keys
  "A keys payload with one OpenAI OAuth account."
  {:providers {:openai {:auth "oauth_bearer"
                        :accounts [{:id "openai-a" :access_token "oa-token-a" :chatgpt_account_id "chatgpt-a"}]}}})

(defn oauth-openai-keys-2
  "A keys payload with two OpenAI OAuth plus accounts."
  []
  {:providers {:openai {:auth "oauth_bearer"
                        :accounts [{:id "openai-a" :access_token "oa-token-a" :chatgpt_account_id "chatgpt-a" :plan_type "plus"}
                                   {:id "openai-b" :access_token "oa-token-b" :chatgpt_account_id "chatgpt-b" :plan_type "plus"}]}}})

(defn request-url
  "The URL string of a fetch input (string, URL or Request)."
  [input]
  (cond (string? input) input
        (instance? js/URL input) (.toString input)
        :else (.-url ^js input)))

(defn sse-response
  "A fetch `Response` carrying `body` as text/event-stream."
  [body]
  (js/Response. body #js {"status" 200 "headers" #js {"content-type" "text/event-stream"}}))

(defn ndjson-reply
  "An application/x-ndjson reply made of `lines` (maps), one JSON object per line."
  [& lines]
  {:status 200 :headers {"content-type" "application/x-ndjson"} :body (apply str (map #(str (json-str %) "\n") lines))})
