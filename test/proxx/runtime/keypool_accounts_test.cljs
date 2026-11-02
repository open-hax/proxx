(ns proxx.runtime.keypool-accounts-test
  "Key pool sources, ordering, cooldown and disable behaviour through the CLJS
  edge (`proxx.runtime.keypool`), ported from the TypeScript key-pool tests."
  (:require [cljs.test :refer [deftest is async]]
            [proxx.support.keypool :as sk :refer [make-pool ids]]
            [proxx.support.tmp :as tmp :refer [with-json-file with-now with-captured-console]]))

(set! *warn-on-infer* false)

(defn- config
  "A JS KeyPoolConfig over `file` with the test defaults, overridden by `m`."
  [file m]
  (clj->js (merge {:keysFilePath file :reloadIntervalMs 10 :defaultCooldownMs 1000 :defaultProviderId "ollama-cloud"} m)))

(defn- seq* [arr] (vec (array-seq arr)))

(defn- uuid-v5? [s] (boolean (re-matches sk/uuid-v5-pattern (str s))))

(deftest ^:async accepts-provider-key-arrays-and-generates-uuid-account-ids
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"auth" "api_key" "accounts" ["oc-key-1" "oc-key-2"]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {}))]
               (await (.warmup pool))
               (let [accounts (seq* (await (.getRequestOrder pool "ollama-cloud")))]
                 (is (= 2 (count accounts)))
                 (is (every? #(= "ollama-cloud" (.-providerId %)) accounts))
                 (is (every? #(= "api_key" (.-authType %)) accounts))
                 (is (every? #(uuid-v5? (.-accountId %)) accounts))
                 (is (= 2 (count (set (map #(.-accountId %) accounts)))))))))))

(deftest ^:async generated-account-ids-are-stable-across-automatic-reloads
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"accounts" ["oc-key-a" "oc-key-b"]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {:reloadIntervalMs 1}))]
               (await (.warmup pool))
               (let [first-ids (vec (sort (ids (await (.getRequestOrder pool "ollama-cloud")))))
                     _ (await (tmp/sleep 5))
                     second-ids (vec (sort (ids (await (.getRequestOrder pool "ollama-cloud")))))]
                 (is (= first-ids second-ids))
                 (is (every? uuid-v5? second-ids))))))))

(deftest ^:async explicit-account-ids-are-preserved-while-string-entries-are-generated
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"auth" "api_key"
                                                  "accounts" [{"id" "oc-primary" "token" "oc-token-primary"}
                                                              "oc-key-fallback"]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {}))]
               (await (.warmup pool))
               (let [accounts (ids (await (.getRequestOrder pool "ollama-cloud")))
                     generated (first (remove #{"oc-primary"} accounts))]
                 (is (= 2 (count accounts)))
                 (is (contains? (set accounts) "oc-primary"))
                 (is (string? generated))
                 (is (uuid-v5? generated))))))))

(deftest ^:async non-busy-accounts-are-preferred-before-reusing-in-flight-accounts
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"auth" "api_key"
                                                  "accounts" [{"id" "oc-a" "token" "oc-token-a"}
                                                              {"id" "oc-b" "token" "oc-token-b"}]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {}))]
               (await (.warmup pool))
               (let [initial (seq* (await (.getRequestOrder pool "ollama-cloud")))
                     _ (is (= 2 (count initial)))
                     release (.markInFlight pool (first initial))
                     reordered (seq* (await (.getRequestOrder pool "ollama-cloud")))]
                 (is (= 2 (count reordered)))
                 (is (= (.-accountId (second initial)) (.-accountId (first reordered))))
                 (is (= (.-accountId (first initial)) (.-accountId (second reordered))))
                 (release)
                 (is (= 0 (.-inFlightAccounts (await (.getStatus pool "ollama-cloud")))))))))))

