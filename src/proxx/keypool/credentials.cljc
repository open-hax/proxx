(ns proxx.keypool.credentials
  "Pure reading and merging of provider credentials.

  Credentials are keyword maps
    {:provider-id :account-id :token :auth-type [:api-key | :oauth-bearer]
     :chatgpt-account-id :plan-type :refresh-token :expires-at}
  with absent optionals omitted. Wire input (keys files, inline JSON, stores)
  is string-keyed data; effects such as reading files or the environment happen
  at the edge and hand their results to these functions.

  A provider state is {:auth-type :accounts [credential ...] :next-offset n}."
  (:require [clojure.string :as str]
            [proxx.epoch :as epoch]))

;; ---------------------------------------------------------------------------
;; Scalars
;; ---------------------------------------------------------------------------

(defn normalize-provider-id [provider-id]
  (let [trimmed (str/trim provider-id)]
    (if (seq trimmed) trimmed "default")))

(defn- first-string
  "The first value that is a string, however blank. Mirrors the legacy `??`
  chain: used wherever the result feeds persisted identity."
  [& values]
  (some #(when (string? %) %) values))

(defn- trimmed-or-nil [s]
  (when (string? s)
    (let [trimmed (str/trim s)] (when (seq trimmed) trimmed))))

(defn parse-auth-type
  "Accepts the spellings seen in keys files; anything else is an error."
  [raw]
  (let [normalized (when (string? raw) (str/lower-case (str/trim raw)))]
    (cond
      (or (str/blank? normalized) (#{"api_key" "api-key"} normalized)) :api-key
      (#{"oauth_bearer" "oauth-bearer" "oauth"} normalized) :oauth-bearer
      :else (throw (ex-info (str "Unsupported provider auth type: " raw)
                            {:error/type :keypool/unsupported-auth-type :auth-type raw})))))

(def ^:private token-keys
  {:oauth-bearer ["access_token" "token" "bearer_token" "api_key" "key"]
   :api-key ["api_key" "key" "token" "access_token"]})

(defn- read-token [raw-account auth-type]
  (cond
    (string? raw-account) (trimmed-or-nil raw-account)
    (map? raw-account) (some #(trimmed-or-nil (get raw-account %)) (token-keys auth-type))))

(def ^:private hex-digits "0123456789abcdef")

(defn deterministic-account-id
  "A stable, UUIDv5-shaped id derived from provider and token, so an account
  keeps its identity (and its persisted cooldown/disabled state) across
  reloads. `sha256-hex` maps a string to its lowercase hex digest."
  [sha256-hex provider-id token]
  (let [digits (vec (subs (sha256-hex (str provider-id "\u0000" token)) 0 32))
        variant (-> (str/index-of hex-digits (nth digits 16)) (bit-and 3) (bit-or 8))
        s (apply str (assoc digits 12 \5 16 (nth hex-digits variant)))]
    (str (subs s 0 8) "-" (subs s 8 12) "-" (subs s 12 16) "-" (subs s 16 20) "-" (subs s 20 32))))

(defn- account-id [{:keys [sha256-hex]} provider-id index raw-account token]
  (let [raw-id (when (map? raw-account)
                 (first-string (get raw-account "id") (get raw-account "name")
                               (get raw-account "account_id") (get raw-account "label")))]
    (or (trimmed-or-nil raw-id)
        (if token
          (deterministic-account-id sha256-hex provider-id token)
          (str provider-id "-" (inc index))))))

;; ---------------------------------------------------------------------------
;; Accounts and providers
;; ---------------------------------------------------------------------------

(defn- normalize-account
  "A credential for `raw-account`, or nil when it carries no token."
  [ctx provider-id auth-type index raw-account]
  (when-let [token (read-token raw-account auth-type)]
    (let [field (fn [& ks] (when (map? raw-account) (trimmed-or-nil (apply first-string (map #(get raw-account %) ks)))))
          chatgpt-account-id (field "chatgpt_account_id" "chatgptAccountId" "upstream_account_id" "upstreamAccountId")
          plan-type (some-> (field "plan_type" "planType") str/lower-case)
          refresh-token (field "refresh_token" "refreshToken")
          expires-at (when (map? raw-account)
                       (epoch/normalize-epoch-ms
                        (if (some? (get raw-account "expires_at")) (get raw-account "expires_at") (get raw-account "expiresAt"))))]
      (cond-> {:provider-id provider-id
               :account-id (account-id ctx provider-id index raw-account token)
               :token token
               :auth-type auth-type}
        chatgpt-account-id (assoc :chatgpt-account-id chatgpt-account-id)
        plan-type (assoc :plan-type plan-type)
        expires-at (assoc :expires-at expires-at)
        refresh-token (assoc :refresh-token refresh-token)))))

(defn normalize-accounts
  "Credentials for `raw-accounts`, dropping token-less entries and later
  duplicates of an earlier token."
  [ctx provider-id auth-type raw-accounts]
  (if-not (sequential? raw-accounts)
    []
    (->> raw-accounts
         (keep-indexed (fn [index raw] (normalize-account ctx provider-id auth-type index raw)))
         (reduce (fn [{:keys [seen accounts]} account]
                   (if (contains? seen (:token account))
                     {:seen seen :accounts accounts}
                     {:seen (conj seen (:token account)) :accounts (conj accounts account)}))
                 {:seen #{} :accounts []})
         :accounts)))

(defn- provider-state [auth-type accounts]
  {:auth-type auth-type :accounts accounts :next-offset 0})

(defn parse-provider-state [ctx provider-id raw]
  (cond
    (sequential? raw) (provider-state :api-key (normalize-accounts ctx provider-id :api-key raw))
    (not (map? raw)) (provider-state :api-key [])
    :else (let [auth-type (parse-auth-type (get raw "auth"))
                raw-accounts (if (some? (get raw "accounts")) (get raw "accounts") (get raw "keys"))]
            (provider-state auth-type (normalize-accounts ctx provider-id auth-type raw-accounts)))))

(defn parse-providers
  "Provider states by id from a keys document: a bare array, {\"keys\": [...]},
  or {\"providers\": {id: ...}}. Providers with no usable accounts are dropped."
  [ctx raw default-provider-id]
  (let [default-id (normalize-provider-id default-provider-id)
        keep-nonempty (fn [m id state] (if (seq (:accounts state)) (assoc m id state) m))]
    (cond
      (or (sequential? raw) (and (map? raw) (sequential? (get raw "keys"))))
      (keep-nonempty {} default-id
                     (parse-provider-state ctx default-id (if (sequential? raw) raw (get raw "keys"))))

      (not (map? raw))
      (throw (ex-info "Invalid keys JSON: expected an array, {\"keys\": []}, or {\"providers\": {...}}."
                      {:error/type :keypool/invalid-keys-document}))

      (not (map? (get raw "providers")))
      (throw (ex-info "Invalid keys JSON: missing top-level \"providers\" object."
                      {:error/type :keypool/invalid-keys-document}))

      :else
      (reduce-kv (fn [m raw-id raw-provider]
                   (let [id (normalize-provider-id raw-id)]
                     (keep-nonempty m id (parse-provider-state ctx id raw-provider))))
                 {} (get raw "providers")))))

(defn merge-provider-states
  "Union of two states of one provider: accounts de-duplicated by token (left
  wins), auth type and rotation offset from the left."
  [left right]
  (cond
    (nil? left) right
    (nil? right) left
    :else (assoc left :accounts
                 (->> (concat (:accounts left) (:accounts right))
                      (reduce (fn [{:keys [seen accounts]} account]
                                (if (contains? seen (:token account))
                                  {:seen seen :accounts accounts}
                                  {:seen (conj seen (:token account)) :accounts (conj accounts account)}))
                              {:seen #{} :accounts []})
                      :accounts))))

(defn providers-from-account-store
  "Provider states from a persisted store: `provider-info` maps provider id to
  {:auth-type}, `accounts-by-provider` maps provider id to credentials."
  [provider-info accounts-by-provider]
  (into {}
        (keep (fn [provider-id]
                (let [accounts (vec (get accounts-by-provider provider-id))]
                  (when (seq accounts)
                    [provider-id (provider-state (or (get-in provider-info [provider-id :auth-type])
                                                     (:auth-type (first accounts))
                                                     :api-key)
                                                 accounts)]))))
        (distinct (concat (keys provider-info) (keys accounts-by-provider)))))

;; ---------------------------------------------------------------------------
;; Environment seeding (driven by :provider-seed contracts)
;; ---------------------------------------------------------------------------

(defn- first-env
  "First non-blank trimmed value among `names` in `env`."
  [env names]
  (some #(trimmed-or-nil (get env %)) names))

(defn env-provider-states
  "Provider states seeded from `env` according to `seed-specs`
  ({:provider-id-env-names :provider-id-fallback :key-env-names}). Each seed
  yields one api-key provider with a single deterministic-id account."
  [{:keys [sha256-hex]} seed-specs env]
  (reduce (fn [m {:keys [provider-id-env-names provider-id-fallback key-env-names]}]
            (if-let [token (first-env env key-env-names)]
              (let [provider-id (normalize-provider-id (or (first-env env provider-id-env-names) provider-id-fallback))]
                (assoc m provider-id
                       (provider-state :api-key
                                       [{:provider-id provider-id
                                         :account-id (deterministic-account-id sha256-hex provider-id token)
                                         :token token
                                         :auth-type :api-key}])))
              m))
          {} seed-specs))

;; ---------------------------------------------------------------------------
;; Source precedence
;; ---------------------------------------------------------------------------

(defn merge-sources
  "Combine already-loaded provider maps in precedence order: account store,
  then keys file, inline JSON, environment (each skipped for a provider the
  store already owns when `:prefer-account-store?`), then Factory OAuth, which
  always merges in. With no providers at all, a configured store is fine (it
  may simply be empty); otherwise it is an error."
  [{:keys [account-store file inline env factory-oauth prefer-account-store? account-store?]}]
  (let [fold-lower (fn [merged source]
                     (reduce-kv (fn [m provider-id state]
                                  (if (and prefer-account-store? (contains? m provider-id))
                                    m
                                    (assoc m provider-id (merge-provider-states (get m provider-id) state))))
                                merged source))
        merged (-> (or account-store {})
                   (fold-lower file)
                   (fold-lower inline)
                   (fold-lower env)
                   (as-> m (reduce-kv (fn [acc provider-id state]
                                        (assoc acc provider-id (merge-provider-states (get acc provider-id) state)))
                                      m factory-oauth)))]
    (if (and (empty? merged) (not account-store?))
      (throw (ex-info "No provider accounts found in keys file or environment"
                      {:error/type :keypool/no-providers}))
      merged)))
