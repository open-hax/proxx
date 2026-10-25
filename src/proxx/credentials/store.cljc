(ns proxx.credentials.store
  "The file-backed credential store as a pure value.

  A store state is {:order [provider-id ...] :providers {provider-id provider}}
  with provider {:id :auth-type [:api-key | :oauth-bearer] :accounts [account ...]}
  and account {:id :token :auth-type + optional :refresh-token :expires-at
  :chatgpt-account-id :email :subject :plan-type}. Absent optionals are omitted.

  `:order` records first-insertion order. The legacy store kept providers in a
  JavaScript object, so `ordered-provider-ids` reproduces its key order
  (array-index keys ascending first, then insertion order); the persisted file
  lists providers in that order.

  Wire input (the keys file) is string-keyed data. Untrusted ≠ ill-typed:
  malformed entries are dropped, never fatal. Metadata derived from a token's
  JWT claims is injected (`:derive-metadata`) so this namespace stays free of
  decoding."
  (:require [clojure.string :as str]
            [proxx.epoch :as epoch]))

(def empty-state {:order [] :providers {}})

;; ---------------------------------------------------------------------------
;; Scalars
;; ---------------------------------------------------------------------------

(defn first-string
  "The first value that is a string, however blank: mirrors a chain of
  `asString(x) ?? asString(y)`, which stops at \"\"."
  [& values]
  (some #(when (string? %) %) values))

(defn- trimmed-or-nil [s]
  (when (string? s) (let [t (str/trim s)] (when (seq t) t))))

(defn- finite-number [x]
  (when (and (number? x)
             #?(:cljs (js/Number.isFinite x)
                :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x))))))
    x))

(defn- nullish-or [a b] (if (some? a) a b))

(defn normalize-provider-id [provider-id fallback]
  (let [normalized (str/trim provider-id)]
    (if (seq normalized) normalized fallback)))

