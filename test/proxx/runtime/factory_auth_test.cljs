(ns proxx.runtime.factory-auth-test
  "Factory OAuth refresh, auth.v2 persistence and the key pool's handling of
  Factory accounts, ported from the TypeScript factory-oauth-refresh tests."
  (:require ["node:crypto" :as crypto]
            ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [proxx.oauth.factory :as factory]
            [proxx.runtime.factory-auth :as fa]
            [proxx.support.keypool :as sk :refer [make-pool make-jwt ids]]
            [proxx.support.tmp :as tmp :refer [with-json-file with-env with-tmp-dir]]))

(set! *warn-on-infer* false)

;; ─── Helpers ────────────────────────────────────────────────────────────────

(defn- now-s [] (js/Math.floor (/ (js/Date.now) 1000)))

(defn- expired-jwt [minutes-ago] (make-jwt {"exp" (- (now-s) (* minutes-ago 60)) "sub" "user-expired"}))
(defn- fresh-jwt [minutes-from-now] (make-jwt {"exp" (+ (now-s) (* minutes-from-now 60)) "sub" "user-fresh"}))

(defn- factory-credential
  "A JS credential; `overrides` is a map of JS property name -> value (nil removes)."
  [overrides]
  (let [token (get overrides "token" (fresh-jwt 120))
        o (js/Object.assign
           #js {"providerId" "factory" "accountId" "factory-acct-1" "token" token "authType" "oauth_bearer"
                "refreshToken" "rt-test-refresh-token"}
           (clj->js (dissoc overrides "refreshToken" "expiresAt")))]
    (aset o "refreshToken" (get overrides "refreshToken" "rt-test-refresh-token"))
    (let [expires (if (contains? overrides "expiresAt") (get overrides "expiresAt") (fa/parse-jwt-expiry-js token))]
      (if (some? expires) (aset o "expiresAt" expires) (js-delete o "expiresAt")))
    (when (nil? (aget o "refreshToken")) (js-delete o "refreshToken"))
    o))

(defn- random-key [] (.toString (.randomBytes crypto 32) "base64"))

(def ^:private no-factory-env
  {"FACTORY_API_KEY" nil "FACTORY_AUTH_V2_FILE" "/tmp/nonexistent-auth-v2-file" "FACTORY_AUTH_V2_KEY" "/tmp/nonexistent-auth-v2-key"})

(defn- pool-config [file m]
  (clj->js (merge {:keysFilePath file :reloadIntervalMs 10 :defaultCooldownMs 1000 :defaultProviderId "vivgrid"} m)))

(defn- seq* [arr] (vec (array-seq arr)))

