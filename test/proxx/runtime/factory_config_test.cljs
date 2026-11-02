(ns proxx.runtime.factory-config-test
  "Factory provider configuration: base URLs and prefixes from the environment,
  the key pool's Factory sources, auth.v2 decryption and JWT expiry parsing.
  Ported from the TypeScript factory-config tests, over the CLJS kernels the
  TypeScript `loadConfig`, `KeyPool`, routing and factory-auth modules delegate to."
  (:require ["node:crypto" :as crypto]
            ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [proxx.runtime.config :as config]
            [proxx.runtime.factory-auth :as fa]
            [proxx.runtime.routing :as routing]
            [proxx.support.keypool :as sk :refer [make-process-pool make-jwt]]
            [proxx.support.tmp :refer [with-env with-json-file with-tmp-dir]]))

(set! *warn-on-infer* false)

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- load-config
  "`loadConfig(cwd)`: the configuration of the ambient `process.env`."
  [cwd]
  (config/load-config-js js/process.env cwd manifest))

(defn- routing-state [^js cfg model]
  (routing/resolve-request-routing-state-js manifest cfg model))

(defn- seq* [arr] (vec (array-seq arr)))

(defn- key-pool-config [file m]
  (clj->js (merge {:keysFilePath file :reloadIntervalMs 10 :defaultCooldownMs 1000 :defaultProviderId "vivgrid"} m)))

(def ^:private nonexistent-auth
  {"FACTORY_AUTH_V2_FILE" "/tmp/nonexistent-auth-v2-file"
   "FACTORY_AUTH_V2_KEY" "/tmp/nonexistent-auth-v2-key"})

(defn- encrypt-auth-v2
  "AES-256-GCM `iv:tag:ciphertext` of `data`, built independently of the code under test."
  [key-base64 data]
  (let [key (js/Buffer.from (.trim key-base64) "base64")
        iv (.randomBytes crypto 16)
        cipher (.createCipheriv crypto "aes-256-gcm" key iv)
        ciphertext (js/Buffer.concat #js [(.update cipher (js/JSON.stringify (clj->js data)) "utf-8") (.final cipher)])
        auth-tag (.getAuthTag cipher)]
    (str (.toString iv "base64") ":" (.toString auth-tag "base64") ":" (.toString ciphertext "base64"))))

(defn- random-key [] (.toString (.randomBytes crypto 32) "base64"))

(defn- now-s [] (js/Math.floor (/ (js/Date.now) 1000)))

(defn- ^:async with-warm-pool
  "Run async `f` with a warmed pool over a keys file holding `payload` (a clj map),
  under the env map `env` (nil value deletes)."
  [env payload pool-config f]
  (await (with-env env
           (fn ^:async cb []
             (await (with-json-file "factory-config-test-" (clj->js payload)
                      (fn ^:async cb [file]
                        (let [pool (make-process-pool (key-pool-config file pool-config))]
                          (await (.warmup pool))
                          (await (f pool))))))))))

;; --- VAL-CONFIG-001: Factory provider registered in provider base-URL map ----

(deftest ^:async default-provider-base-url-returns-api-factory-ai-for-factory
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "FACTORY_BASE_URL" nil}
           (fn []
             (let [cfg (load-config "/tmp/factory-config-test")]
               (is (= "https://api.factory.ai" (aget (.-upstreamProviderBaseUrls cfg) "factory"))))))))

(deftest ^:async factory-base-url-env-var-overrides-factory-base-url
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "FACTORY_BASE_URL" "https://custom.factory.example.com/api"}
           (fn []
             (let [cfg (load-config "/tmp/factory-config-test")]
               (is (= "https://custom.factory.example.com/api" (aget (.-upstreamProviderBaseUrls cfg) "factory"))))))))

(deftest ^:async default-provider-base-url-returns-zai-and-mistral-defaults
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "ZAI_BASE_URL" nil "ZHIPU_BASE_URL" nil "MISTRAL_BASE_URL" nil}
           (fn []
             (let [cfg (load-config "/tmp/provider-config-test")]
               (is (= "https://api.z.ai/api/paas/v4" (aget (.-upstreamProviderBaseUrls cfg) "zai")))
               (is (= "https://api.mistral.ai/v1" (aget (.-upstreamProviderBaseUrls cfg) "mistral"))))))))