(deftest ^:async random-walk-excludes-accounts-that-are-still-cooling-down
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"auth" "api_key"
                                                  "accounts" [{"id" "oc-a" "token" "oc-token-a"}
                                                              {"id" "oc-b" "token" "oc-token-b"}]}}})
           (fn ^:async cb [file]
             (let [clock (atom 1700000000000)]
               (await (with-now clock
                        (fn ^:async cb []
                          (let [pool (make-pool (config file {:defaultCooldownMs 1000 :cooldownJitterFactor 0 :enableRandomWalk true})
                                                :rng (fn [] 0.5))]
                            (await (.warmup pool))
                            (let [initial (seq* (await (.getRequestOrder pool "ollama-cloud")))]
                              (is (= 2 (count initial)))
                              (.markRateLimited pool (first initial) 60000)
                              (is (= [(.-accountId (second initial))]
                                     (ids (await (.getRequestOrder pool "ollama-cloud")))))
                              (swap! clock + 60001)
                              (is (= 2 (count (seq* (await (.getRequestOrder pool "ollama-cloud"))))))))))))))))

(deftest ^:async refresh-ordering-omits-accounts-that-are-still-cooling-down
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"openai" {"auth" "oauth_bearer"
                                            "accounts" [{"id" "oa-a" "access_token" "oa-token-a" "chatgpt_account_id" "chatgpt-a"}
                                                        {"id" "oa-b" "access_token" "oa-token-b" "chatgpt_account_id" "chatgpt-b"}]}}})
           (fn ^:async cb [file]
             (await (with-now (atom 1700000000000)
                      (fn ^:async cb []
                        (let [pool (make-pool (config file {:defaultProviderId "openai"}))]
                          (await (.warmup pool))
                          (let [initial (seq* (await (.getRequestOrder pool "openai")))]
                            (is (= 2 (count initial)))
                            (.markRateLimited pool (first initial) 60000)
                            (is (= [(.-accountId (second initial))]
                                   (ids (await (.getRequestOrderWithRefresh pool "openai" (fn ^:async cb [_] nil)))))))))))))))

(deftest ^:async status-and-account-health-exclude-expired-disabled-and-cooling-oauth-accounts
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"openai" {"auth" "oauth_bearer"
                                            "accounts" [{"id" "oa-ready" "access_token" "oa-token-ready" "expires_at" 1700000120000}
                                                        {"id" "oa-expired" "access_token" "oa-token-expired" "expires_at" 1699999999000}
                                                        {"id" "oa-disabled" "access_token" "oa-token-disabled" "expires_at" 1700000120000}
                                                        {"id" "oa-cooldown" "access_token" "oa-token-cooldown" "expires_at" 1700000120000}]}}})
           (fn ^:async cb [file]
             (await (with-now (atom 1700000000000)
                      (fn ^:async cb []
                        (let [pool (make-pool (config file {:defaultProviderId "openai" :defaultCooldownMs 1000 :cooldownJitterFactor 0
                                                            :disabledStore #js {:loadDisabledAccounts (fn [] (js/Promise.resolve (js/Set. #js ["openai\u0000oa-disabled"])))
                                                                                :setAccountDisabled (fn [] (js/Promise.resolve))}}))]
                          (await (.warmup pool))
                          (let [cooldown (first (filter #(= "oa-cooldown" (.-accountId %)) (seq* (await (.getAllAccounts pool "openai")))))]
                            (.markRateLimited pool cooldown 60000)
                            (is (= ["oa-ready"] (ids (await (.getRequestOrder pool "openai")))))
                            (let [status (await (.getStatus pool "openai"))]
                              (is (= 4 (.-totalAccounts status)))
                              (is (= 1 (.-availableAccounts status)))
                              (is (= 1 (.-expiredAccounts status)))
                              (is (= 1 (.-disabledAccounts status)))
                              (is (= 1 (.-cooldownAccounts status))))
                            (let [statuses (aget (await (.getAllAccountStatuses pool)) "openai")
                                  by-id (into {} (map (fn [s] [(.-accountId s) s])) (array-seq (or statuses #js [])))]
                              (is (true? (.-available (by-id "oa-ready"))))
                              (is (true? (.-expired (by-id "oa-expired"))))
                              (is (true? (.-available (by-id "oa-expired")))
                                  "account-status available remains cooldown-only for UI compatibility")
                              (is (true? (.-disabled (by-id "oa-disabled"))))
                              (is (true? (.-available (by-id "oa-disabled")))
                                  "disabled is reported separately from cooldown readiness")
                              (is (false? (.-available (by-id "oa-cooldown"))))))))))))))

(deftest ^:async weighted-shuffle-rescales-remaining-weight-mass-between-picks
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"auth" "api_key"
                                                  "accounts" [{"id" "oc-a" "token" "oc-token-a"}
                                                              {"id" "oc-b" "token" "oc-token-b"}
                                                              {"id" "oc-c" "token" "oc-token-c"}]}}})
           (fn ^:async cb [file]
             (let [values (atom [0 0 1 0.95 0.95 0.95])
                   rng (fn [] (let [[v & more] @values] (reset! values (vec more)) (if (some? v) v 0.5)))
                   pool (make-pool (config file {:defaultCooldownMs 1000 :cooldownJitterFactor 0 :enableRandomWalk true}) :rng rng)]
               (await (.warmup pool))
               (is (= ["oc-c" "oc-b" "oc-a"] (ids (await (.getRequestOrder pool "ollama-cloud"))))))))))

