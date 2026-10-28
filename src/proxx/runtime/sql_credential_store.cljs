(ns proxx.runtime.sql-credential-store
  "The Postgres credential store: providers, accounts, cooldowns, tenants, users,
  memberships and tenant API keys (formerly SqlCredentialStore). Row mapping and
  the decisions are proxx.credentials.sql (via proxx.runtime.sql); the statements
  are the persisted contract of resources/db/schema.edn plus the inline texts
  below, kept byte-for-byte. Cooldowns mirrored in memory live in one atom."
  (:require ["node:crypto" :as crypto]
            [proxx.jsval :as j]
            [proxx.runtime.account-identity :as identity]
            [proxx.runtime.db-schema :as schema]
            [proxx.runtime.sql :as rows]
            [proxx.runtime.tenant-key :as tk]))

(def ^:private stmt schema/sql-statement-js)

(defn- k [provider-id account-id] (str provider-id ":" account-id))

(defn create-sql-credential-store-js
  "A store over postgres.js handle `sql`; `options` {defaultTenantId?}."
  [^js sql ^js options]
  (let [state (atom {:initialized false :cooldowns {}})
        default-id (.-defaultTenantId (tk/tenant-api-key-constants-js))
        configured-default (let [v (when options (.-defaultTenantId options))] (if (nil? v) default-id v))
        unsafe (fn [text params] (if (nil? params) (.unsafe sql text) (.unsafe sql text params)))
        first-row (fn [rs] (aget rs 0))
        list-memberships (fn ^:async list-memberships [user-id]
                           (let [rs (await (unsafe (stmt "SELECT_TENANT_MEMBERSHIPS_BY_USER") #js [user-id]))]
                             (.map rs (fn [row] (rows/membership-view-js row)))))
        get-user (fn ^:async get-user [subject]
                   (let [s (.toLowerCase (.trim subject))]
                     (if (zero? (.-length s))
                       js/undefined
                       (let [row (first-row (await (unsafe (stmt "SELECT_USER_BY_SUBJECT") #js [s])))]
                         (if row (rows/user-view-js row) js/undefined)))))
        ensure-membership (fn ^:async ensure-membership [user-id tenant-id role]
                            (await (unsafe (stmt "UPSERT_TENANT_MEMBERSHIP") #js [(tk/normalize-tenant-id-js tenant-id) user-id role]))
                            js/undefined)
        all-providers (fn ^:async all-providers []
                        (let [rs (await (unsafe (stmt "SELECT_ALL_PROVIDERS") nil))
                              m (js/Map.)]
                          (doseq [^js row (array-seq rs)]
                            (.set m (.-id row) #js {"authType" (rows/normalize-auth-type-js (.-auth_type row))}))
                          m))
        cleanup-legacy (fn ^:async cleanup-legacy [chatgpt-account-id]
                         (let [rs (if (j/truthy? chatgpt-account-id)
                                    (await (unsafe (.replace (stmt "SELECT_ACCOUNTS_BY_PROVIDER") "ORDER BY id;" "AND chatgpt_account_id = $2 ORDER BY id;")
                                                   #js ["openai" chatgpt-account-id]))
                                    (await (unsafe (stmt "SELECT_ACCOUNTS_BY_PROVIDER") #js ["openai"])))
                               ids (rows/legacy-openai-duplicate-ids-js rs)]
                           (if (zero? (.-length ids))
                             0
                             (do
                               (await (.begin sql (fn ^:async tx-body [^js tx]
                                                    (await (.unsafe tx "DELETE FROM account_cooldown WHERE provider_id = 'openai' AND account_id = ANY($1::text[])" #js [ids]))
                                                    (await (.unsafe tx "DELETE FROM account_health WHERE provider_id = 'openai' AND account_id = ANY($1::text[])" #js [ids]))
                                                    (await (.unsafe tx "DELETE FROM accounts WHERE provider_id = 'openai' AND id = ANY($1::text[])" #js [ids])))))
                               (.-length ids)))))
        upsert-provider (fn ^:async upsert-provider [provider-id auth-type]
                          (await (unsafe (stmt "UPSERT_PROVIDER") #js [provider-id auth-type nil])) js/undefined)
        upsert-account (fn ^:async upsert-account [^js account]
                         (await (upsert-provider (.-providerId account) (.-authType account)))
                         (await (unsafe (stmt "INSERT_ACCOUNT")
                                        #js [(.-accountId account) (.-providerId account) (.-token account)
                                             (if (nil? (.-refreshToken account)) nil (.-refreshToken account))
                                             (if (nil? (.-expiresAt account)) nil (.-expiresAt account))
                                             (if (nil? (.-chatgptAccountId account)) nil (.-chatgptAccountId account))
                                             (if (nil? (.-planType account)) nil (.-planType account))]))
                         js/undefined)
        get-all-accounts (fn ^:async get-all-accounts []
                           (let [providers (await (all-providers))
                                 rs (await (unsafe (stmt "SELECT_ALL_ACCOUNTS") nil))
                                 result (js/Map.)]
                             (doseq [^js row (array-seq rs)]
                               (let [accounts (or (.get result (.-provider_id row)) #js [])
                                     auth-type (if-let [^js p (.get providers (.-provider_id row))] (.-authType p) "api_key")]
                                 (.push accounts (rows/provider-credential-js row auth-type))
                                 (.set result (.-provider_id row) accounts)))
                             result))]
    #js {:init (fn ^:async init []
                 (await (schema/run-migrations-js sql))
                 (let [tenant (tk/normalize-tenant-id-js configured-default)]
                   (await (unsafe (stmt "UPSERT_TENANT") #js [tenant tenant "active"])))
                 (swap! state assoc :initialized true)
                 js/undefined)
         :getStatus (fn ^:async get-status []
                      (let [tenants (await (unsafe (stmt "SELECT_ALL_TENANTS") nil))
                            providers (await (unsafe (stmt "SELECT_ALL_PROVIDERS") nil))
                            accounts (await (unsafe (stmt "SELECT_ALL_ACCOUNTS") nil))]
                        #js {"initialized" (:initialized @state) "tenantCount" (.-length tenants)
                             "providerCount" (.-length providers) "totalAccountCount" (.-length accounts)}))
         :listTenants (fn ^:async list-tenants []
                        (let [rs (await (unsafe (stmt "SELECT_ALL_TENANTS") nil))]
                          (.map rs (fn [^js row] #js {"id" (.-id row) "name" (.-name row) "status" (.-status row)}))))
         :upsertUser (fn ^:async upsert-user [input]
                       (let [params (rows/user-upsert-params-js (fn [] (.randomUUID crypto)) input)
                             row (first-row (await (unsafe (stmt "UPSERT_USER") params)))]
                         (when-not row (throw (js/Error. "failed to upsert user")))
                         (rows/user-view-js row)))
         :getUserBySubject get-user
         :listUserMemberships list-memberships
         :ensureTenantMembership ensure-membership
         :ensureDefaultTenantBootstrapMembership
         (fn ^:async bootstrap [user-id]
           (let [existing (await (list-memberships user-id))
                 has-default (.some existing (fn [^js m] (= (.-tenantId m) default-id)))
                 rs (if has-default
                      #js []
                      (await (unsafe (stmt "COUNT_TENANT_MEMBERSHIPS_FOR_TENANT") #js [default-id])))
                 ^js plan (rows/bootstrap-role-js existing default-id (or (aget rs 0) #js {}))]
             (when (.-create plan) (await (ensure-membership user-id default-id (.-role plan))))
             (.-role plan)))
         :resolveUiSession
         (fn ^:async resolve-ui-session [subject active-tenant-id]
           (let [user (await (get-user subject))]
             (if (undefined? user)
               js/undefined
               (let [memberships (await (list-memberships (.-id ^js user)))]
                 (if (zero? (.-length memberships))
                   js/undefined
                   (let [normalized (when (and (string? active-tenant-id) (pos? (.-length (.trim active-tenant-id))))
                                      (tk/normalize-tenant-id-js active-tenant-id))
                         resolved (rows/resolve-ui-session-js user memberships normalized default-id)]
                     (if (nil? resolved) js/undefined resolved)))))))
         :resolveTenantApiKey
         (fn ^:async resolve-key [token pepper]
           (let [h (tk/hash-tenant-api-key-js token pepper)
                 row (first-row (await (unsafe (stmt "SELECT_ACTIVE_TENANT_API_KEY_BY_HASH") #js [h])))]
             (if row (rows/tenant-api-key-match-js row) js/undefined)))
         :listTenantApiKeys
         (fn ^:async list-keys [tenant-id]
           (let [rs (await (unsafe (stmt "SELECT_TENANT_API_KEYS_BY_TENANT") #js [(tk/normalize-tenant-id-js tenant-id)]))]
             (.map rs (fn [row] (rows/tenant-api-key-view-js row)))))
         :createTenantApiKey
         (fn ^:async create-key [tenant-id label scopes pepper]
           (let [tenant (tk/normalize-tenant-id-js tenant-id)
                 label* (rows/normalized-api-key-label-js label)
                 token (tk/generate-tenant-api-key-js)
                 id (.randomUUID crypto)
                 prefix (tk/build-tenant-api-key-prefix-js token)
                 h (tk/hash-tenant-api-key-js token pepper)
                 stored (rows/api-key-scopes-js scopes)]
             (await (unsafe (stmt "INSERT_TENANT_API_KEY") #js [id tenant label* prefix h (js/JSON.stringify stored)]))
             #js {"id" id "tenantId" tenant "label" label* "prefix" prefix "token" token "scopes" stored}))
         :revokeTenantApiKey
         (fn ^:async revoke-key [tenant-id key-id]
           (let [rs (await (unsafe (str (stmt "REVOKE_TENANT_API_KEY") " RETURNING id") #js [(tk/normalize-tenant-id-js tenant-id) key-id]))]
             (pos? (.-length rs))))
         :touchTenantApiKeyLastUsed
         (fn ^:async touch-key [tenant-id key-id]
           (await (unsafe (stmt "TOUCH_TENANT_API_KEY_LAST_USED") #js [(tk/normalize-tenant-id-js tenant-id) key-id]))
           js/undefined)
         :listProviders
         (fn ^:async list-providers [reveal-secrets]
           (let [provider-rows (await (unsafe (stmt "SELECT_ALL_PROVIDERS") nil))
                 account-rows (await (unsafe (stmt "SELECT_ALL_ACCOUNTS") nil))
                 views (rows/credential-provider-views-js provider-rows account-rows reveal-secrets
                                                          identity/derive-oauth-metadata-from-token-js)]
             (.sort views (fn [^js l ^js r] (.localeCompare (.-id l) (.-id r))))))
         :getAllProviders all-providers
         :getAccountsByProvider
         (fn ^:async get-accounts-by-provider [provider-id]
           (let [rs (await (unsafe (stmt "SELECT_ACCOUNTS_BY_PROVIDER") #js [provider-id]))
                 providers (await (all-providers))
                 auth-type (if-let [^js p (.get providers provider-id)] (.-authType p) "api_key")]
             (.map rs (fn [row] (rows/provider-credential-js row auth-type)))))
         :getAllAccounts get-all-accounts
         :cleanupLegacyOpenAiDuplicates cleanup-legacy
         :upsertProvider upsert-provider
         :upsertProviderWithBaseUrl
         (fn ^:async upsert-provider-url [provider-id auth-type base-url]
           (await (unsafe (stmt "UPSERT_PROVIDER_WITH_BASE_URL") #js [provider-id auth-type base-url])) js/undefined)
         :getProviderById
         (fn ^:async get-provider [provider-id]
           (let [rs (await (unsafe (stmt "SELECT_PROVIDER_BY_ID") #js [provider-id]))]
             (if (zero? (.-length rs))
               nil
               (let [^js row (aget rs 0)]
                 #js {"id" (.-id row) "authType" (rows/normalize-auth-type-js (.-auth_type row)) "baseUrl" (.-base_url row)}))))
         :listProvidersWithBaseUrlByPrefix
         (fn ^:async list-by-prefix [prefix]
           (let [rs (await (unsafe "SELECT id, auth_type, base_url FROM providers WHERE id LIKE $1 AND base_url IS NOT NULL AND base_url != ''"
                                   #js [(str prefix "%")]))]
             (.map rs (fn [^js row] #js {"id" (.-id row) "baseUrl" (.-base_url row)}))))
         :upsertAccount upsert-account
         :upsertApiKeyAccount
         (fn [provider-id account-id api-key]
           (upsert-account #js {"providerId" provider-id "accountId" account-id "token" api-key "authType" "api_key"}))
         :upsertOAuthAccount
         (fn ^:async upsert-oauth [provider-id account-id access-token refresh-token expires-at chatgpt-account-id _email _subject plan-type]
           (await (upsert-account #js {"providerId" provider-id "accountId" account-id "token" access-token "authType" "oauth_bearer"
                                       "refreshToken" refresh-token "expiresAt" expires-at
                                       "chatgptAccountId" chatgpt-account-id "planType" plan-type}))
           (when (and (= provider-id "openai") (j/truthy? chatgpt-account-id))
             (await (cleanup-legacy chatgpt-account-id)))
           js/undefined)
         :upsertAccounts (fn ^:async upsert-accounts [accounts]
                           (doseq [a (array-seq accounts)] (await (upsert-account a)))
                           js/undefined)
         :deleteAccount (fn ^:async delete-account [provider-id account-id]
                          (await (unsafe (stmt "DELETE_ACCOUNT") #js [account-id provider-id])) js/undefined)
         :removeAccount
         (fn ^:async remove-account [provider-id account-id]
           (let [deleted (await (.begin sql (fn ^:async tx-body [^js tx]
                                              (let [d (await (.unsafe tx "DELETE FROM accounts WHERE id = $1 AND provider_id = $2 RETURNING id" #js [account-id provider-id]))]
                                                (await (.unsafe tx "DELETE FROM account_cooldown WHERE provider_id = $1 AND account_id = $2" #js [provider-id account-id]))
                                                (await (.unsafe tx "DELETE FROM account_health WHERE provider_id = $1 AND account_id = $2" #js [provider-id account-id]))
                                                d))))]
             (swap! state update :cooldowns dissoc (k provider-id account-id))
             (pos? (.-length deleted))))
         :setCooldown (fn [provider-id account-id until]
                        (swap! state update :cooldowns assoc (k provider-id account-id) until) js/undefined)
         :getCooldown (fn [provider-id account-id]
                        (let [v (get-in @state [:cooldowns (k provider-id account-id)])] (if (nil? v) js/undefined v)))
         :persistCooldown (fn ^:async persist-cooldown [provider-id account-id until]
                            (await (unsafe (stmt "SET_COOLDOWN") #js [provider-id account-id until]))
                            (swap! state update :cooldowns assoc (k provider-id account-id) until)
                            js/undefined)
         :clearCooldown (fn ^:async clear-cooldown [provider-id account-id]
                          (await (unsafe "DELETE FROM account_cooldown WHERE provider_id = $1 AND account_id = $2" #js [provider-id account-id]))
                          (swap! state update :cooldowns dissoc (k provider-id account-id))
                          js/undefined)
         :loadCooldowns
         (fn ^:async load-cooldowns []
           (let [now (js/Date.now)
                 _ (await (unsafe (stmt "CLEAR_EXPIRED_COOLDOWNS") #js [now]))
                 rs (await (unsafe (stmt "SELECT_ALL_ACTIVE_COOLDOWNS") #js [now]))
                 result (js/Map.)]
             (swap! state assoc :cooldowns {})
             (doseq [^js entry (array-seq (rows/cooldown-entries-js rs))]
               (let [p (aget entry 0) a (aget entry 1) until (aget entry 2)]
                 (.set result (str p "\u0000" a) until)
                 (swap! state update :cooldowns assoc (k p a) until)))
             result))
         :loadDisabledAccounts
         (fn ^:async load-disabled []
           (let [rs (await (unsafe (stmt "SELECT_ALL_DISABLED_ACCOUNTS") nil))
                 result (js/Set.)]
             (doseq [^js row (array-seq rs)] (.add result (str (.-provider_id row) "\u0000" (.-id row))))
             result))
         :setAccountDisabled (fn ^:async set-disabled [provider-id account-id disabled]
                               (await (unsafe (stmt "SET_ACCOUNT_DISABLED") #js [account-id provider-id disabled])) js/undefined)
         :loadAccountsIntoKeyPool
         (fn ^:async load-into-pool [^js key-pool default-provider-id]
           (let [by-provider (await (get-all-accounts))]
             (doseq [[provider-id accounts] (array-seq (js/Array.from (.entries by-provider)))]
               (doseq [a (array-seq accounts)] (.updateAccountCredential key-pool provider-id a a)))
             (when-not (.has by-provider default-provider-id) (.set by-provider default-provider-id #js []))
             js/undefined))}))