(deftest ^:async default-provider-base-url-returns-xiaomi-mimo-default
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "XIAOMI_BASE_URL" nil "MIMO_BASE_URL" nil}
           (fn []
             (let [cfg (load-config "/tmp/provider-config-test")]
               (is (= "https://api.xiaomimimo.com/v1" (aget (.-upstreamProviderBaseUrls cfg) "xiaomi"))))))))

;; --- VAL-CONFIG-002: FACTORY_API_KEY env var creates a factory provider in KeyPool ---

(deftest ^:async factory-api-key-env-var-creates-factory-provider-in-key-pool
  (await (with-warm-pool (merge nonexistent-auth {"FACTORY_API_KEY" "fk-test-factory-key-123"}) ; pragma: allowlist secret
           {"providers" {"vivgrid" {"accounts" ["vg-key-1"]}}} {}
           (fn ^:async cb [pool]
             (let [factory-accounts (seq* (await (.getRequestOrder pool "factory")))
                   account (first factory-accounts)]
               (is (= 1 (count factory-accounts)))
               (is (= "factory" (.-providerId account)))
               (is (= "fk-test-factory-key-123" (.-token account)))
               (is (= "api_key" (.-authType account)))
               (is (re-matches sk/uuid-v5-pattern (or (.-accountId account) ""))))))))

;; --- VAL-CONFIG-005: Factory provider excluded when in DISABLED_PROVIDER_IDS ---

(deftest ^:async factory-provider-excluded-when-disabled-provider-ids-is-factory
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "DISABLED_PROVIDER_IDS" "factory"}
           (fn []
             (let [cfg (load-config "/tmp/factory-config-test")]
               (is (.includes (.-disabledProviderIds cfg) "factory")))))))

;; --- VAL-AUTH-008: Empty or malformed FACTORY_API_KEY logs warning, does not crash ---

(deftest ^:async empty-factory-api-key-is-skipped-gracefully
  (await (with-warm-pool (merge nonexistent-auth {"FACTORY_API_KEY" "   "})
           {"providers" {"vivgrid" {"accounts" ["vg-key-1"]}}} {}
           (fn ^:async cb [pool]
             (let [factory-accounts (await (.getAllAccounts pool "factory"))]
               (is (= 0 (.-length factory-accounts))))))))

;; --- Factory model prefix routing ---

(deftest factory-prefix-is-recognized-and-strips-prefix
  (let [prefixes #js ["factory/" "factory:"]]
    (is (routing/has-model-prefix-js "factory/claude-opus-4-5" prefixes))
    (is (routing/has-model-prefix-js "factory:gpt-5" prefixes))
    (is (not (routing/has-model-prefix-js "claude-opus-4-5" prefixes)))
    (is (= "claude-opus-4-5" (routing/strip-model-prefix-js "factory/claude-opus-4-5" prefixes)))
    (is (= "gpt-5" (routing/strip-model-prefix-js "factory:gpt-5" prefixes)))))

(deftest ^:async resolve-request-routing-state-recognizes-factory-slash-prefix
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token"}
           (fn []
             (let [state (routing-state (load-config "/tmp/factory-config-test") "factory/claude-opus-4-5")]
               (is (true? (.-factoryPrefixed state)))
               (is (false? (.-openAiPrefixed state)))
               (is (false? (.-explicitOllama state)))
               (is (false? (.-localOllama state)))
               (is (= "claude-opus-4-5" (.-routedModel state))))))))

(deftest ^:async resolve-request-routing-state-recognizes-factory-colon-prefix
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token"}
           (fn []
             (let [state (routing-state (load-config "/tmp/factory-config-test") "factory:gpt-5")]
               (is (true? (.-factoryPrefixed state)))
               (is (= "gpt-5" (.-routedModel state))))))))

(deftest ^:async resolve-request-routing-state-does-not-set-factory-prefixed-for-non-factory-models
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token"}
           (fn []
             (let [state (routing-state (load-config "/tmp/factory-config-test") "claude-opus-4-5")]
               (is (false? (.-factoryPrefixed state)))
               (is (= "claude-opus-4-5" (.-routedModel state))))))))