(deftest ^:async rate-limit-cooldown-survives-oauth-token-refresh-for-the-same-account
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"openai" {"auth" "oauth_bearer"
                                            "accounts" [{"id" "oa-1" "access_token" "oa-token-old" "chatgpt_account_id" "chatgpt-a"}]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {:reloadIntervalMs 100000 :defaultCooldownMs 60000 :defaultProviderId "openai"}))]
               (await (.warmup pool))
               (let [credential (first (seq* (await (.getRequestOrder pool "openai"))))
                     refreshed (doto (js/Object.assign #js {} credential) (aset "token" "oa-token-new"))]
                 (.markRateLimited pool credential 60000)
                 (.updateAccountCredential pool "openai" credential refreshed)
                 (is (= [] (seq* (await (.getRequestOrder pool "openai")))))))))))

(deftest ^:async persisted-cooldown-timestamps-are-normalized-to-integers
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"openai" {"auth" "oauth_bearer"
                                            "accounts" [{"id" "oa-1" "access_token" "oa-token-1" "chatgpt_account_id" "chatgpt-a"}]}}})
           (fn ^:async cb [file]
             (let [persisted (atom [])]
               (await (with-now (atom 1700000000000)
                        (fn ^:async cb []
                          (let [pool (make-pool (config file {:reloadIntervalMs 100000 :defaultCooldownMs 60000 :defaultProviderId "openai"
                                                              :cooldownJitterFactor 0.4
                                                              :cooldownStore #js {:loadCooldowns (fn [] (js/Promise.resolve (js/Map.)))
                                                                                  :persistCooldown (fn [_ _ until] (swap! persisted conj until) (js/Promise.resolve))
                                                                                  :clearCooldown (fn [] (js/Promise.resolve))}})
                                                :rng (fn [] 1))]
                            (await (.warmup pool))
                            (let [credential (first (seq* (await (.getRequestOrder pool "openai"))))]
                              (.markRateLimited pool credential 60000)
                              (await (tmp/sleep 0))
                              (is (= 1 (count @persisted)))
                              (is (js/Number.isInteger (first @persisted)))))))))))))

