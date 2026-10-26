(ns proxx.http.federation
  "Decisions for the federation control-plane routes (/federation/*): request
  body validation, which bridge sessions a caller sees, which remote accounts a
  lease import fetches, how usage entries from peers are sanitized, which
  projected accounts an import-all pulls and how the known-account view merges
  local and projected accounts. Stores, the relay and peer HTTP are the edge's.

  Request bodies and store records arrive as string-keyed data (see
  proxx.http.params for the JavaScript coercions kept on purpose)."
  (:require [clojure.string :as str]
            [proxx.http.guard :as guard]
            [proxx.http.ui-auth :as ui-auth]))

;; ---------------------------------------------------------------------------
;; Small coercions
;; ---------------------------------------------------------------------------

(defn field
  "`body?.k` for a decoded body: nil unless the body is a map."
  [body k]
  (when (map? body) (get body k)))

(defn trimmed
  "typeof v === \"string\" ? v.trim() : \"\""
  [v]
  (if (string? v) (str/trim v) ""))

(defn trimmed-nes
  "The trimmed string when non-empty, else nil."
  [v]
  (let [t (trimmed v)] (when (seq t) t)))

(defn finite-number? [v]
  (and (number? v) #?(:cljs (js/Number.isFinite v) :clj (not (or (Double/isNaN (double v)) (Double/isInfinite (double v)))))))

(defn- floor [x] (long (Math/floor x)))

(defn authorize
  "nil when the caller manages federation, else the 401/403 response."
  [auth]
  (or (guard/require-auth {:auth auth})
      (guard/forbid-unless (ui-auth/can-manage-federation? auth))))

(defn- locale-compare [a b]
  #?(:cljs (.localeCompare (str a) (str b)) :clj (compare (str a) (str b))))

;; ---------------------------------------------------------------------------
;; Peers
;; ---------------------------------------------------------------------------

(defn peer-input
  "{:response r} for a peer body missing owner credential, label or base URL,
  else {:owner-credential :label :base-url}."
  [body]
  (let [oc (trimmed (field body "ownerCredential"))
        label (trimmed (field body "label"))
        base (trimmed (field body "baseUrl"))]
    (if (and (seq oc) (seq label) (seq base))
      {:owner-credential oc :label label :base-url base}
      {:response (guard/error 400 "owner_credential_label_and_base_url_required")})))

(defn peer-diff-payload [peer]
  {"peerDid" (get peer "peerDid") "label" (get peer "label") "baseUrl" (get peer "baseUrl")
   "controlBaseUrl" (get peer "controlBaseUrl") "authMode" (get peer "authMode") "status" (get peer "status")})

;; ---------------------------------------------------------------------------
;; Bridge sessions and lease import
;; ---------------------------------------------------------------------------

(defn visible-sessions
  "Sessions `auth` may see: all for the legacy admin, else its tenant's."
  [auth sessions]
  (if (= "legacy_admin" (get auth "kind"))
    sessions
    (filterv #(= (:tenant-id %) (get auth "tenantId")) sessions)))

(defn find-session
  "The visible session named by id, else by agent id, else nil. Each session is
  {:session-id :agent-id :tenant-id :state :js}."
  [auth sessions session-id agent-id]
  (let [visible (visible-sessions auth sessions)]
    (cond (seq session-id) (some #(when (= (:session-id %) session-id) %) visible)
          (seq agent-id) (some #(when (= (:agent-id %) agent-id) %) visible))))

(defn lease-import-request
  "Parsed lease-import body: {:provider-id :limit :refresh-buffer-ms :force-api-keys?
  :session-id :agent-id} or {:response r}."
  [body]
  (let [provider-id (trimmed (field body "providerId"))
        limit (field body "limit")
        refresh (field body "refreshBufferMs")]
    (if (empty? provider-id)
      {:response (guard/error 400 "provider_id_required")}
      {:provider-id provider-id
       :limit (when (finite-number? limit) (max 1 (min (floor limit) 5000)))
       :refresh-buffer-ms (if (finite-number? refresh) (max 0 (floor refresh)) (* 10 60000))
       :force-api-keys? (true? (field body "forceApiKeys"))
       :session-id (trimmed (field body "sessionId"))
       :agent-id (trimmed (field body "agentId"))})))

(defn lease-list-path [provider-id limit]
  (str "/api/bridge/credentials/accounts?providerId=" #?(:cljs (js/encodeURIComponent provider-id) :clj provider-id)
       (when limit (str "&limit=" limit))))

(defn lease-to-import
  "The remote accounts a lease import should fetch. `local-accounts` is
  {account-id expires-at-or-nil}: API keys are fetched when missing locally (or
  forced); OAuth leases when missing, with no known expiry, or expiring within
  the refresh buffer."
  [remote-accounts local-accounts now refresh-buffer-ms force-api-keys?]
  (filterv (fn [account]
             (let [id (get account "accountId")
                   has? (contains? local-accounts id)]
               (if (= "api_key" (get account "authType"))
                 (or force-api-keys? (not has?))
                 (let [expires (get local-accounts id)]
                   (cond (not has?) true
                         (not (finite-number? expires)) true
                         :else (<= expires (+ now refresh-buffer-ms)))))))
           remote-accounts))

(defn lease-response
  [session providerId remote-count planned imported refreshed errors]
  (cond-> {"sessionId" (:session-id session) "providerId" providerId
           "remoteAccountCount" remote-count "plannedImportCount" planned "imported" imported
           "refreshed" refreshed "skipped" (- remote-count planned) "failed" (count errors)
           "errors" (vec (take 10 errors))}
    (some? (:agent-id session)) (assoc "agentId" (:agent-id session))))

;; ---------------------------------------------------------------------------
;; Credential export / import
;; ---------------------------------------------------------------------------

(defn export-needs-refresh?
  "Should a credential be refreshed before it is leased out? An OAuth account
  with a refresh token on the OpenAI provider whose access token expires within
  a minute, when this node can refresh at all."
  [account now openai-provider-id can-refresh?]
  (let [expires (get account "expiresAt")
        refresh-token (get account "refreshToken")]
    (boolean
     (and (finite-number? expires)
          (<= expires (+ now 60000))
          (string? refresh-token) (seq (str/trim refresh-token))
          (= (str/lower-case (str/trim (get account "providerId"))) (str/lower-case (str/trim openai-provider-id)))
          can-refresh?))))

(defn projected-mobility [metadata]
  (let [raw (get metadata "credentialMobility")]
    (when (and (string? raw) (seq (str/trim raw))) (str/trim raw))))

(defn projected-allows-credential-import?
  "May the credential of this projected account be imported (as opposed to
  routed through its owner)? Explicit non-exportable flags always win; OAuth
  accounts only when leasable as access-token-only."
  [projected]
  (let [metadata (get projected "metadata")
        mobility (projected-mobility metadata)
        raw-auth (get metadata "authType")
        auth-type (when (contains? #{"api_key" "oauth_bearer"} raw-auth) raw-auth)]
    (cond (contains? #{"non_exportable" "descriptor_only" "local_only"} mobility) false
          (= "oauth_bearer" auth-type) (= "access_token_only" mobility)
          :else true)))

(defn oauth-lease?
  "An OAuth projected account whose access token (only) is leasable."
  [projected]
  (let [metadata (get projected "metadata")
        auth (get metadata "authType")
        mobility (let [m (get metadata "credentialMobility")] (when (string? m) (str/trim m)))]
    (and (= "oauth_bearer" auth) (= "access_token_only" mobility))))

(defn import-all-action
  "What import-all does with one projected account of the chosen peer/provider:
  :skip, :fail (non-importable) or :import. `local-expires` is the local
  account's expiry (nil when unknown)."
  [projected local-expires now]
  (let [lease? (oauth-lease? projected)
        imported? (= "imported" (get projected "availabilityState"))]
    (cond
      (and imported? (not lease?)) :skip
      (and lease? imported? (finite-number? local-expires) (> local-expires (+ now (* 10 60000)))) :skip
      (not (projected-allows-credential-import? projected)) :fail
      :else :import)))

;; ---------------------------------------------------------------------------
;; Projected account import bodies
;; ---------------------------------------------------------------------------

(def projected-required-error "source_peer_id_owner_subject_provider_id_and_account_id_required")

(defn diff-event
  "A diff-event for a projected account row (as the store returns it)."
  [record op payload]
  {"ownerSubject" (get record "ownerSubject") "entityType" "projected_account"
   "entityKey" (str (get record "sourcePeerId") ":" (get record "providerId") ":" (get record "accountId"))
   "op" op "payload" payload})

;; ---------------------------------------------------------------------------
;; Usage entries from peers
;; ---------------------------------------------------------------------------

(defn- num [row k] (let [v (get row k)] (when (finite-number? v) v)))
(defn- str-or-nil [row k] (let [v (get row k)] (when (string? v) v)))

(defn sanitize-usage-entry
  "A well-formed usage entry from an untrusted peer row, or nil when a required
  field is missing. Optional numbers must be finite, optional strings strings;
  enumerations fall back to their neutral value."
  [row]
  (when (map? row)
    (let [id (trimmed (get row "id")) provider-id (trimmed (get row "providerId"))
          account-id (trimmed (get row "accountId")) model (trimmed (get row "model"))
          mode (trimmed (get row "upstreamMode")) path (trimmed (get row "upstreamPath"))
          timestamp (num row "timestamp") status (num row "status") latency (num row "latencyMs")]
      (when (and (seq id) (seq provider-id) (seq account-id) (seq model) (seq mode) (seq path)
                 (some? timestamp) (some? status) (some? latency))
        (into {}
              (remove (comp nil? val))
              {"id" id "timestamp" timestamp
               "tenantId" (str-or-nil row "tenantId") "issuer" (str-or-nil row "issuer") "keyId" (str-or-nil row "keyId")
               "routeKind" (if (contains? #{"local" "federated" "bridge"} (get row "routeKind")) (get row "routeKind") "local")
               "federationOwnerSubject" (str-or-nil row "federationOwnerSubject")
               "routedPeerId" (str-or-nil row "routedPeerId") "routedPeerLabel" (str-or-nil row "routedPeerLabel")
               "providerId" provider-id "accountId" account-id
               "authType" (if (contains? #{"api_key" "oauth_bearer" "local" "none"} (get row "authType")) (get row "authType") "none")
               "model" model "upstreamMode" mode "upstreamPath" path "status" status "latencyMs" latency
               "serviceTier" (str-or-nil row "serviceTier")
               "serviceTierSource" (if (contains? #{"fast_mode" "explicit" "none"} (get row "serviceTierSource")) (get row "serviceTierSource") "none")
               "promptTokens" (num row "promptTokens") "completionTokens" (num row "completionTokens")
               "totalTokens" (num row "totalTokens") "cachedPromptTokens" (num row "cachedPromptTokens")
               "imageCount" (num row "imageCount") "imageCostUsd" (num row "imageCostUsd")
               "promptCacheKeyHash" (str-or-nil row "promptCacheKeyHash")
               "promptCacheKeyUsed" (true? (get row "promptCacheKeyUsed")) "cacheHit" (true? (get row "cacheHit"))
               "ttftMs" (num row "ttftMs") "tps" (num row "tps")
               "error" (str-or-nil row "error") "upstreamErrorCode" (str-or-nil row "upstreamErrorCode")
               "upstreamErrorType" (str-or-nil row "upstreamErrorType") "upstreamErrorMessage" (str-or-nil row "upstreamErrorMessage")
               "costUsd" (num row "costUsd") "energyJoules" (num row "energyJoules") "waterEvaporatedMl" (num row "waterEvaporatedMl")})))))

;; ---------------------------------------------------------------------------
;; Known accounts (local credentials merged with projected accounts)
;; ---------------------------------------------------------------------------

(defn- key-of [provider-id account-id] (str provider-id "\u0000" account-id))

(defn- compact [m] (into {} (remove (comp nil? val)) m))

(defn- sort-accounts [accounts]
  (vec (sort (fn [l r]
               (let [c (locale-compare (get l "providerId") (get r "providerId"))]
                 (if-not (zero? c) c
                   (let [c (locale-compare (get l "accountId") (get r "accountId"))]
                     (if-not (zero? c) c (locale-compare (get l "displayName") (get r "displayName")))))))
             accounts)))

(defn account-knowledge
  "{:local-accounts :known-accounts} from the local `providers` ({\"id\" \"accounts\"
  [{\"id\" \"displayName\" \"authType\" \"planType\" \"chatgptAccountId\" \"email\" \"subject\"}]}),
  the projected account rows, and options {:owner-subject :default-owner-subject
  :cooldowns {\"provider\\0account\" until-ms} :now}. Local accounts of other
  owners are left out unless this is the default owner (or no owner is asked
  for) or the account is also projected."
  [providers projected-accounts {:keys [owner-subject default-owner-subject cooldowns now]}]
  (let [requested (some-> owner-subject str/trim)
        default-owner (some-> default-owner-subject str/trim)
        include-all? (or (not (seq requested)) (and (seq default-owner) (= requested default-owner)))
        projected-keys (into #{} (map #(key-of (get % "providerId") (get % "accountId"))) projected-accounts)
        locals (vec
                (for [provider providers
                      account (get provider "accounts")
                      :let [k (key-of (get provider "id") (get account "id"))
                            subject (get account "subject")
                            has-subject? (and (string? subject) (seq subject))
                            owner-match? (and has-subject? (= subject requested))]
                      :when (or include-all? (not has-subject?) owner-match? (contains? projected-keys k))
                      :let [until (get cooldowns k)
                            effective (when (and (number? until) (> until now)) until)]]
                  (compact {"providerId" (get provider "id") "accountId" (get account "id")
                            "displayName" (get account "displayName") "authType" (get account "authType")
                            "planType" (get account "planType") "chatgptAccountId" (get account "chatgptAccountId")
                            "email" (get account "email") "subject" subject
                            "ownerSubject" (when (some? owner-subject) requested)
                            "hasCredentials" true "knowledgeSources" ["local_credential"]
                            "cooldownUntilMs" effective})))
        known (reduce
               (fn [known projected]
                 (let [k (key-of (get projected "providerId") (get projected "accountId"))
                       source (str "projected:" (get projected "availabilityState"))
                       existing (get known k)]
                   (assoc known k
                          (if existing
                            (compact (assoc existing
                                            "ownerSubject" (or (get existing "ownerSubject") (get projected "ownerSubject"))
                                            "sourcePeerId" (or (get existing "sourcePeerId") (get projected "sourcePeerId"))
                                            "projectedState" (get projected "availabilityState")
                                            "warmRequestCount" (get projected "warmRequestCount")
                                            "knowledgeSources" (vec (distinct (conj (get existing "knowledgeSources") source)))))
                            (compact {"providerId" (get projected "providerId") "accountId" (get projected "accountId")
                                      "displayName" (or (get projected "email") (get projected "chatgptAccountId")
                                                        (get projected "accountSubject") (get projected "accountId"))
                                      "planType" (get projected "planType") "chatgptAccountId" (get projected "chatgptAccountId")
                                      "email" (get projected "email") "subject" (get projected "accountSubject")
                                      "ownerSubject" (get projected "ownerSubject") "sourcePeerId" (get projected "sourcePeerId")
                                      "projectedState" (get projected "availabilityState")
                                      "warmRequestCount" (get projected "warmRequestCount")
                                      "hasCredentials" false "knowledgeSources" [source]})))))
               (into {} (map (fn [a] [(key-of (get a "providerId") (get a "accountId")) a])) locals)
               projected-accounts)]
    {:local-accounts (sort-accounts locals)
     :known-accounts (sort-accounts (vals known))}))