;; --- Factory auth.v2 decryption ---

(deftest decrypt-auth-v2-correctly-decrypts-aes-256-gcm-encrypted-credentials
  (let [key-base64 (random-key)
        encrypted (encrypt-auth-v2 key-base64 {"access_token" "test-access-token-jwt" "refresh_token" "test-refresh-token"})
        decrypted (fa/decrypt-auth-v2-js key-base64 encrypted)]
    (is (= "test-access-token-jwt" (.-accessToken decrypted)))
    (is (= "test-refresh-token" (.-refreshToken decrypted)))))

(deftest decrypt-auth-v2-throws-on-invalid-format
  (is (thrown-with-msg? js/Error #"Invalid auth\.v2\.file format" (fa/decrypt-auth-v2-js (random-key) "invalid-content"))))

(deftest decrypt-auth-v2-throws-on-wrong-key
  (let [encrypted (encrypt-auth-v2 (random-key) {"access_token" "test-token" "refresh_token" "test-refresh"})]
    (is (thrown? js/Error (fa/decrypt-auth-v2-js (random-key) encrypted)))))

;; --- JWT expiry parsing ---

(deftest parse-jwt-expiry-extracts-expiry-from-valid-jwt
  (let [exp-seconds (+ (now-s) 3600)
        jwt (make-jwt {"exp" exp-seconds "sub" "test"})]
    (is (= (* exp-seconds 1000) (fa/parse-jwt-expiry-js jwt)))))

(deftest parse-jwt-expiry-returns-null-for-non-jwt-token
  (is (nil? (fa/parse-jwt-expiry-js "fk-some-api-key")))
  (is (nil? (fa/parse-jwt-expiry-js "not-a-jwt"))))

(deftest parse-jwt-expiry-returns-null-for-jwt-without-exp-claim
  (is (nil? (fa/parse-jwt-expiry-js (make-jwt {"sub" "test"})))))

;; --- VAL-AUTH-007: Env var and OAuth credentials coexist ---

(deftest ^:async factory-api-key-and-file-based-factory-keys-coexist-in-key-pool
  (await (with-warm-pool (merge nonexistent-auth {"FACTORY_API_KEY" "fk-env-key"}) ; pragma: allowlist secret
           {"providers" {"vivgrid" {"accounts" ["vg-key-1"]}
                         "factory" {"auth" "api_key" "accounts" ["fk-file-key"]}}} {}
           (fn ^:async cb [pool]
             (let [factory-accounts (seq* (await (.getRequestOrder pool "factory")))
                   tokens (set (map #(.-token %) factory-accounts))]
               (is (= 2 (count factory-accounts)))
               (is (contains? tokens "fk-env-key"))
               (is (contains? tokens "fk-file-key")))))))

(defn- account-store
  "A provider account store holding one OpenAI OAuth account, as the database would."
  []
  #js {:getAllProviders (fn [] (js/Promise.resolve (js/Map. #js [#js ["openai" #js {:authType "oauth_bearer"}]])))
       :getAllAccounts (fn []
                         (js/Promise.resolve
                          (js/Map. #js [#js ["openai" #js [#js {:providerId "openai" :accountId "db-openai-1"
                                                                :token "db-openai-token" :authType "oauth_bearer"}]]])))})

(deftest ^:async db-backed-key-pool-ignores-keys-json-and-inline-keys-json-at-runtime
  (await (with-warm-pool {"PROXY_KEYS_JSON" (js/JSON.stringify (clj->js {"providers" {"vivgrid" {"accounts" ["inline-vivgrid-token"]}}}))
                          "FACTORY_API_KEY" nil
                          "FACTORY_AUTH_V2_FILE" "/tmp/nonexistent-auth-v2-file"
                          "FACTORY_AUTH_V2_KEY" "/tmp/nonexistent-auth-v2-key"
                          "GEMINI_API_KEY" nil "OPENROUTER_API_KEY" nil "REQUESTY_API_KEY" nil "REQUESTY_API_TOKEN" nil}
           {"providers" {"requesty" {"accounts" ["file-requesty-token"]}}}
           {:defaultProviderId "openai" :accountStore (account-store) :preferAccountStoreProviders true}
           (fn ^:async cb [pool]
             (let [openai-accounts (await (.getAllAccounts pool "openai"))
                   requesty-accounts (await (.getAllAccounts pool "requesty"))
                   vivgrid-accounts (await (.getAllAccounts pool "vivgrid"))]
               (is (= 1 (.-length openai-accounts)))
               (is (= "db-openai-token" (.-token (aget openai-accounts 0))))
               (is (= 0 (.-length requesty-accounts)))
               (is (= 0 (.-length vivgrid-accounts))))))))

(deftest ^:async db-backed-key-pool-ignores-env-api-key-providers-at-runtime
  (await (with-warm-pool {"ZAI_API_KEY" "zai-key-1" ; pragma: allowlist secret
                          "ROTUSSY_API_KEY" "rotussy-key-1" ; pragma: allowlist secret
                          "FACTORY_API_KEY" nil "GEMINI_API_KEY" nil "OPENROUTER_API_KEY" nil
                          "REQUESTY_API_KEY" nil "REQUESTY_API_TOKEN" nil}
           {"providers" {"requesty" {"accounts" ["file-requesty-token"]}}}
           {:defaultProviderId "openai" :accountStore (account-store) :preferAccountStoreProviders true}
           (fn ^:async cb [pool]
             (let [openai-accounts (await (.getAllAccounts pool "openai"))
                   zai-accounts (await (.getAllAccounts pool "zai"))
                   rotussy-accounts (await (.getAllAccounts pool "rotussy"))
                   requesty-accounts (await (.getAllAccounts pool "requesty"))]
               (is (= 1 (.-length openai-accounts)))
               (is (= "db-openai-token" (.-token (aget openai-accounts 0))))
               (is (= 0 (.-length zai-accounts)))
               (is (= 0 (.-length rotussy-accounts)))
               (is (= 0 (.-length requesty-accounts))))))))

;; --- VAL-AUTH-004: OAuth tokens loaded from encrypted auth.v2 ---

(deftest decrypt-auth-v2-round-trips-correctly-with-encrypt-auth-v2
  (let [key-base64 (random-key)
        data {"access_token" "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxNzAwMDAwMDAwfQ.sig" ; pragma: allowlist secret
              "refresh_token" "refresh-token-value"}
        decrypted (fa/decrypt-auth-v2-js key-base64 (encrypt-auth-v2 key-base64 data))]
    (is (= (get data "access_token") (.-accessToken decrypted)))
    (is (= (get data "refresh_token") (.-refreshToken decrypted)))))

(defn- ^:async with-auth-v2-files
  "Run async `f` with the paths of an encrypted auth.v2 file holding `auth-data`."
  [prefix auth-data f]
  (await (with-tmp-dir prefix
           (fn ^:async cb [dir]
             (let [key-base64 (random-key)
                   auth-file (.join path dir "auth.v2.file")
                   key-file (.join path dir "auth.v2.key")]
               (await (.writeFile fsp auth-file (encrypt-auth-v2 key-base64 auth-data) "utf8"))
               (await (.writeFile fsp key-file key-base64 "utf8"))
               (await (f auth-file key-file)))))))

(deftest ^:async oauth-tokens-loaded-from-encrypted-auth-v2-files-into-key-pool
  (let [exp-seconds (+ (now-s) 7200) ; 2 hours from now
        fake-jwt (make-jwt {"exp" exp-seconds "sub" "test-user"})]
    (await (with-auth-v2-files "factory-auth-v2-test-" {"access_token" fake-jwt "refresh_token" "test-refresh-token"}
             (fn ^:async cb [auth-file key-file]
               (await (with-warm-pool {"FACTORY_API_KEY" nil "FACTORY_AUTH_V2_FILE" auth-file "FACTORY_AUTH_V2_KEY" key-file}
                        {"providers" {"vivgrid" {"accounts" ["vg-key-1"]}}} {}
                        (fn ^:async cb [pool]
                          (let [factory-accounts (seq* (await (.getRequestOrder pool "factory")))
                                account (first factory-accounts)]
                            (is (= 1 (count factory-accounts)))
                            (is (= fake-jwt (.-token account)))
                            (is (= "oauth_bearer" (.-authType account)))
                            (is (= "factory" (.-providerId account)))
                            (is (= "test-refresh-token" (.-refreshToken account)))
                            (is (= (* exp-seconds 1000) (.-expiresAt account))))))))))))

;; --- VAL-AUTH-007 (full): Both fk- key and OAuth token coexist ---

(deftest ^:async fk-api-key-and-oauth-token-coexist-as-separate-accounts-under-factory
  (let [exp-seconds (+ (now-s) 7200)
        fake-jwt (make-jwt {"exp" exp-seconds "sub" "test-user"})]
    (await (with-auth-v2-files "factory-auth-coexist-test-" {"access_token" fake-jwt "refresh_token" "test-refresh"}
             (fn ^:async cb [auth-file key-file]
               (await (with-warm-pool {"FACTORY_API_KEY" "fk-my-api-key" ; pragma: allowlist secret
                                       "FACTORY_AUTH_V2_FILE" auth-file "FACTORY_AUTH_V2_KEY" key-file}
                        {"providers" {"vivgrid" {"accounts" ["vg-key-1"]}}} {}
                        (fn ^:async cb [pool]
                          (let [factory-accounts (seq* (await (.getRequestOrder pool "factory")))
                                api-key-account (first (filter #(= "api_key" (.-authType %)) factory-accounts))
                                oauth-account (first (filter #(= "oauth_bearer" (.-authType %)) factory-accounts))]
                            (is (= 2 (count factory-accounts)))
                            (is (some? api-key-account))
                            (is (= "fk-my-api-key" (.-token api-key-account)))
                            (is (= "factory" (.-providerId api-key-account)))
                            (is (some? oauth-account))
                            (is (= fake-jwt (.-token oauth-account)))
                            (is (= "factory" (.-providerId oauth-account)))
                            (is (= "test-refresh" (.-refreshToken oauth-account))))))))))))

;; --- factoryModelPrefixes config ---

(deftest ^:async factory-model-prefixes-defaults-to-factory-slash-and-factory-colon
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "FACTORY_MODEL_PREFIXES" nil}
           (fn []
             (is (= ["factory/" "factory:"] (seq* (.-factoryModelPrefixes (load-config "/tmp/factory-config-test")))))))))

(deftest ^:async factory-model-prefixes-env-var-overrides-factory-prefixes
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token" "FACTORY_MODEL_PREFIXES" "fai/,fai:"}
           (fn []
             (is (= ["fai/" "fai:"] (seq* (.-factoryModelPrefixes (load-config "/tmp/factory-config-test")))))))))

;; --- VAL-AUTH-001: fk- API keys accepted for Factory requests ---

(deftest ^:async fk-prefixed-api-key-loads-into-key-pool-under-factory-provider
  (await (with-warm-pool (merge nonexistent-auth {"FACTORY_API_KEY" "fk-abcdef123456"}) ; pragma: allowlist secret
           {"providers" {"vivgrid" {"accounts" ["vg-key-1"]}}} {}
           (fn ^:async cb [pool]
             (let [factory-accounts (seq* (await (.getRequestOrder pool "factory")))
                   account (first factory-accounts)]
               (is (= 1 (count factory-accounts)))
               (is (= "fk-abcdef123456" (.-token account)))
               (is (= "api_key" (.-authType account)))
               (is (= "factory" (.-providerId account))))))))

;; --- factory/ prefix takes precedence over openai/ and ollama/ ---

(deftest ^:async factory-prefix-takes-precedence-over-other-prefix-patterns
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token"}
           (fn []
             ;; factory/ prefix should be recognized as factory, not openai or ollama
             (let [state (routing-state (load-config "/tmp/factory-config-test") "factory/openai/gpt-5")]
               (is (true? (.-factoryPrefixed state)))
               (is (false? (.-openAiPrefixed state)))
               (is (false? (.-explicitOllama state)))
               (is (= "openai/gpt-5" (.-routedModel state))))))))