(deftest ^:async env-backed-openrouter-and-requesty-providers-load-alongside-file-accounts
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"accounts" ["oc-key-1"]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {})
                                   :env {"OPENROUTER_API_KEY" "or-token-1" "REQUESTY_API_TOKEN" "req-key-1"})] ; pragma: allowlist secret
               (await (.warmup pool))
               (let [openrouter (seq* (await (.getRequestOrder pool "openrouter")))
                     requesty (seq* (await (.getRequestOrder pool "requesty")))]
                 (is (= 1 (count openrouter)))
                 (is (= "openrouter" (.-providerId (first openrouter))))
                 (is (= "or-token-1" (.-token (first openrouter))))
                 (is (uuid-v5? (.-accountId (first openrouter))))
                 (is (= 1 (count requesty)))
                 (is (= "requesty" (.-providerId (first requesty))))
                 (is (= "req-key-1" (.-token (first requesty))))
                 (is (uuid-v5? (.-accountId (first requesty))))))))))

(deftest ^:async warmup-clears-stale-provider-accounts-when-the-account-store-becomes-empty
  (let [providers (atom (js/Map. #js [#js ["openai" #js {:authType "oauth_bearer"}]]))
        accounts (atom (js/Map. #js [#js ["openai" #js [#js {:providerId "openai" :accountId "chatgpt-a1-account" :token "access-a1"
                                                             :authType "oauth_bearer" :chatgptAccountId "chatgpt-a1"}]]]))
        pool (make-pool #js {:keysFilePath "/tmp/nonexistent-keys.json" :reloadIntervalMs 1 :defaultCooldownMs 1000 :defaultProviderId "openai"
                             :accountStore #js {:getAllProviders (fn [] (js/Promise.resolve (js/Map. @providers)))
                                                :getAllAccounts (fn [] (js/Promise.resolve (js/Map. @accounts)))}
                             :preferAccountStoreProviders true})]
    (await (.warmup pool))
    (is (= 1 (count (seq* (await (.getAllAccounts pool "openai"))))))
    (reset! providers (js/Map.))
    (reset! accounts (js/Map.))
    (await (.warmup pool))
    (is (= 0 (count (seq* (await (.getAllAccounts pool "openai"))))))
    (is (thrown-with-msg? js/Error #"No accounts configured for provider: openai"
                          (await (.getRequestOrder pool "openai"))))))

(deftest ^:async env-backed-gemini-provider-loads-via-gemini-api-key
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"accounts" ["oc-key-1"]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {}) :env {"GEMINI_API_KEY" "gem-key-1"})] ; pragma: allowlist secret
               (await (.warmup pool))
               (let [gemini (seq* (await (.getRequestOrder pool "gemini")))]
                 (is (= 1 (count gemini)))
                 (is (= "gemini" (.-providerId (first gemini))))
                 (is (= "gem-key-1" (.-token (first gemini))))
                 (is (uuid-v5? (.-accountId (first gemini))))))))))

(deftest ^:async env-backed-zai-rotussy-and-mistral-providers-load
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"ollama-cloud" {"accounts" ["oc-key-1"]}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {})
                                   :env {"ZAI_API_KEY" "zai-key-1" "ROTUSSY_API_KEY" "rotussy-key-1" "MISTRAL_API_KEY" "mistral-key-1"})] ; pragma: allowlist secret
               (await (.warmup pool))
               (doseq [[provider token] [["zai" "zai-key-1"] ["rotussy" "rotussy-key-1"] ["mistral" "mistral-key-1"]]]
                 (let [accounts (seq* (await (.getRequestOrder pool provider)))]
                   (is (= 1 (count accounts)) provider)
                   (is (= provider (.-providerId (first accounts))))
                   (is (= token (.-token (first accounts)))))))))))

