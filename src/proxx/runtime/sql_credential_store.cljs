(ns proxx.runtime.sql-credential-store
  "Edge of the Postgres credential store (`src/lib/db/sql-credential-store.ts`):
  tenants, users, memberships, tenant API keys, providers, accounts and cooldowns.
  Row <-> domain mapping and statement composition are `proxx.credentials.sql`
  (via `proxx.runtime.sql`); statement texts are `proxx.db.schema`; this namespace
  runs them over a postgres.js client and owns the in-process cooldown cache."
  (:require ["node:crypto" :as crypto]
            [proxx.credentials.sql :as sql]
            [proxx.runtime.account-identity :as identity]
            [proxx.runtime.db-schema :as db-schema]
            [proxx.runtime.sql :as views]
            [proxx.runtime.sql-util :as u]
            [proxx.routing.tenant-key :as tk]
            [proxx.runtime.tenant-key :as tenant-key]))

(defn- statement [id] (db-schema/sql-statement-js id))

(defn- guarded [f] (try (f) (catch :default e (u/rethrow-as-error e))))

(defn create-sql-credential-store-js
  "The facade `SqlCredentialStore` forwards to. `options`: {defaultTenantId?}."
  ([sql] (create-sql-credential-store-js sql nil))
  ([^js sql ^js options]
   (let [initialized (atom false)
         cooldowns (atom {})
         default-tenant-id tk/default-tenant-id
         run (fn [text values] (if (seq values) (.unsafe sql text (to-array values)) (.unsafe sql text)))
         run-id (fn [id values] (run (statement id) values))
         first-row (fn [rows] (aget rows 0))
         optional (fn [view rows] (let [row (first-row rows)] (if row (view row) js/undefined)))
         normalize-tenant (fn [t] (tenant-key/normalize-tenant-id-js t))
list-user-memberships (fn [user-id]
               (.then (run-id "SELECT_TENANT_MEMBERSHIPS_BY_USER" [user-id])
                      (fn [rows] (.map rows (fn [row] (views/membership-view-js row))))))

             get-user-by-subject (fn [subject]
               (let [normalized (.toLowerCase (.trim subject))]
                 (if (zero? (.-length normalized))
                   (js/Promise.resolve js/undefined)
                   (.then (run-id "SELECT_USER_BY_SUBJECT" [normalized])
                          (fn [rows] (optional views/user-view-js rows))))))

             ensure-tenant-membership (fn [user-id tenant-id role]
               (let [t (normalize-tenant tenant-id)]
                 (.then (run-id "UPSERT_TENANT_MEMBERSHIP" [t user-id role]) (fn [_] js/undefined))))

             providers-map (fn []
               (.then (run-id "SELECT_ALL_PROVIDERS" [])
                      (fn [rows]
                        (let [m (js/Map.)]
                          (doseq [^js row (array-seq rows)]
                            (.set m (.-id row) #js {"authType" (sql/normalize-auth-type (.-auth_type row))}))
                          m))))

             credential-of (fn [row auth-type] (views/provider-credential-js row auth-type))

             upsert-provider (fn [provider-id auth-type]
               (.then (run-id "UPSERT_PROVIDER" [provider-id auth-type nil]) (fn [_] js/undefined)))

             cleanup-legacy-openai-duplicates (fn ^:async cleanup-legacy [chatgpt-account-id]
               (let [{:strs [text values]} (sql/openai-accounts-query (statement "SELECT_ACCOUNTS_BY_PROVIDER") chatgpt-account-id)
                     rows (await (run text values))
                     ids (views/legacy-openai-duplicate-ids-js rows)]
                 (if (zero? (.-length ids))
                   0
                   (do (await (.begin sql (fn ^:async cleanup-tx [^js tx]
                                            (doseq [text sql/delete-legacy-openai-texts]
                                              (await (.unsafe tx text #js [ids]))))))
                       (.-length ids)))))

             upsert-account (fn ^:async upsert-account* [^js account]
               (await (upsert-provider (.-providerId account) (.-authType account)))
               (await (run-id "INSERT_ACCOUNT" (sql/account-insert-params (u/shallow account))))
               js/undefined)

             all-accounts
             (fn ^:async all-accounts []
               (let [providers (await (providers-map))
                     rows (await (run-id "SELECT_ALL_ACCOUNTS" []))
                     result (js/Map.)]
                 (doseq [^js row (array-seq rows)]
                   (let [accounts (or (.get result (.-provider_id row)) #js [])
                         ^js p (.get providers (.-provider_id row))
                         auth-type (if p (.-authType p) "api_key")]
                     (.push accounts (credential-of row auth-type))
                     (.set result (.-provider_id row) accounts)))
                 result))]
       #js {"init"
            (fn ^:async init []
              (await (db-schema/run-migrations-js sql))
              (let [tenant-id (normalize-tenant (let [d (when options (.-defaultTenantId options))]
                                                  (if (nil? d) default-tenant-id d)))]
                (await (run-id "UPSERT_TENANT" [tenant-id tenant-id "active"])))
              (reset! initialized true)
              js/undefined)

            "getStatus"
            (fn ^:async get-status []
              (let [tenants (await (run-id "SELECT_ALL_TENANTS" []))
                    providers (await (run-id "SELECT_ALL_PROVIDERS" []))
                    accounts (await (run-id "SELECT_ALL_ACCOUNTS" []))]
                #js {"initialized" @initialized "tenantCount" (.-length tenants)
                     "providerCount" (.-length providers) "totalAccountCount" (.-length accounts)}))

            "listTenants"
            (fn ^:async list-tenants []
              (.map (await (run-id "SELECT_ALL_TENANTS" []))
                    (fn [^js row] #js {"id" (.-id row) "name" (.-name row) "status" (.-status row)})))

            "upsertUser"
            (fn ^:async upsert-user [input]
              (let [params (guarded #(views/user-upsert-params-js (fn [] (.randomUUID crypto)) input))
                    row (first-row (await (run-id "UPSERT_USER" params)))]
                (when-not row (throw (js/Error. "failed to upsert user")))
                (views/user-view-js row)))

            "getUserBySubject" get-user-by-subject

            "listUserMemberships" list-user-memberships

            "ensureTenantMembership" ensure-tenant-membership

            "ensureDefaultTenantBootstrapMembership"
            (fn ^:async bootstrap [user-id]
              (let [existing (await (list-user-memberships user-id))
                    has-default (.some existing (fn [^js m] (= (.-tenantId m) default-tenant-id)))
                    rows (if has-default #js [] (await (run-id "COUNT_TENANT_MEMBERSHIPS_FOR_TENANT" [default-tenant-id])))
                    ^js plan (views/bootstrap-role-js existing default-tenant-id (or (first-row rows) #js {}))
                    role (.-role plan)]
                (when (.-create plan) (await (ensure-tenant-membership user-id default-tenant-id role)))
                role))

            "resolveUiSession"
            (fn ^:async resolve-ui-session [subject active-tenant-id]
              (let [user (await (get-user-by-subject subject))
                    memberships (if (undefined? user) #js [] (await (list-user-memberships (.-id ^js user))))]
                (if (zero? (.-length memberships))
                  js/undefined
                  (let [active (when (and (string? active-tenant-id) (pos? (.-length (.trim active-tenant-id))))
                                 (normalize-tenant active-tenant-id))
                        session (views/resolve-ui-session-js user memberships active default-tenant-id)]
                    (if (nil? session) js/undefined session)))))

            "resolveTenantApiKey"
            (fn ^:async resolve-tenant-api-key [token pepper]
              (let [token-hash (tenant-key/hash-tenant-api-key-js token pepper)
                    row (first-row (await (run-id "SELECT_ACTIVE_TENANT_API_KEY_BY_HASH" [token-hash])))]
                (if row (views/tenant-api-key-match-js row) js/undefined)))

            "listTenantApiKeys"
            (fn ^:async list-tenant-api-keys [tenant-id]
              (let [t (normalize-tenant tenant-id)]
                (.map (await (run-id "SELECT_TENANT_API_KEYS_BY_TENANT" [t]))
                      (fn [row] (views/tenant-api-key-view-js row)))))

            "createTenantApiKey"
            (fn ^:async create-tenant-api-key [tenant-id label scopes pepper]
              (let [t (normalize-tenant tenant-id)
                    label' (guarded #(views/normalized-api-key-label-js label))
                    token (tenant-key/generate-tenant-api-key-js)
                    id (.randomUUID crypto)
                    prefix (tenant-key/build-tenant-api-key-prefix-js token)
                    token-hash (tenant-key/hash-tenant-api-key-js token pepper)
                    stored-scopes (views/api-key-scopes-js scopes)]
                (await (run-id "INSERT_TENANT_API_KEY" [id t label' prefix token-hash (js/JSON.stringify stored-scopes)]))
                #js {"id" id "tenantId" t "label" label' "prefix" prefix "token" token "scopes" stored-scopes}))

            "revokeTenantApiKey"
            (fn ^:async revoke-tenant-api-key [tenant-id key-id]
              (let [t (normalize-tenant tenant-id)
                    rows (await (run (str (statement "REVOKE_TENANT_API_KEY") " RETURNING id") [t key-id]))]
                (pos? (.-length rows))))

            "touchTenantApiKeyLastUsed"
            (fn ^:async touch [tenant-id key-id]
              (let [t (normalize-tenant tenant-id)]
                (await (run-id "TOUCH_TENANT_API_KEY_LAST_USED" [t key-id]))
                js/undefined))

            "listProviders"
            (fn ^:async list-providers [reveal-secrets]
              (let [provider-rows (await (run-id "SELECT_ALL_PROVIDERS" []))
                    account-rows (await (run-id "SELECT_ALL_ACCOUNTS" []))
                    views' (views/credential-provider-views-js provider-rows account-rows reveal-secrets
                                                               identity/derive-oauth-metadata-from-token-js)]
                (.sort views' (fn [^js l ^js r] (.localeCompare (.-id l) (.-id r))))))

            "getAllProviders" (fn [] (providers-map))

            "getAccountsByProvider"
            (fn ^:async get-accounts-by-provider [provider-id]
              (let [rows (await (run-id "SELECT_ACCOUNTS_BY_PROVIDER" [provider-id]))
                    providers (await (providers-map))
                    auth-type (let [^js p (.get providers provider-id)] (if p (.-authType p) "api_key"))]
                (.map rows (fn [row] (credential-of row auth-type)))))

            "getAllAccounts" all-accounts

            "cleanupLegacyOpenAiDuplicates" cleanup-legacy-openai-duplicates

            "upsertProvider" upsert-provider

            "upsertProviderWithBaseUrl"
            (fn ^:async upsert-provider-with-base-url [provider-id auth-type base-url]
              (await (run-id "UPSERT_PROVIDER_WITH_BASE_URL" [provider-id auth-type base-url]))
              js/undefined)

            "getProviderById"
            (fn ^:async get-provider-by-id [provider-id]
              (let [row (first-row (await (run-id "SELECT_PROVIDER_BY_ID" [provider-id])))]
                (if row (clj->js (sql/provider-by-id (u/shallow row))) nil)))

            "listProvidersWithBaseUrlByPrefix"
            (fn ^:async list-providers-by-prefix [prefix]
              (.map (await (run sql/providers-by-prefix-text [(str prefix "%")]))
                    (fn [row] (clj->js (sql/provider-with-base-url (u/shallow row))))))

            "upsertAccount" upsert-account

            "upsertApiKeyAccount"
            (fn [provider-id account-id api-key]
              (upsert-account #js {"providerId" provider-id "accountId" account-id "token" api-key "authType" "api_key"}))

            "upsertOAuthAccount"
            (fn ^:async upsert-oauth-account [provider-id account-id access-token refresh-token expires-at
                                              chatgpt-account-id _email _subject plan-type]
              (await (upsert-account #js {"providerId" provider-id "accountId" account-id "token" access-token
                                          "authType" "oauth_bearer" "refreshToken" refresh-token "expiresAt" expires-at
                                          "chatgptAccountId" chatgpt-account-id "planType" plan-type}))
              (when (and (= provider-id "openai") (u/truthy? chatgpt-account-id))
                (await (cleanup-legacy-openai-duplicates chatgpt-account-id)))
              js/undefined)

            "upsertAccounts"
            (fn ^:async upsert-accounts [accounts]
              (doseq [account (array-seq accounts)] (await (upsert-account account)))
              js/undefined)

            "deleteAccount"
            (fn ^:async delete-account [provider-id account-id]
              (await (run-id "DELETE_ACCOUNT" [account-id provider-id]))
              js/undefined)

            "removeAccount"
            (fn ^:async remove-account [provider-id account-id]
              (let [deleted (await (.begin sql (fn ^:async remove-tx [^js tx]
                                                 (let [deleted (await (.unsafe tx sql/delete-account-returning-text #js [account-id provider-id]))]
                                                   (await (.unsafe tx sql/delete-cooldown-text #js [provider-id account-id]))
                                                   (await (.unsafe tx sql/delete-health-text #js [provider-id account-id]))
                                                   deleted))))]
                ;; Only mutate in-memory state after the transaction commits.
                (swap! cooldowns dissoc (sql/cooldown-key provider-id account-id))
                (pos? (.-length deleted))))

            "setCooldown" (fn [provider-id account-id until]
                            (swap! cooldowns assoc (sql/cooldown-key provider-id account-id) until)
                            js/undefined)

            "getCooldown" (fn [provider-id account-id]
                            (let [v (get @cooldowns (sql/cooldown-key provider-id account-id))] (if (nil? v) js/undefined v)))

            "persistCooldown"
            (fn ^:async persist-cooldown [provider-id account-id until]
              (await (run-id "SET_COOLDOWN" [provider-id account-id until]))
              (swap! cooldowns assoc (sql/cooldown-key provider-id account-id) until)
              js/undefined)

            "clearCooldown"
            (fn ^:async clear-cooldown [provider-id account-id]
              (await (run sql/delete-cooldown-text [provider-id account-id]))
              (swap! cooldowns dissoc (sql/cooldown-key provider-id account-id))
              js/undefined)

            "loadCooldowns"
            (fn ^:async load-cooldowns []
              (let [now (js/Date.now)
                    _ (await (run-id "CLEAR_EXPIRED_COOLDOWNS" [now]))
                    rows (await (run-id "SELECT_ALL_ACTIVE_COOLDOWNS" [now]))
                    entries (views/cooldown-entries-js rows)
                    result (js/Map.)]
                (reset! cooldowns {})
                (doseq [entry (array-seq entries)]
                  (let [[provider-id account-id until] (array-seq entry)]
                    (.set result (sql/cooldown-pair-key provider-id account-id) until)
                    (swap! cooldowns assoc (sql/cooldown-key provider-id account-id) until)))
                result))

            "loadDisabledAccounts"
            (fn ^:async load-disabled-accounts []
              (let [rows (await (run-id "SELECT_ALL_DISABLED_ACCOUNTS" []))
                    result (js/Set.)]
                (doseq [^js row (array-seq rows)]
                  (.add result (sql/cooldown-pair-key (.-provider_id row) (.-id row))))
                result))

            "setAccountDisabled"
            (fn ^:async set-account-disabled [provider-id account-id disabled]
              (await (run-id "SET_ACCOUNT_DISABLED" [account-id provider-id disabled]))
              js/undefined)

            "loadAccountsIntoKeyPool"
            (fn ^:async load-accounts-into-key-pool [^js key-pool _default-provider-id]
              (let [by-provider (await (all-accounts))]
                (.forEach by-provider
                          (fn [accounts provider-id]
                            (.forEach accounts (fn [account] (.updateAccountCredential key-pool provider-id account account)))))
                js/undefined))})))