(defn- ^:async with-factory-keys
  "Run async `f` with a warmed pool over a keys file that holds `provider-doc`
  (the \"providers\" map), no ambient Factory auth files, and the env map `env`."
  [providers config-overrides env f]
  (await (with-env (merge no-factory-env (:process-env env))
           (fn ^:async cb []
             (await (with-json-file "factory-oauth-test-" (clj->js {"providers" providers})
                      (fn ^:async cb [file]
                        (let [pool (make-pool (pool-config file config-overrides) :env (:pool-env env))]
                          (await (.warmup pool))
                          (await (f pool))))))))))

;; ─── JWT parsing ────────────────────────────────────────────────────────────

(deftest parse-jwt-expiry-extracts-exp-from-factory-style-jwt
  (let [exp-seconds (+ (now-s) 7200)
        jwt (make-jwt {"exp" exp-seconds "sub" "user_123" "iss" "workos"})]
    (is (= (* exp-seconds 1000) (fa/parse-jwt-expiry-js jwt)))))

(deftest parse-jwt-expiry-is-nil-for-fk-api-keys
  (is (nil? (fa/parse-jwt-expiry-js "fk-abc123def456"))))

(deftest parse-jwt-expiry-is-nil-for-the-empty-string
  (is (nil? (fa/parse-jwt-expiry-js ""))))

(deftest parse-jwt-expiry-is-nil-for-non-numeric-exp
  (is (nil? (fa/parse-jwt-expiry-js (make-jwt {"exp" "not-a-number" "sub" "test"})))))

(deftest parse-jwt-expiry-handles-large-exp-values
  (let [exp-seconds 2000000000]
    (is (= (* exp-seconds 1000) (fa/parse-jwt-expiry-js (make-jwt {"exp" exp-seconds}))))))

;; ─── factoryCredentialNeedsRefresh ──────────────────────────────────────────

(defn- needs-refresh? [credential] (fa/factory-credential-needs-refresh-js credential))

(deftest needs-refresh-when-jwt-expires-within-30-minutes
  (is (true? (needs-refresh? (factory-credential {"token" (fresh-jwt 15)})))))

(deftest needs-refresh-when-jwt-is-already-expired
  (let [jwt (expired-jwt 5)]
    (is (true? (needs-refresh? (factory-credential {"token" jwt "expiresAt" (fa/parse-jwt-expiry-js jwt)}))))))

(deftest no-refresh-when-jwt-expires-in-2-hours
  (is (false? (needs-refresh? (factory-credential {"token" (fresh-jwt 120)})))))

(deftest no-refresh-for-non-factory-credentials
  (is (false? (needs-refresh? (factory-credential {"providerId" "openai" "token" (fresh-jwt 15)})))))

(deftest no-refresh-for-api-key-auth-type
  (is (false? (needs-refresh? #js {"providerId" "factory" "accountId" "fk-test" "token" "fk-static-key" "authType" "api_key"}))))

(deftest no-refresh-when-there-is-no-refresh-token
  (is (false? (needs-refresh? (factory-credential {"refreshToken" nil})))))

(deftest expires-at-is-the-fallback-when-the-token-is-not-a-jwt
  (is (true? (needs-refresh? #js {"providerId" "factory" "accountId" "test-acct" "token" "not-a-jwt-token" "authType" "oauth_bearer"
                                  "refreshToken" "rt-test" "expiresAt" (+ (js/Date.now) (* 10 60 1000))}))))

(deftest no-refresh-when-expires-at-is-far-in-the-future-and-token-is-not-a-jwt
  (is (false? (needs-refresh? #js {"providerId" "factory" "accountId" "test-acct" "token" "not-a-jwt-token" "authType" "oauth_bearer"
                                   "refreshToken" "rt-test" "expiresAt" (+ (js/Date.now) (* 120 60 1000))}))))

(deftest boundary-exactly-30-minutes-triggers-refresh
  ;; The JWT exp is in whole seconds, so it lands at or below the buffer boundary,
  ;; and the comparison is strict.
  (let [exp-seconds (js/Math.floor (/ (+ (js/Date.now) factory/refresh-buffer-ms) 1000))
        jwt (make-jwt {"exp" exp-seconds})]
    (is (true? (needs-refresh? (factory-credential {"token" jwt}))))))

(deftest boundary-31-minutes-does-not-trigger-refresh
  (is (false? (needs-refresh? (factory-credential {"token" (fresh-jwt 31)})))))

;; ─── refreshFactoryOAuthToken ───────────────────────────────────────────────

(deftest ^:async refresh-sends-the-correct-workos-request-and-parses-the-response
  (let [captured (atom {})
        new-access (fresh-jwt 120)
        new-refresh "rt-new-refresh-token"
        mock-fetch (fn [input init]
                     (reset! captured {:url (str input)
                                       :body (if (string? (.-body init)) (.-body init) "")
                                       :headers (into {} (map (fn [k] [k (aget (.-headers init) k)])) (js/Object.keys (.-headers init)))})
                     (js/Promise.resolve
                      (js/Response. (js/JSON.stringify (clj->js {"access_token" new-access "refresh_token" new-refresh
                                                                 "user" {"email" "test@factory.ai" "first_name" "Test" "last_name" "User" "id" "user_123"}}))
                                    #js {"status" 200 "headers" #js {"content-type" "application/json"}})))
        result (await (fa/refresh-factory-oauth-token-js "rt-old-refresh-token" mock-fetch))
        params (js/URLSearchParams. (:body @captured))]
    (is (= "https://api.workos.com/user_management/authenticate" (:url @captured)))
    (is (= "application/x-www-form-urlencoded" (get-in @captured [:headers "content-type"])))
    (is (= "refresh_token" (.get params "grant_type")))
    (is (= "rt-old-refresh-token" (.get params "refresh_token")))
    (is (= "client_01HNM792M5G5G1A2THWPXKFMXB" (.get params "client_id")))
    (is (= new-access (.-accessToken result)))
    (is (= new-refresh (.-refreshToken result)))
    (is (number? (.-expiresAt result)))))

(deftest ^:async refresh-throws-on-http-error
  (let [mock-fetch (fn [& _] (js/Promise.resolve (js/Response. "Unauthorized" #js {"status" 401})))]
    (is (thrown-with-msg? js/Error #"WorkOS token refresh failed: 401"
                          (await (fa/refresh-factory-oauth-token-js "rt-bad-token" mock-fetch))))))

(deftest ^:async refresh-throws-on-missing-access-token
  (let [mock-fetch (fn [& _] (js/Promise.resolve (js/Response. (js/JSON.stringify #js {"refresh_token" "rt-new"})
                                                               #js {"status" 200 "headers" #js {"content-type" "application/json"}})))]
    (is (thrown-with-msg? js/Error #"missing access_token"
                          (await (fa/refresh-factory-oauth-token-js "rt-test" mock-fetch))))))

(deftest ^:async refresh-throws-on-missing-refresh-token-in-response
  (let [mock-fetch (fn [& _] (js/Promise.resolve (js/Response. (js/JSON.stringify #js {"access_token" (fresh-jwt 60)})
                                                               #js {"status" 200 "headers" #js {"content-type" "application/json"}})))]
    (is (thrown-with-msg? js/Error #"missing refresh_token"
                          (await (fa/refresh-factory-oauth-token-js "rt-test" mock-fetch))))))

;; ─── encryptAuthV2 / decryptAuthV2 ──────────────────────────────────────────

(deftest encrypt-auth-v2-round-trips-through-decrypt
  (let [key (random-key)
        data #js {"access_token" (fresh-jwt 120) "refresh_token" "rt-round-trip-test"}
        decrypted (fa/decrypt-auth-v2-js key (fa/encrypt-auth-v2-js key data))]
    (is (= (.-access_token data) (.-accessToken decrypted)))
    (is (= (.-refresh_token data) (.-refreshToken decrypted)))))

(deftest encrypt-auth-v2-uses-a-random-iv
  (let [key (random-key)
        data #js {"access_token" "same-token" "refresh_token" "same-refresh"}
        e1 (fa/encrypt-auth-v2-js key data)
        e2 (fa/encrypt-auth-v2-js key data)]
    (is (not= e1 e2))
    (is (= "same-token" (.-accessToken (fa/decrypt-auth-v2-js key e1))))
    (is (= "same-token" (.-accessToken (fa/decrypt-auth-v2-js key e2))))))

;; ─── persistFactoryAuthV2 ───────────────────────────────────────────────────

(deftest ^:async persist-writes-encrypted-tokens-that-can-be-decrypted
  (await (with-tmp-dir "factory-persist-test-"
           (fn ^:async cb [dir]
             (let [key (random-key)
                   auth-file (.join path dir "auth.v2.file")
                   key-file (.join path dir "auth.v2.key")
                   access-token (fresh-jwt 120)
                   refresh-token "rt-persist-test"]
               (await (.writeFile fsp key-file key "utf8"))
               (await (with-env {"FACTORY_AUTH_V2_FILE" auth-file "FACTORY_AUTH_V2_KEY" key-file}
                        (fn ^:async cb []
                          (await (fa/persist-factory-auth-v2-js access-token refresh-token))
                          (let [decrypted (fa/decrypt-auth-v2-js key (await (.readFile fsp auth-file "utf8")))]
                            (is (= access-token (.-accessToken decrypted)))
                            (is (= refresh-token (.-refreshToken decrypted))))))))))))

(deftest ^:async persist-does-not-throw-when-the-key-file-is-missing
  (let [warnings (atom [])
        original (.-warn js/console)]
    (aset js/console "warn" (fn [& args] (swap! warnings conj (apply str args))))
    (try
      (await (with-env {"FACTORY_AUTH_V2_FILE" "/tmp/nonexistent-persist-file" "FACTORY_AUTH_V2_KEY" "/tmp/nonexistent-persist-key"}
               (fn ^:async cb [] (await (fa/persist-factory-auth-v2-js "token" "refresh")))))
      (is true "resolved without throwing")
      (is (some #(.includes % "[factory-auth] Failed to persist refreshed tokens") @warnings) "logs a warning instead")
      (finally (aset js/console "warn" original)))))

;; ─── Multi-account rotation ─────────────────────────────────────────────────

(deftest ^:async multiple-factory-accounts-rotate-via-round-robin
  (await (with-factory-keys {"factory" {"auth" "api_key"
                                        "accounts" [{"id" "acct-1" "api_key" "fk-key-1"}
                                                    {"id" "acct-2" "api_key" "fk-key-2"}
                                                    {"id" "acct-3" "api_key" "fk-key-3"}]}}
           {} {}
           (fn ^:async cb [pool]
             (let [lead (fn ^:async cb [] (let [order (seq* (await (.getRequestOrder pool "factory")))]
                                            (is (= 3 (count order)))
                                            (.-token (first order))))
                   lead-tokens [(await (lead)) (await (lead)) (await (lead))]]
               (is (= 3 (count (set lead-tokens))) (str "Expected 3 unique lead tokens, got: " (pr-str lead-tokens)))
               (doseq [token lead-tokens]
                 (is (.startsWith token "fk-") (str "Expected fk- prefix, got: " token))))))))

(deftest ^:async round-robin-rotation-with-3-factory-oauth-accounts
  (let [jwt (fn [sub] (make-jwt {"exp" (+ (now-s) 7200) "sub" sub}))
        [jwt1 jwt2 jwt3] (map jwt ["user-1" "user-2" "user-3"])]
    (await (with-factory-keys {"factory" {"auth" "oauth_bearer"
                                          "accounts" [{"id" "oauth-1" "access_token" jwt1 "refresh_token" "rt-1"}
                                                      {"id" "oauth-2" "access_token" jwt2 "refresh_token" "rt-2"}
                                                      {"id" "oauth-3" "access_token" jwt3 "refresh_token" "rt-3"}]}}
             {} {}
             (fn ^:async cb [pool]
               (let [seen (atom #{})]
                 (dotimes [_ 3]
                   (let [accounts (seq* (await (.getRequestOrder pool "factory")))]
                     (is (= 3 (count accounts)))
                     (swap! seen conj (.-token (first accounts)))))
                 (is (= 3 (count @seen)) "All 3 OAuth accounts should rotate as lead")))))))

;; ─── Cooldown on 429 ────────────────────────────────────────────────────────

(deftest ^:async factory-account-is-placed-in-cooldown-after-a-429
  (await (with-factory-keys {"factory" {"auth" "api_key"
                                        "accounts" [{"id" "acct-1" "api_key" "fk-key-1"} {"id" "acct-2" "api_key" "fk-key-2"}]}}
           {:defaultCooldownMs 30000} {}
           (fn ^:async cb [pool]
             (let [initial (seq* (await (.getRequestOrder pool "factory")))]
               (is (= 2 (count initial)))
               (.markRateLimited pool (first initial))
               (let [after (seq* (await (.getRequestOrder pool "factory")))]
                 (is (= 1 (count after)) "Rate-limited account should be excluded")
                 (is (not= (.-token (first initial)) (.-token (first after))) "Should use different account after cooldown")))))))

(deftest ^:async factory-429-cooldown-with-all-accounts-rate-limited-returns-empty
  (await (with-factory-keys {"factory" {"auth" "api_key" "accounts" [{"id" "acct-1" "api_key" "fk-key-1"}]}}
           {:defaultCooldownMs 30000} {}
           (fn ^:async cb [pool]
             (let [accounts (seq* (await (.getRequestOrder pool "factory")))]
               (is (= 1 (count accounts)))
               (.markRateLimited pool (first accounts))
               (is (= 0 (count (seq* (await (.getRequestOrder pool "factory"))))) "All accounts in cooldown should return empty"))))))

;; ─── OAuth token refresh at the 30-minute window ────────────────────────────

(deftest refresh-triggers-when-jwt-expires-within-30-minutes
  (is (true? (needs-refresh? (factory-credential {"token" (fresh-jwt 20)})))))

(deftest refresh-does-not-trigger-when-jwt-expires-in-60-minutes
  (is (false? (needs-refresh? (factory-credential {"token" (fresh-jwt 60)})))))

;; ─── Refreshed token persisted to the credential store ──────────────────────

(deftest ^:async refreshed-tokens-can-be-persisted-and-re-read-from-the-auth-v2-file
  (await (with-tmp-dir "factory-refresh-persist-test-"
           (fn ^:async cb [dir]
             (let [key (random-key)
                   auth-file (.join path dir "auth.v2.file")
                   key-file (.join path dir "auth.v2.key")
                   initial-token (fresh-jwt 10)
                   refreshed-token (fresh-jwt 120)
                   refreshed-refresh "rt-refreshed"]
               (await (.writeFile fsp auth-file (fa/encrypt-auth-v2-js key #js {"access_token" initial-token "refresh_token" "rt-initial"}) "utf8"))
               (await (.writeFile fsp key-file key "utf8"))
               (await (with-env {"FACTORY_AUTH_V2_FILE" auth-file "FACTORY_AUTH_V2_KEY" key-file}
                        (fn ^:async cb []
                          (await (fa/persist-factory-auth-v2-js refreshed-token refreshed-refresh))
                          (let [decrypted (fa/decrypt-auth-v2-js key (await (.readFile fsp auth-file "utf8")))]
                            (is (= refreshed-token (.-accessToken decrypted)))
                            (is (= refreshed-refresh (.-refreshToken decrypted)))
                            (is (not= initial-token (.-accessToken decrypted))))))))))))

;; ─── In-flight streaming not interrupted by token refresh ───────────────────

(deftest ^:async in-flight-token-remains-valid-during-refresh
  (let [jwt1 (make-jwt {"exp" (+ (now-s) 600) "sub" "user-near-expiry"})
        jwt2 (make-jwt {"exp" (+ (now-s) 7200) "sub" "user-fresh"})]
    (await (with-factory-keys {"factory" {"auth" "oauth_bearer"
                                          "accounts" [{"id" "oauth-near-expiry" "access_token" jwt1 "refresh_token" "rt-1" "expires_at" (fa/parse-jwt-expiry-js jwt1)}
                                                      {"id" "oauth-fresh" "access_token" jwt2 "refresh_token" "rt-2" "expires_at" (fa/parse-jwt-expiry-js jwt2)}]}}
             {} {}
             (fn ^:async cb [pool]
               (let [accounts (seq* (await (.getRequestOrder pool "factory")))
                     _ (is (pos? (count accounts)) "Should have available accounts")
                     in-flight (first accounts)
                     release (.markInFlight pool in-flight)
                     refreshed-token (fresh-jwt 120)
                     refreshed (doto (js/Object.assign #js {} in-flight)
                                 (aset "token" refreshed-token)
                                 (aset "expiresAt" (fa/parse-jwt-expiry-js refreshed-token))
                                 (aset "refreshToken" "rt-refreshed"))]
                 (.updateAccountCredential pool "factory" in-flight refreshed)
                 (is (pos? (count (.-token in-flight))) "Original token should still be available in-memory")
                 (release)
                 (let [refreshed-account (first (filter #(= (.-accountId in-flight) (.-accountId %))
                                                        (seq* (await (.getRequestOrder pool "factory")))))]
                   (is (some? refreshed-account))
                   (is (= refreshed-token (.-token refreshed-account)) "Next request should use refreshed token"))))))))

;; ─── Factory credentials don't leak to other providers ──────────────────────

(deftest ^:async factory-credentials-are-isolated-from-other-providers
  (await (with-factory-keys {"vivgrid" {"accounts" ["vg-key-1"]} "openrouter" {"accounts" ["or-key-1"]}}
           {} {:pool-env {"FACTORY_API_KEY" "fk-factory-only"}} ; pragma: allowlist secret
           (fn ^:async cb [pool]
             (let [factory (seq* (await (.getRequestOrder pool "factory")))]
               (is (= 1 (count factory)))
               (is (= "fk-factory-only" (.-token (first factory))))
               (is (= "factory" (.-providerId (first factory)))))
             (doseq [provider ["vivgrid" "openrouter"]
                     account (seq* (await (.getRequestOrder pool provider)))]
               (is (not= "fk-factory-only" (.-token account)) (str "Factory key should not leak to " provider)))))))

;; ─── updateAccountCredential ────────────────────────────────────────────────

(deftest ^:async update-account-credential-updates-token-and-expires-at-in-memory
  (let [original (fresh-jwt 10)
        refreshed (fresh-jwt 120)]
    (await (with-factory-keys {"factory" {"auth" "oauth_bearer"
                                          "accounts" [{"id" "to-refresh" "access_token" original "refresh_token" "rt-1" "expires_at" (fa/parse-jwt-expiry-js original)}]}}
             {:reloadIntervalMs 100000} {}
             (fn ^:async cb [pool]
               (let [before (seq* (await (.getAllAccounts pool "factory")))
                     _ (is (= 1 (count before)))
                     old (first before)
                     _ (is (= original (.-token old)))
                     new-credential (doto (js/Object.assign #js {} old)
                                      (aset "token" refreshed)
                                      (aset "expiresAt" (fa/parse-jwt-expiry-js refreshed))
                                      (aset "refreshToken" "rt-refreshed"))]
                 (.updateAccountCredential pool "factory" old new-credential)
                 (let [after (seq* (await (.getAllAccounts pool "factory")))]
                   (is (= 1 (count after)))
                   (is (= refreshed (.-token (first after))))
                   (is (= "rt-refreshed" (.-refreshToken (first after)))))))))))

;; ─── Expired tokens are skipped ─────────────────────────────────────────────

(deftest ^:async expired-factory-oauth-tokens-are-excluded-from-get-request-order
  (let [expired (make-jwt {"exp" (- (now-s) 300) "sub" "user-expired"})
        fresh (make-jwt {"exp" (+ (now-s) 7200) "sub" "user-fresh"})]
    (await (with-factory-keys {"factory" {"auth" "oauth_bearer"
                                          "accounts" [{"id" "expired" "access_token" expired "refresh_token" "rt-1" "expires_at" (fa/parse-jwt-expiry-js expired)}
                                                      {"id" "fresh" "access_token" fresh "refresh_token" "rt-2" "expires_at" (fa/parse-jwt-expiry-js fresh)}]}}
             {:reloadIntervalMs 100000} {}
             (fn ^:async cb [pool]
               (let [accounts (seq* (await (.getRequestOrder pool "factory")))]
                 (is (= 1 (count accounts)) "Only non-expired account should be returned")
                 (is (= "fresh" (.-accountId (first accounts))))))))))