(deftest ^:async epoch-second-oauth-expirations-are-treated-as-future-timestamps
  (let [expires-at-seconds (+ (js/Math.floor (/ (js/Date.now) 1000)) 3600)]
    (await (with-json-file "open-hax-key-pool-test-"
             (clj->js {"providers" {"openai" {"auth" "oauth_bearer"
                                              "accounts" [{"id" "oa-plus" "access_token" "oa-token" "refresh_token" "oa-refresh"
                                                           "expires_at" expires-at-seconds "chatgpt_account_id" "cgpt-plus" "plan_type" "plus"}]}}})
             (fn ^:async cb [file]
               (let [pool (make-pool (config file {:defaultProviderId "openai"}))]
                 (await (.warmup pool))
                 (let [accounts (seq* (await (.getRequestOrder pool "openai")))]
                   (is (= 1 (count accounts)))
                   (is (= "oa-plus" (.-accountId (first accounts))))
                   (is (= (* expires-at-seconds 1000) (.-expiresAt (first accounts))))
                   (is (false? (.isAccountExpired pool (first accounts)))))))))))

(deftest ^:async inline-json-credentials-load-from-env-without-a-keys-file
  (let [inline (js/JSON.stringify (clj->js {"providers" {"vivgrid" {"auth" "api_key" "accounts" [{"id" "env-vg" "token" "vg-inline-token"}]}}}))
        pool (make-pool (config (str (.tmpdir (js/require "node:os")) "/missing-" (js/Date.now) ".json") {:defaultProviderId "vivgrid"})
                        :env {"PROXY_KEYS_JSON" inline})]
    (await (.warmup pool))
    (let [accounts (seq* (await (.getRequestOrder pool "vivgrid")))]
      (is (= 1 (count accounts)))
      (is (= "vivgrid" (.-providerId (first accounts))))
      (is (= "env-vg" (.-accountId (first accounts))))
      (is (= "vg-inline-token" (.-token (first accounts)))))))

