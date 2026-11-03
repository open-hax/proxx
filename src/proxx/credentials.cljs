(ns proxx.credentials
  (:require [clojure.string :as str]
            [malli.core :as m]
            [malli.error :as me]
            [proxx.processor :as processor]
            [proxx.schema :as schema]))

(def AuthType
  [:enum "api_key" "oauth_bearer"])

(def RawAccount
  [:or
   [:string {:min 1}]
   [:map-of :keyword :any]])

(def RawProviderSeed
  [:or
   [:vector RawAccount]
   [:map
    [:auth {:optional true} :any]
    [:accounts {:optional true} [:vector RawAccount]]
    [:keys {:optional true} [:vector RawAccount]]]])

(def RawCredentialSeed
  [:or
   [:vector RawAccount]
   [:map
    [:keys {:optional true} [:vector RawAccount]]
    [:providers {:optional true} [:map-of :keyword RawProviderSeed]]]])

(def ParsedProviderSeed
  [:map {:closed true}
   [:provider-id schema/ProviderId]
   [:auth-type AuthType]
   [:accounts [:vector schema/ProviderCredential]]])

(def ParsedCredentialSeed
  [:map {:closed true}
   [:providers [:vector ParsedProviderSeed]]])

(defn normalize-auth-type [raw]
  (let [value (some-> raw str str/trim str/lower-case)]
    (case value
      (nil "" "api_key" "api-key") "api_key"
      ("oauth" "oauth_bearer" "oauth-bearer") "oauth_bearer"
      "api_key")))

(defn- non-empty-string [value]
  (when (string? value)
    (let [trimmed (str/trim value)]
      (when-not (str/blank? trimmed) trimmed))))

(defn- account-token [account auth-type]
  (cond
    (string? account) (non-empty-string account)
    (map? account) (let [keys (if (= "oauth_bearer" auth-type)
                                [:access-token :token :bearer-token :api-key :key]
                                [:api-key :key :token :access-token])]
                     (some #(non-empty-string (get account %)) keys))
    :else nil))

(defn- account-id [provider-id index account]
  (or (when (map? account)
        (some #(non-empty-string (get account %)) [:id :account-id :name :label]))
      (str provider-id "-" (inc index))))

(defn- epoch-ms [value]
  (when (and (number? value) (js/Number.isFinite value))
    (let [n (long value)]
      (cond
        (neg? n) nil
        (< n 100000000000) (* n 1000)
        :else n))))

(defn- provider-credential [provider-id auth-type index account token]
  (cond-> {:id          (account-id provider-id index account)
           :provider-id provider-id
           :account-id  (account-id provider-id index account)
           :auth-type   auth-type
           :secret      token}
    (map? account) (merge (cond-> {}
                            (non-empty-string (:chatgpt-account-id account))
                            (assoc :chatgpt-account-id (non-empty-string (:chatgpt-account-id account)))

                            (non-empty-string (:plan-type account))
                            (assoc :plan-type (non-empty-string (:plan-type account)))

                            (epoch-ms (:expires-at account))
                            (assoc :expires-at (epoch-ms (:expires-at account)))

                            (non-empty-string (:refresh-token account))
                            (assoc :refresh-token (non-empty-string (:refresh-token account)))))))

(defn- valid-provider-credential? [credential]
  (= :ok (first (schema/validate :provider-credential credential))))

(defn- parse-provider [provider-id auth-type raw-accounts]
  (when (vector? raw-accounts)
    (let [seen (volatile! #{})
          accounts (->> raw-accounts
                        (map-indexed
                         (fn [index raw-account]
                           (when-let [token (account-token raw-account auth-type)]
                             (when-not (contains? @seen token)
                               (vswap! seen conj token)
                               (let [credential (provider-credential provider-id auth-type index raw-account token)]
                                 (when (valid-provider-credential? credential)
                                   credential))))))
                        (remove nil?)
                        vec)]
      (when (seq accounts)
        {:provider-id provider-id
         :auth-type   auth-type
         :accounts    accounts}))))

(defn parse-json-credentials
  "Pure parser for credential seed JSON values. It performs no I/O and no DB writes.
   Returns [:ok {:providers [...]}] or [:error humanized-malli-errors]. Providers
   with zero valid credentials are omitted."
  [raw default-provider-id]
  (let [normalized (processor/normalize-keys raw)]
    (if-not (m/validate RawCredentialSeed normalized)
      [:error (me/humanize (m/explain RawCredentialSeed normalized))]
      (let [providers (cond
                        (vector? normalized)
                        (keep identity [(parse-provider default-provider-id "api_key" normalized)])

                        (vector? (:keys normalized))
                        (keep identity [(parse-provider default-provider-id "api_key" (:keys normalized))])

                        (map? (:providers normalized))
                        (keep (fn [[raw-provider-id raw-provider]]
                                (let [provider-id (or (non-empty-string (name raw-provider-id)) default-provider-id)]
                                  (if (vector? raw-provider)
                                    (parse-provider provider-id "api_key" raw-provider)
                                    (let [auth-type (normalize-auth-type (:auth raw-provider))
                                          raw-accounts (or (:accounts raw-provider) (:keys raw-provider))]
                                      (parse-provider provider-id auth-type raw-accounts)))))
                              (:providers normalized))

                        :else [])
            result {:providers (vec providers)}]
        (if (m/validate ParsedCredentialSeed result)
          [:ok result]
          [:error (me/humanize (m/explain ParsedCredentialSeed result))])))))

(defn- credential-out [credential]
  (cond-> {"providerId" (:provider-id credential)
           "accountId"  (:account-id credential)
           "token"      (:secret credential)
           "authType"   (:auth-type credential)}
    (:chatgpt-account-id credential) (assoc "chatgptAccountId" (:chatgpt-account-id credential))
    (:plan-type credential) (assoc "planType" (:plan-type credential))
    (:expires-at credential) (assoc "expiresAt" (:expires-at credential))
    (:refresh-token credential) (assoc "refreshToken" (:refresh-token credential))))

(defn- provider-out [provider]
  {"providerId" (:provider-id provider)
   "authType"   (:auth-type provider)
   "accounts"   (mapv credential-out (:accounts provider))})

(defn parse-json-credentials-js [value default-provider-id]
  (let [[status result] (parse-json-credentials (js->clj value :keywordize-keys true)
                                                default-provider-id)]
    (clj->js (if (= :ok status)
              {"status" "ok"
               "providers" (mapv provider-out (:providers result))}
              {"status" "error"
               "errors" result}))))
