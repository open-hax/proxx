(ns proxx.config.proxy
  "Pure construction of the proxy configuration from an environment.

  `build-config` is a function of `env-get` (name => string or nil), a path
  resolver and the policy facts (`06-proxy-config-defaults.edn`: upstream base
  URLs, default prefixes/paths/OAuth values, the default model catalogue).
  Environment variables always win over the facts. Reading the process
  environment, resolving paths against the filesystem and loading the facts are
  the edge's job (proxx.runtime.config).

  The result is the string-keyed camelCase ProxyConfig map (absent optional
  settings are nil). Validation failures throw `ex-info` with the message the
  host reports; fields are evaluated in a fixed order, so when several variables
  are invalid the first in that order is the one reported."
  (:require [clojure.string :as str]
            [proxx.jsval :as j]))

;; ---------------------------------------------------------------------------
;; Facts
;; ---------------------------------------------------------------------------

(defn facts-from-contracts
  "{:defaults <the :proxy-config-defaults contract> :providers [<:provider-base-url contracts>]}."
  [contracts]
  {:defaults (or (some #(when (= :proxy-config-defaults (:contract/kind %)) %) contracts)
                 (throw (ex-info "Policy has no :proxy-config-defaults contract" {:error/type ::missing-defaults})))
   :providers (filterv #(= :provider-base-url (:contract/kind %)) contracts)})

(defn default-models [facts] (:defaults/models (:defaults facts)))

;; ---------------------------------------------------------------------------
;; Environment readers (each mirrors the original's accepted spellings and errors)
;; ---------------------------------------------------------------------------

(defn- fail [msg] (throw (ex-info msg {:error/type ::invalid-config})))

(defn- first-set
  "[name value] of the first variable that is set and non-empty."
  [env-get names]
  (some (fn [n] (let [v (env-get n)] (when (j/truthy? v) [n v]))) names))

(defn- number-env [env-get names fallback valid? ]
  (if-let [[n raw] (first-set env-get names)]
    (let [parsed (j/js-number raw)]
      (if (and (j/finite? parsed) (valid? parsed))
        parsed
        (fail (str "Invalid numeric environment variable " n ": " raw))))
    fallback))

(defn- positive-env [env-get names fallback] (number-env env-get names fallback pos?))
(defn- non-negative-env [env-get names fallback] (number-env env-get names fallback #(>= % 0)))

(defn- bool-env [env-get names fallback]
  (if-let [[n raw] (first-set env-get names)]
    (let [normalized (j/lower (j/trim raw))]
      (cond (contains? #{"1" "true" "yes" "on"} normalized) true
            (contains? #{"0" "false" "no" "off"} normalized) false
            :else (fail (str "Invalid boolean environment variable " n ": " raw))))
    fallback))

(defn- csv-env [env-get name fallback]
  (let [raw (env-get name)]
    (cond (nil? raw) (vec fallback)
          (= "" raw) []
          :else (->> (str/split raw #"," -1) (map j/trim) (remove empty?) vec))))

(defn- number-map-env [env-get name]
  (let [raw (env-get name)]
    (if-not (j/truthy? raw)
      {}
      (reduce (fn [acc entry]
                (let [sep (str/index-of entry "=")]
                  (when (or (<= sep 0) (= sep (dec (count entry))))
                    (fail (str "Invalid numeric map in " name ": " entry)))
                  (let [k (j/trim (subs entry 0 sep))
                        amount (j/js-number (j/trim (subs entry (inc sep))))]
                    (when-not (and (j/finite? amount) (>= amount 0))
                      (fail (str "Invalid numeric map in " name ": " entry)))
                    (assoc acc (j/lower k) amount))))
              {}
              (->> (str/split raw #"," -1) (map j/trim) (remove empty?))))))

(defn- path-env
  "A resolved path from the first set variable, else from `fallback` (nil fallback: nil)."
  [env-get resolve-path cwd names fallback]
  (if-let [[_ raw] (first-set env-get names)]
    (resolve-path cwd raw)
    (when fallback (resolve-path cwd fallback))))

(defn- trimmed-or-nil [v] (let [t (some-> v j/trim)] (when (seq t) t)))
(defn- strip-trailing-slashes [s] (str/replace s #"/+$" ""))
(defn- nullish-or [& xs] (apply j/first-non-nil xs))

(defn- images-mode [raw]
  (let [normalized (j/lower (j/trim (or raw "auto")))]
    (cond (= normalized "auto") "auto"
          (contains? #{"platform" "api" "api.openai.com"} normalized) "platform"
          (contains? #{"chatgpt" "backend-api" "backend"} normalized) "chatgpt"
          :else (fail (str "Invalid OPENAI_IMAGES_UPSTREAM_MODE: " (or raw "") " (expected: platform|chatgpt|auto)")))))

(defn- provider-base-url [env-get {:keys [provider/base-url-env-names provider/default-base-url]}]
  (if (seq base-url-env-names)
    (strip-trailing-slashes
     (nullish-or (some #(let [v (env-get %)] (when (some? v) v)) base-url-env-names) default-base-url))
    default-base-url))

;; ---------------------------------------------------------------------------
;; The configuration
;; ---------------------------------------------------------------------------

(defn build-config
  "The ProxyConfig for `env-get`/`cwd` given `resolve-path` (cwd, path => absolute path) and `facts`."
  [env-get resolve-path cwd facts]
  (let [d (:defaults facts)
        upstream-provider-id "vivgrid"
        provider-urls (into [] (map (fn [p] [(:provider/id p) (provider-base-url env-get p)])) (:providers facts))
        upstream-base-url (strip-trailing-slashes (second (some #(when (= upstream-provider-id (first %)) %) provider-urls)))
        disabled-provider-ids (vec (distinct (remove empty? (map j/trim (csv-env env-get "DISABLED_PROVIDER_IDS" [])))))
        openai-provider-id (j/trim (nullish-or (env-get "OPENAI_PROVIDER_ID") (:defaults/openai-provider-id d)))
        openai-base-url (strip-trailing-slashes (nullish-or (env-get "OPENAI_BASE_URL") (:defaults/openai-base-url d)))
        openai-api-base-url (strip-trailing-slashes (nullish-or (env-get "OPENAI_API_BASE_URL") (:defaults/openai-api-base-url d)))
        openai-images-upstream-mode (images-mode (env-get "OPENAI_IMAGES_UPSTREAM_MODE"))
        ollama-base-url (strip-trailing-slashes (nullish-or (env-get "OLLAMA_BASE_URL") (:defaults/ollama-base-url d)))
        ollama-api-key (trimmed-or-nil (env-get "OLLAMA_API_KEY"))
        proxy-auth-token (trimmed-or-nil (env-get "PROXY_AUTH_TOKEN"))
        allow-unauthenticated (bool-env env-get ["PROXY_ALLOW_UNAUTHENTICATED" "VIVGRID_ALLOW_UNAUTHENTICATED"] false)
        _ (when (and (not proxy-auth-token) (not allow-unauthenticated))
            (fail "PROXY_AUTH_TOKEN is required unless PROXY_ALLOW_UNAUTHENTICATED=true"))
        _ (when (empty? openai-provider-id) (fail "OPENAI_PROVIDER_ID must not be empty"))
        local-ollama-enabled (bool-env env-get ["LOCAL_OLLAMA_ENABLED"] true)
        local-ollama-model-patterns (csv-env env-get "LOCAL_OLLAMA_MODEL_PATTERNS" (:defaults/local-ollama-model-patterns d))
        database-url (trimmed-or-nil (env-get "DATABASE_URL"))
        github-client-id (trimmed-or-nil (env-get "GITHUB_OAUTH_CLIENT_ID"))
        github-client-secret (trimmed-or-nil (env-get "GITHUB_OAUTH_CLIENT_SECRET"))
        github-callback-path (or (trimmed-or-nil (env-get "GITHUB_OAUTH_CALLBACK_PATH")) (:defaults/github-oauth-callback-path d))
        github-allowed-users (csv-env env-get "GITHUB_ALLOWED_USERS" [])
        session-secret (or (trimmed-or-nil (env-get "SESSION_SECRET")) proxy-auth-token (:defaults/session-secret d))
        proxy-token-pepper (or (trimmed-or-nil (env-get "PROXY_TOKEN_PEPPER")) session-secret)
        images-generations-path (:defaults/images-generations-path d)
        openai-images-generations-paths (csv-env env-get "OPENAI_IMAGES_GENERATIONS_PATHS" (:defaults/openai-images-generations-paths d))
        image-cost-usd-default (non-negative-env env-get ["IMAGE_COST_USD_DEFAULT"] 0)
        image-cost-usd-by-provider (number-map-env env-get "IMAGE_COST_USD_BY_PROVIDER")
        oauth-scopes (let [t (j/trim (nullish-or (env-get "OPENAI_OAUTH_SCOPES") (:defaults/openai-oauth-scopes d)))]
                       (if (seq t) t (:defaults/openai-oauth-scopes d)))
        oauth-client-id (let [t (j/trim (nullish-or (env-get "OPENAI_OAUTH_CLIENT_ID") (:defaults/openai-oauth-client-id d)))]
                          (if (seq t) t (:defaults/openai-oauth-client-id d)))
        oauth-issuer (strip-trailing-slashes
                      (let [t (j/trim (nullish-or (env-get "OPENAI_OAUTH_ISSUER") (:defaults/openai-oauth-issuer d)))]
                        (if (seq t) t (:defaults/openai-oauth-issuer d))))
        oauth-client-secret (trimmed-or-nil (nullish-or (env-get "OPENAI_OAUTH_CLIENT_SECRET") ""))
        oauth-allow-host-routed (bool-env env-get ["OPENAI_OAUTH_ALLOW_HOST_ROUTED_CALLBACKS"] false)
        oauth-refresh-max-concurrency (positive-env env-get ["OAUTH_REFRESH_MAX_CONCURRENCY"] 32)
        oauth-refresh-background-interval-ms (positive-env env-get ["OAUTH_REFRESH_BACKGROUND_INTERVAL_MS"] 15000)
        oauth-refresh-proactive-window-ms (positive-env env-get ["OAUTH_REFRESH_PROACTIVE_WINDOW_MS"] (* 30 60000))
        path (partial path-env env-get resolve-path cwd)
        ;; Evaluated in the original's object-literal order so the first invalid variable is the one reported.
        host (nullish-or (env-get "PROXY_HOST") (env-get "HOST") "127.0.0.1")
        port (positive-env env-get ["PROXY_PORT" "PORT"] 8789)
        request-logs-max-entries (positive-env env-get ["PROXY_REQUEST_LOGS_MAX_ENTRIES"] 100000)
        request-logs-flush-ms (non-negative-env env-get ["PROXY_REQUEST_LOGS_FLUSH_MS"] 1000)
        prompt-affinity-flush-ms (non-negative-env env-get ["PROXY_PROMPT_AFFINITY_FLUSH_MS"] 250)
        key-reload-ms (positive-env env-get ["PROXY_KEY_RELOAD_MS" "VIVGRID_KEY_RELOAD_MS"] 5000)
        key-cooldown-ms (positive-env env-get ["PROXY_KEY_COOLDOWN_MS" "VIVGRID_KEY_COOLDOWN_MS"] (* 4 60 60 1000))
        key-cooldown-jitter-factor (positive-env env-get ["PROXY_KEY_COOLDOWN_JITTER_FACTOR"] 0.4)
        enable-key-random-walk (bool-env env-get ["PROXY_KEY_RANDOM_WALK"] true)
        ollama-weekly-cooldown-multiplier (positive-env env-get ["OLLAMA_WEEKLY_COOLDOWN_MULTIPLIER"] 24)
        request-timeout-ms (positive-env env-get ["UPSTREAM_REQUEST_TIMEOUT_MS"] 900000)
        stream-bootstrap-timeout-ms (positive-env env-get ["UPSTREAM_STREAM_BOOTSTRAP_TIMEOUT_MS"] 8000)
        embed-max-context-tokens (positive-env env-get ["EMBED_MAX_CONTEXT_TOKENS"] 262144)
        embed-max-batch-items (positive-env env-get ["EMBED_MAX_BATCH_ITEMS"] 128)
        embed-max-input-chars (positive-env env-get ["EMBED_MAX_INPUT_CHARS"] 250000)
        upstream-transient-retry-count (non-negative-env env-get ["UPSTREAM_TRANSIENT_RETRY_COUNT"] 2)
        upstream-transient-retry-backoff-ms (positive-env env-get ["UPSTREAM_TRANSIENT_RETRY_BACKOFF_MS"] 350)
        concurrency-throttle-max-retries (non-negative-env env-get ["CONCURRENCY_THROTTLE_MAX_RETRIES"] 3)
        concurrency-throttle-threshold-ms (positive-env env-get ["CONCURRENCY_THROTTLE_THRESHOLD_MS"] 30000)
        cljs-policy-shadow-mode (bool-env env-get ["PROXX_CLJS_POLICY_SHADOW" "PROXY_CLJS_POLICY_SHADOW"] false)
        cljs-policy-authoritative (bool-env env-get ["PROXX_CLJS_POLICY_AUTHORITATIVE" "PROXY_CLJS_POLICY_AUTHORITATIVE"] false)]
    {"host" host
     "port" port
     "upstreamProviderId" upstream-provider-id
     "disabledProviderIds" disabled-provider-ids
     "upstreamProviderBaseUrls" (into {} provider-urls)
     "upstreamBaseUrl" upstream-base-url
     "openaiProviderId" openai-provider-id
     "openaiBaseUrl" openai-base-url
     "openaiApiBaseUrl" openai-api-base-url
     "openaiImagesUpstreamMode" openai-images-upstream-mode
     "ollamaBaseUrl" ollama-base-url
     "ollamaApiKey" ollama-api-key
     "localOllamaEnabled" local-ollama-enabled
     "localOllamaModelPatterns" local-ollama-model-patterns
     "chatCompletionsPath" (:defaults/chat-completions-path d)
     "openaiChatCompletionsPath" (nullish-or (env-get "OPENAI_CHAT_COMPLETIONS_PATH") (:defaults/openai-chat-completions-path d))
     "messagesPath" (:defaults/messages-path d)
     "messagesModelPrefixes" (:defaults/messages-model-prefixes d)
     "messagesInterleavedThinkingBeta" (let [b (:defaults/messages-interleaved-thinking-beta d)] (when (seq b) b))
     "responsesPath" (:defaults/responses-path d)
     "openaiResponsesPath" (nullish-or (env-get "OPENAI_RESPONSES_PATH") (:defaults/openai-responses-path d))
     "openaiImagesGenerationsPaths" openai-images-generations-paths
     "imageCostUsdDefault" image-cost-usd-default
     "imageCostUsdByProvider" image-cost-usd-by-provider
     "imagesGenerationsPath" images-generations-path
     "responsesModelPrefixes" (:defaults/responses-model-prefixes d)
     "ollamaChatPath" (nullish-or (env-get "OLLAMA_CHAT_PATH") (:defaults/ollama-chat-path d))
     "ollamaV1ChatPath" (nullish-or (env-get "OLLAMA_V1_CHAT_PATH") (:defaults/ollama-v1-chat-path d))
     "factoryModelPrefixes" (csv-env env-get "FACTORY_MODEL_PREFIXES" (:defaults/factory-model-prefixes d))
     "openaiModelPrefixes" (csv-env env-get "OPENAI_MODEL_PREFIXES" (:defaults/openai-model-prefixes d))
     "ollamaModelPrefixes" (csv-env env-get "OLLAMA_MODEL_PREFIXES" (:defaults/ollama-model-prefixes d))
     "llamacppModelPrefixes" (csv-env env-get "LLAMACPP_MODEL_PREFIXES" (:defaults/llamacpp-model-prefixes d))
     "keysFilePath" (or (path ["PROXY_KEYS_FILE" "VIVGRID_KEYS_FILE"] nil)
                        (path ["PROXY_KEYS_FILE" "VIVGRID_KEYS_FILE"] "./keys.json"))
     "modelsFilePath" (path ["PROXY_MODELS_FILE" "VIVGRID_MODELS_FILE"] "./models.json")
     "requestLogsFilePath" (path ["PROXY_REQUEST_LOGS_FILE"] "./data/request-logs.jsonl")
     "requestLogsMaxEntries" request-logs-max-entries
     "requestLogsFlushMs" request-logs-flush-ms
     "promptAffinityFilePath" (path ["PROXY_PROMPT_AFFINITY_FILE"] "./data/prompt-affinity.json")
     "promptAffinityFlushMs" prompt-affinity-flush-ms
     "settingsFilePath" (path ["PROXY_SETTINGS_FILE"] "./data/proxy-settings.json")
     "keyReloadMs" key-reload-ms
     "keyCooldownMs" key-cooldown-ms
     "keyCooldownJitterFactor" key-cooldown-jitter-factor
     "enableKeyRandomWalk" enable-key-random-walk
     "ollamaWeeklyCooldownMultiplier" ollama-weekly-cooldown-multiplier
     "requestTimeoutMs" request-timeout-ms
     "streamBootstrapTimeoutMs" stream-bootstrap-timeout-ms
     "embedMaxContextTokens" embed-max-context-tokens
     "embedMaxBatchItems" embed-max-batch-items
     "embedMaxInputChars" embed-max-input-chars
     "upstreamTransientRetryCount" upstream-transient-retry-count
     "upstreamTransientRetryBackoffMs" upstream-transient-retry-backoff-ms
     "concurrencyThrottleMaxRetries" concurrency-throttle-max-retries
     "concurrencyThrottleThresholdMs" concurrency-throttle-threshold-ms
     "proxyAuthToken" proxy-auth-token
     "proxyTokenPepper" proxy-token-pepper
     "allowUnauthenticated" allow-unauthenticated
     "policyConfigPath" (env-get "PROXY_POLICY_CONFIG_FILE")
     "cljsPolicyManifestPath" (path ["PROXX_CLJS_POLICY_MANIFEST" "PROXY_CLJS_POLICY_MANIFEST"] (:defaults/policy-manifest d))
     "cljsPolicyShadowMode" cljs-policy-shadow-mode
     "cljsPolicyAuthoritative" cljs-policy-authoritative
     "databaseUrl" database-url
     "githubOAuthClientId" github-client-id
     "githubOAuthClientSecret" github-client-secret
     "githubOAuthCallbackPath" github-callback-path
     "githubAllowedUsers" github-allowed-users
     "sessionSecret" session-secret
     "openaiOauthScopes" oauth-scopes
     "openaiOauthClientId" oauth-client-id
     "openaiOauthIssuer" oauth-issuer
     "openaiOauthClientSecret" oauth-client-secret
     "openaiOauthAllowHostRoutedCallbacks" oauth-allow-host-routed
     "oauthRefreshMaxConcurrency" oauth-refresh-max-concurrency
     "oauthRefreshBackgroundIntervalMs" oauth-refresh-background-interval-ms
     "oauthRefreshProactiveWindowMs" oauth-refresh-proactive-window-ms}))