(deftest ^:async malformed-inline-json-is-ignored-when-another-source-is-available
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"vivgrid" {"auth" "api_key" "accounts" [{"id" "file-vg" "token" "vg-file-token"}]}}})
           (fn ^:async cb [file]
             (let [warnings (atom [])]
               (await (with-captured-console "warn" warnings
                        (fn ^:async cb []
                          (let [pool (make-pool (config file {:defaultProviderId "vivgrid"}) :env {"PROXY_KEYS_JSON" "{not-valid-json"})]
                            (await (.warmup pool))
                            (let [accounts (seq* (await (.getRequestOrder pool "vivgrid")))]
                              (is (= 1 (count accounts)))
                              (is (= "file-vg" (.-accountId (first accounts))))
                              (is (= "vg-file-token" (.-token (first accounts))))
                              (is (some #(.includes % "Failed to parse inline keys JSON from env") @warnings))))))))))))

(deftest ^:async credentials-load-from-the-account-store-when-a-database-source-is-configured
  (let [store #js {:getAllProviders (fn [] (js/Promise.resolve (js/Map. #js [#js ["openai" #js {:authType "oauth_bearer"}]])))
                   :getAllAccounts (fn [] (js/Promise.resolve
                                           (js/Map. #js [#js ["openai" #js [#js {:providerId "openai" :accountId "db-openai-1" :token "db-token-1"
                                                                                  :authType "oauth_bearer" :refreshToken "db-refresh-1"
                                                                                  :chatgptAccountId "cgpt-db-1"}]]])))}
        pool (make-pool (config (str "/tmp/missing-" (js/Date.now) "-" (js/Math.random) ".json")
                                {:defaultProviderId "openai" :accountStore store}))]
    (await (.warmup pool))
    (let [accounts (seq* (await (.getRequestOrder pool "openai")))]
      (is (= 1 (count accounts)))
      (is (= "openai" (.-providerId (first accounts))))
      (is (= "db-openai-1" (.-accountId (first accounts))))
      (is (= "db-token-1" (.-token (first accounts))))
      (is (= "oauth_bearer" (.-authType (first accounts)))))))

(defn- ^:async with-factory-pool
  "Pool over a factory keys file whose accounts are `account-ids`; no ambient
  Factory OAuth credentials (the loader reports none, as with absent files)."
  [account-ids f]
  (await (with-json-file "open-hax-key-pool-test-"
           (clj->js {"providers" {"factory" {"auth" "api_key"
                                             "accounts" (mapv (fn [i] {"id" (str "acct-" i) "api_key" (str "fk-key-" i)}) account-ids)}}})
           (fn ^:async cb [file]
             (let [pool (make-pool (config file {:defaultProviderId "factory"}))]
               (await (.warmup pool))
               (await (f pool)))))))

(deftest ^:async disable-account-excludes-account-from-get-request-order
  (await (with-factory-pool [1 2 3]
           (fn ^:async cb [pool]
             (is (= 3 (count (seq* (await (.getRequestOrder pool "factory"))))))
             (.disableAccount pool "factory" "acct-2")
             (let [after (ids (await (.getRequestOrder pool "factory")))]
               (is (= 2 (count after)))
               (is (every? #(not= "acct-2" %) after) "Disabled account should not be in results"))))))

(deftest ^:async enable-account-re-includes-disabled-account-in-get-request-order
  (await (with-factory-pool [1 2]
           (fn ^:async cb [pool]
             (.disableAccount pool "factory" "acct-1")
             (let [after-disable (ids (await (.getRequestOrder pool "factory")))]
               (is (= 1 (count after-disable)))
               (is (= "acct-2" (first after-disable))))
             (.enableAccount pool "factory" "acct-1")
             (let [after-enable (ids (await (.getRequestOrder pool "factory")))]
               (is (= 2 (count after-enable)))
               (is (some #{"acct-1"} after-enable))
               (is (some #{"acct-2"} after-enable)))))))

(deftest ^:async is-account-disabled-returns-correct-state
  (await (with-factory-pool [1 2]
           (fn ^:async cb [pool]
             (is (false? (.isAccountDisabled pool "factory" "acct-1")))
             (is (false? (.isAccountDisabled pool "factory" "acct-2")))
             (.disableAccount pool "factory" "acct-1")
             (is (true? (.isAccountDisabled pool "factory" "acct-1")))
             (is (false? (.isAccountDisabled pool "factory" "acct-2")))
             (.enableAccount pool "factory" "acct-1")
             (is (false? (.isAccountDisabled pool "factory" "acct-1")))
             (is (false? (.isAccountDisabled pool "factory" "acct-2")))))))

(deftest ^:async get-disabled-accounts-returns-list-of-disabled-accounts
  (await (with-factory-pool [1 2 3]
           (fn ^:async cb [pool]
             (is (= [] (seq* (.getDisabledAccounts pool))))
             (.disableAccount pool "factory" "acct-1")
             (.disableAccount pool "factory" "acct-3")
             (let [disabled (seq* (.getDisabledAccounts pool))]
               (is (= 2 (count disabled)))
               (is (some #(and (= "factory" (.-providerId %)) (= "acct-1" (.-accountId %))) disabled))
               (is (some #(and (= "factory" (.-providerId %)) (= "acct-3" (.-accountId %))) disabled))
               (is (not-any? #(= "acct-2" (.-accountId %)) disabled)))))))

(deftest ^:async disabled-accounts-are-excluded-from-get-request-order-with-refresh
  (await (with-factory-pool [1 2]
           (fn ^:async cb [pool]
             (is (= 2 (count (seq* (await (.getRequestOrder pool "factory"))))))
             (.disableAccount pool "factory" "acct-1")
             (let [accounts (seq* (await (.getRequestOrderWithRefresh pool "factory" (fn ^:async cb [_] nil))))]
               (is (= 1 (count accounts)))
               (is (= "acct-2" (.-accountId (first accounts)))))))))

(deftest ^:async disabling-all-accounts-returns-empty-array-when-requesting-order
  (await (with-factory-pool [1 2]
           (fn ^:async cb [pool]
             (.disableAccount pool "factory" "acct-1")
             (.disableAccount pool "factory" "acct-2")
             (is (= 0 (count (seq* (await (.getRequestOrder pool "factory"))))))))))
