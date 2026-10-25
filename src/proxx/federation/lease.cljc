(ns proxx.federation.lease
  "Tolerant readers for the credential-lease replies of a bridged peer. The
  peer is untrusted: malformed entries are dropped, never repaired."
  (:require [clojure.string :as str]))

(defn- string-field [m k] (let [v (get m k)] (when (string? v) v)))
(defn- number-field [m k] (let [v (get m k)] (when (number? v) v)))
(defn- auth-type [m] (if (= "oauth_bearer" (get m "authType")) "oauth_bearer" "api_key"))

(defn- compact [m] (into {} (remove (comp nil? val)) m))

(defn parse-accounts
  "Account summaries from {\"accounts\" [...]}; entries without a non-blank
  accountId are dropped. The accountId is kept as sent: it is persisted identity."
  [payload fallback-provider-id]
  (let [entries (when (map? payload) (get payload "accounts"))]
    (into []
          (comp (filter map?)
                (map (fn [entry]
                       (compact {"providerId" (or (string-field entry "providerId") fallback-provider-id)
                                 "accountId" (or (string-field entry "accountId") "")
                                 "authType" (auth-type entry)
                                 "expiresAt" (number-field entry "expiresAt")
                                 "chatgptAccountId" (string-field entry "chatgptAccountId")
                                 "planType" (string-field entry "planType")})))
                (filter #(seq (str/trim (get % "accountId")))))
          (when (sequential? entries) entries))))

(defn parse-export
  "The exported account from {\"account\" {...}}; nil without a non-empty secret."
  [payload]
  (let [account (when (map? payload) (get payload "account"))
        secret (when (map? account) (string-field account "secret"))]
    (when (seq secret)
      (compact {"authType" (auth-type account)
                "secret" secret
                "expiresAt" (number-field account "expiresAt")
                "chatgptAccountId" (string-field account "chatgptAccountId")
                "email" (string-field account "email")
                "subject" (string-field account "subject")
                "planType" (string-field account "planType")}))))
