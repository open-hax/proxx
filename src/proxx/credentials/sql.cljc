(ns proxx.credentials.sql
  "Row <-> domain mapping and parameter construction for the SQL credential
  store. Rows arrive as string-keyed data (snake_case columns); domain values
  leave as string-keyed camelCase data ready for the host (`null` for SQL
  NULL where the legacy view type said `| null`, omitted where it said
  `undefined`). Executing SQL stays in TypeScript: the statement texts are
  persisted contracts living in `src/lib/db/schema.ts`."
  (:require [clojure.string :as str]
            [proxx.credentials.store :as store]
            [proxx.epoch :as epoch]
            [proxx.oauth.flow :as flow]))

(defn- assoc-some [m k v] (if (some? v) (assoc m k v) m))

(defn normalize-auth-type
  "Provider rows: only the oauth spellings are special, everything else is an API key."
  [raw]
  (case (str/lower-case (str/trim raw))
    ("oauth" "oauth_bearer" "oauth-bearer") "oauth_bearer"
    "api_key"))

(defn provider-credential
  "A key-pool credential for an account row."
  [row auth-type]
  (-> {"providerId" (get row "provider_id") "accountId" (get row "id") "token" (get row "token") "authType" auth-type}
      (assoc-some "refreshToken" (get row "refresh_token"))
      (assoc-some "expiresAt" (epoch/normalize-epoch-ms (get row "expires_at")))
      (assoc-some "chatgptAccountId" (get row "chatgpt_account_id"))
      (assoc-some "planType" (get row "plan_type"))))

;; ---------------------------------------------------------------------------
;; Legacy OpenAI duplicate accounts
;; ---------------------------------------------------------------------------