(defn normalize-auth-type
  "Unknown spellings fall back to :api-key (the keys file is user-edited)."
  [raw]
  (let [value (some-> (first-string raw) str/trim str/lower-case)]
    (cond
      (or (str/blank? value) (#{"api_key" "api-key"} value)) :api-key
      (#{"oauth" "oauth_bearer" "oauth-bearer"} value) :oauth-bearer
      :else :api-key)))

(defn auth-type->wire [auth-type]
  (case auth-type :oauth-bearer "oauth_bearer" "api_key"))

(defn mask-secret
  "A display preview of a secret: 2+2 characters for short ones, 4+4 otherwise."
  [secret]
  (let [n (count secret)]
    (if (<= n 8)
      (str (subs secret 0 (min 2 n)) "***" (subs secret (max 0 (- n 2))))
      (str (subs secret 0 4) "..." (subs secret (- n 4))))))

(defn display-name
  "email, else ChatGPT account id, else the account id."
  [{:keys [id email chatgpt-account-id]}]
  (nullish-or email (nullish-or chatgpt-account-id id)))

;; ---------------------------------------------------------------------------
;; Provider ordering (JavaScript object key order)
;; ---------------------------------------------------------------------------

(defn- array-index [k]
  (when (re-matches #"0|[1-9]\d{0,9}" k)
    (let [n #?(:cljs (js/parseInt k 10) :clj (Long/parseLong k))]
      (when (< n 4294967295) n))))

(defn ordered-provider-ids
  "`Object.keys` order for ids inserted in `order`."
  [order]
  (let [indexed (filter array-index order)]
    (vec (concat (sort-by array-index indexed) (remove array-index order)))))

(defn- put-provider [state id provider]
  (-> state
      (update :order #(if (contains? (:providers state) id) % (conj % id)))
      (assoc-in [:providers id] provider)))

(defn providers-in-order [state]
  (mapv (:providers state) (ordered-provider-ids (:order state))))

;; ---------------------------------------------------------------------------
;; Normalizing a keys document
;; ---------------------------------------------------------------------------

(defn- token-from-raw [raw-account auth-type]
  (cond
    (string? raw-account) (trimmed-or-nil raw-account)
    (map? raw-account) (some #(trimmed-or-nil (get raw-account %))
                             (if (= auth-type :oauth-bearer)
                               ["access_token" "token" "bearer_token" "api_key" "key"]
                               ["api_key" "key" "token" "access_token"]))))

(defn- account-id-from-raw [provider-id index raw-account]
  (or (when (map? raw-account)
        (trimmed-or-nil (first-string (get raw-account "id") (get raw-account "account_id")
                                      (get raw-account "name") (get raw-account "label"))))
      (str provider-id "-" (inc index))))

(defn- normalize-account [{:keys [derive-metadata]} provider-id auth-type index raw-account token]
  (let [derived (if (= auth-type :oauth-bearer) (derive-metadata token) {})
        record (when (map? raw-account) raw-account)
        field (fn [derived-key & raw-keys]
                (nullish-or (when record (apply first-string (map #(get record %) raw-keys)))
                            (get derived derived-key)))]
    (->> {:id (account-id-from-raw provider-id index raw-account)
          :token token
          :auth-type auth-type
          :refresh-token (when record (first-string (get record "refresh_token") (get record "refreshToken")))
          :expires-at (when record
                        (epoch/normalize-epoch-ms (nullish-or (finite-number (get record "expires_at"))
                                                              (finite-number (get record "expiresAt")))))
          :chatgpt-account-id (field :chatgpt-account-id "chatgpt_account_id" "chatgptAccountId")
          :email (field :email "email")
          :subject (field :subject "subject" "sub")
          :plan-type (field :plan-type "plan_type" "planType")}
         (remove (comp nil? val))
         (into {}))))

(defn normalize-accounts
  "Accounts from raw entries (strings or maps), unique by token."
  [ctx provider-id auth-type raw-accounts]
  (if-not (sequential? raw-accounts)
    []
    (:accounts
     (reduce-kv
      (fn [{:keys [seen] :as acc} index raw-account]
        (let [token (token-from-raw raw-account auth-type)]
          (if (or (nil? token) (contains? seen token))
            acc
            (-> acc
                (update :seen conj token)
                (update :accounts conj (normalize-account ctx provider-id auth-type index raw-account token))))))
      {:seen #{} :accounts []}
      (vec raw-accounts)))))

(defn- provider-of [ctx id auth-type raw-accounts]
  {:id id :auth-type auth-type :accounts (normalize-accounts ctx id auth-type raw-accounts)})

(defn normalize-credentials
  "A store state from a parsed keys document. `ctx` carries `:derive-metadata`
  (token -> {:chatgpt-account-id :email :subject :plan-type}) and
  `:provider-keys` (the document's `providers` keys in JavaScript order)."
  [{:keys [provider-keys] :as ctx} raw default-provider-id]
  (let [fallback (normalize-provider-id default-provider-id "default")
        single (fn [raw-accounts] (put-provider empty-state fallback (provider-of ctx fallback :api-key raw-accounts)))
        providers (when (map? raw) (get raw "providers"))
        providers (if (sequential? providers) (zipmap (map str (range)) providers) providers)]
    (cond
      (sequential? raw) (single raw)
      (and (map? raw) (sequential? (get raw "keys"))) (single (get raw "keys"))
      (not (map? providers)) empty-state
      :else
      (reduce
       (fn [state raw-id]
         (let [raw-provider (get providers raw-id)
               id (normalize-provider-id raw-id fallback)]
           (cond
             (sequential? raw-provider) (put-provider state id (provider-of ctx id :api-key raw-provider))
             (map? raw-provider)
             (let [auth-type (normalize-auth-type (get raw-provider "auth"))
                   raw-accounts (nullish-or (get raw-provider "accounts") (get raw-provider "keys"))]
               (put-provider state id (provider-of ctx id auth-type raw-accounts)))
             :else state)))
       empty-state
       (or provider-keys (keys providers))))))

;; ---------------------------------------------------------------------------
;; Persisted form
;; ---------------------------------------------------------------------------

(defn- account->wire [auth-type {:keys [id token refresh-token expires-at chatgpt-account-id email subject plan-type]}]
  (if (= auth-type :oauth-bearer)
    (cond-> (array-map "id" id "access_token" token)
      (seq refresh-token) (assoc "refresh_token" refresh-token)
      (number? expires-at) (assoc "expires_at" expires-at)
      (seq chatgpt-account-id) (assoc "chatgpt_account_id" chatgpt-account-id)
      (seq email) (assoc "email" email)
      (seq subject) (assoc "subject" subject)
      (seq plan-type) (assoc "plan_type" plan-type))
    (array-map "id" id "api_key" token)))

(defn persisted-json
  "The document written to disk, as string-keyed data (provider order kept)."
  [state]
  (array-map
   "providers"
   (apply array-map
          (mapcat (fn [{:keys [id auth-type accounts]}]
                    [id (array-map "auth" (auth-type->wire auth-type)
                                   "accounts" (mapv #(account->wire auth-type %) accounts))])
                  (providers-in-order state)))))

;; ---------------------------------------------------------------------------
;; Mutations: each returns the next state
;; ---------------------------------------------------------------------------

(defn- upsert-account [state default-provider-id provider-id auth-type account]
  (let [id (normalize-provider-id provider-id default-provider-id)
        provider (get-in state [:providers id] {:id id :auth-type auth-type :accounts []})
        kept (filterv #(and (not= (:id %) (:id account)) (not= (:token %) (:token account))) (:accounts provider))]
    (put-provider state id (assoc provider :auth-type auth-type :accounts (conj kept account)))))

(defn upsert-api-key-account [state default-provider-id provider-id account-id api-key]
  (upsert-account state default-provider-id provider-id :api-key
                  {:id account-id :token api-key :auth-type :api-key}))

(defn upsert-oauth-account
  "`details` is {:refresh-token :expires-at :chatgpt-account-id :email :subject :plan-type}
  with absent values omitted or nil."
  [state default-provider-id provider-id account-id access-token details]
  (upsert-account state default-provider-id provider-id :oauth-bearer
                  (into {:id account-id :token access-token :auth-type :oauth-bearer}
                        (remove (comp nil? val))
                        (select-keys details [:refresh-token :expires-at :chatgpt-account-id :email :subject :plan-type]))))

(defn remove-account
  "[removed? state']. A provider left without accounts is dropped."
  [state default-provider-id provider-id account-id]
  (let [id (normalize-provider-id provider-id default-provider-id)
        provider (get-in state [:providers id])
        remaining (some->> provider :accounts (filterv #(not= (:id %) account-id)))]
    (cond
      (nil? provider) [false state]
      (= (count remaining) (count (:accounts provider))) [false state]
      (empty? remaining) [true (-> state
                                   (update :providers dissoc id)
                                   (update :order #(filterv (partial not= id) %)))]
      :else [true (assoc-in state [:providers id :accounts] remaining)])))

;; ---------------------------------------------------------------------------
;; Views
;; ---------------------------------------------------------------------------

(defn account-view [reveal-secrets? {:keys [id token auth-type refresh-token expires-at chatgpt-account-id email subject plan-type] :as account}]
  (cond-> {:id id :auth-type auth-type :display-name (display-name account) :secret-preview (mask-secret token)}
    reveal-secrets? (assoc :secret token)
    (seq refresh-token) (assoc :refresh-token-preview (mask-secret refresh-token))
    (and reveal-secrets? (some? refresh-token)) (assoc :refresh-token refresh-token)
    (some? expires-at) (assoc :expires-at expires-at)
    (some? chatgpt-account-id) (assoc :chatgpt-account-id chatgpt-account-id)
    (some? email) (assoc :email email)
    (some? subject) (assoc :subject subject)
    (some? plan-type) (assoc :plan-type plan-type)))

(defn provider-views
  "Provider views in insertion order; the caller sorts them by id with the
  host's locale collation."
  [state reveal-secrets?]
  (mapv (fn [{:keys [id auth-type accounts]}]
          (let [views (mapv #(account-view reveal-secrets? %) accounts)]
            {:id id :auth-type auth-type :account-count (count views) :accounts views}))
        (providers-in-order state)))