(defn- hex-suffix? [s n]
  (boolean (and (= n (count s)) (re-matches #"[0-9a-f]+" s))))

(defn- suffix-after [account-id chatgpt-account-id separator]
  (let [prefix (str chatgpt-account-id separator)]
    (when (str/starts-with? account-id prefix) (subs account-id (count prefix)))))

(defn legacy-openai-account-id?
  "`<chatgpt id>_<8 hex>`."
  [account-id chatgpt-account-id]
  (some-> (suffix-after account-id chatgpt-account-id "_") (hex-suffix? 8)))

(defn current-openai-account-id?
  "`<chatgpt id>-<12 hex>` (what `proxx.oauth.openai/storage-account-id` writes)."
  [account-id chatgpt-account-id]
  (some-> (suffix-after account-id chatgpt-account-id "-") (hex-suffix? 12)))

(defn legacy-openai-duplicate-ids
  "Ids of legacy-format OpenAI accounts that have a current-format sibling for
  the same ChatGPT account (safe to delete), grouped by first appearance."
  [rows]
  (let [groups (reduce (fn [acc row]
                         (let [chatgpt (get row "chatgpt_account_id")]
                           (if (and (= "openai" (get row "provider_id")) (seq chatgpt))
                             (-> acc
                                 (update :order #(if (contains? (:by-id acc) chatgpt) % (conj % chatgpt)))
                                 (update-in [:by-id chatgpt] (fnil conj []) row))
                             acc)))
                       {:order [] :by-id {}} rows)]
    (vec (for [chatgpt (:order groups)
               :let [accounts (get-in groups [:by-id chatgpt])]
               :when (some #(current-openai-account-id? (get % "id") chatgpt) accounts)
               account accounts
               :when (legacy-openai-account-id? (get account "id") chatgpt)]
           (get account "id")))))

;; ---------------------------------------------------------------------------
;; Users, memberships, sessions
;; ---------------------------------------------------------------------------

(defn parse-scopes
  "Scopes from a text[] value, a JSON string, or anything else (-> [])."
  [value parse-json]
  (letfn [(strings [xs] (vec (filter string? xs)))]
    (cond
      (sequential? value) (strings value)
      (string? value) (let [parsed (parse-json value)] (if (sequential? parsed) (strings parsed) []))
      :else [])))

(defn normalize-membership-role [value]
  (let [normalized (str/lower-case (str/trim value))]
    (if (#{"owner" "admin" "member" "viewer"} normalized) normalized "viewer")))

(defn user-view [row]
  {"id" (get row "id") "provider" (get row "provider") "subject" (get row "subject") "login" (get row "login")
   "email" (get row "email") "name" (get row "name") "avatarUrl" (get row "avatar_url")})

(defn membership-view [row]
  {"tenantId" (get row "tenant_id") "tenantName" (get row "tenant_name") "tenantStatus" (get row "tenant_status")
   "role" (normalize-membership-role (get row "role"))})

(defn- blank->nil [x] (when (string? x) (let [t (str/trim x)] (when (seq t) t))))

(defn user-upsert-params
  "Parameters of UPSERT_USER; a blank subject is an error. `new-uuid` is a
  thunk, called only for a valid subject."
  [new-uuid {:strs [provider subject login email name avatarUrl]}]
  (let [subject (str/lower-case (str/trim subject))]
    (when (empty? subject)
      (throw (ex-info "user subject must not be empty" {:error/type :credentials/empty-subject})))
    [(new-uuid) (str/lower-case (str/trim provider)) subject (blank->nil login) (blank->nil email) (blank->nil name) (blank->nil avatarUrl)]))

(defn resolve-ui-session
  "The session for `user` given its membership views: the requested tenant,
  else the default tenant, else the first membership. `active-tenant-id` is
  already normalized (or nil)."
  [user memberships active-tenant-id default-tenant-id]
  (when (seq memberships)
    (let [find-tenant (fn [id] (when id (first (filter #(= id (get % "tenantId")) memberships))))
          active (or (find-tenant active-tenant-id) (find-tenant default-tenant-id) (first memberships))]
      {"userId" (get user "id") "subject" (get user "subject") "activeTenantId" (get active "tenantId")
       "role" (get active "role") "memberships" memberships})))

(defn bootstrap-role
  "The first member of the default tenant is its owner."
  [existing-memberships default-tenant-id count-row]
  (if-let [existing (first (filter #(= default-tenant-id (get % "tenantId")) existing-memberships))]
    {:role (get existing "role") :create? false}
    (let [raw (get count-row "count")
          n (cond (number? raw) raw (some? raw) (flow/parse-int raw) :else 0)]
      {:role (if (and (flow/finite-number? n) (zero? n)) "owner" "admin") :create? true})))

;; ---------------------------------------------------------------------------
;; Tenant API keys
;; ---------------------------------------------------------------------------

(def default-api-key-scopes ["proxy:use"])

(defn api-key-scopes
  "Non-blank string scopes, or the default scope."
  [scopes]
  (let [kept (vec (filter #(and (string? %) (seq (str/trim %))) scopes))]
    (if (seq kept) kept default-api-key-scopes)))

(defn normalized-label [label]
  (let [t (str/trim label)]
    (when (empty? t)
      (throw (ex-info "tenant api key label must not be empty" {:error/type :credentials/empty-label})))
    t))

(defn tenant-api-key-view [row parse-json]
  {"id" (get row "id") "tenantId" (get row "tenant_id") "label" (get row "label") "prefix" (get row "prefix")
   "scopes" (parse-scopes (get row "scopes") parse-json)
   "createdAt" (get row "created_at") "lastUsedAt" (get row "last_used_at") "revokedAt" (get row "revoked_at")})

(defn tenant-api-key-match [row parse-json]
  {"id" (get row "id") "tenantId" (get row "tenant_id") "label" (get row "label") "prefix" (get row "prefix")
   "scopes" (parse-scopes (get row "scopes") parse-json)})

;; ---------------------------------------------------------------------------
;; Provider listing and runtime state
;; ---------------------------------------------------------------------------

(defn credential-provider-views
  "The admin listing: providers sorted by the caller, each with its accounts.
  `derive-metadata` maps an OAuth token to {:chatgpt-account-id :email :subject :plan-type}."
  [provider-rows account-rows reveal-secrets? derive-metadata]
  (let [auth-by-provider (into {} (map (fn [r] [(get r "id") (normalize-auth-type (get r "auth_type"))])) provider-rows)
        views (reduce
               (fn [acc row]
                 (let [auth-type (get auth-by-provider (get row "provider_id") "api_key")
                       derived (if (= auth-type "oauth_bearer") (derive-metadata (get row "token")) {})
                       chatgpt (if (some? (get row "chatgpt_account_id")) (get row "chatgpt_account_id") (:chatgpt-account-id derived))
                       email (:email derived)
                       subject (:subject derived)
                       plan (if (some? (get row "plan_type")) (get row "plan_type") (:plan-type derived))
                       token (get row "token")
                       refresh (get row "refresh_token")
                       expires (epoch/normalize-epoch-ms (get row "expires_at"))
                       view (-> {"id" (get row "id") "authType" auth-type
                                 "displayName" (store/display-name {:id (get row "id") :email email :chatgpt-account-id chatgpt})
                                 "secretPreview" (store/mask-secret token)}
                                (cond-> reveal-secrets? (assoc "secret" token))
                                (cond-> (seq refresh) (assoc "refreshTokenPreview" (store/mask-secret refresh)))
                                (cond-> (and reveal-secrets? (some? refresh)) (assoc "refreshToken" refresh))
                                (assoc-some "expiresAt" expires)
                                (assoc-some "chatgptAccountId" chatgpt)
                                (assoc-some "email" email)
                                (assoc-some "subject" subject)
                                (assoc-some "planType" plan))]
                   (update acc (get row "provider_id") (fnil conj []) view)))
               {} account-rows)]
    (mapv (fn [r] (let [accounts (get views (get r "id") [])]
                    {"id" (get r "id") "authType" (normalize-auth-type (get r "auth_type"))
                     "accountCount" (count accounts) "accounts" accounts}))
          provider-rows)))

(defn cooldown-entries
  "[[provider-id account-id until-ms] ...] for rows whose cooldown parses to a finite number."
  [rows]
  (vec (keep (fn [row]
               (let [raw (get row "cooldown_until")
                     until (if (number? raw) raw (flow/parse-int raw))]
                 (when (flow/finite-number? until)
                   [(get row "provider_id") (get row "account_id") until])))
             rows)))
