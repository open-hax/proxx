(ns proxx.http.health
  "The /health report as a pure function of the facts the edge gathers.")

(def service-name "open-hax-openai-proxy")

(defn- auth-mode [token-configured?] (if token-configured? "token" "unauthenticated"))

(defn- default-provider-summary [{:keys [provider-id auth-type total-accounts available-accounts cooldown-accounts next-ready-in-ms]}]
  {"providerId" provider-id "authType" auth-type
   "totalKeys" total-accounts "availableKeys" available-accounts
   "cooldownKeys" cooldown-accounts "nextReadyInMs" next-ready-in-ms})

(defn- provider-summary [{:keys [provider-id auth-type total-accounts available-accounts cooldown-accounts next-ready-in-ms]}]
  {"providerId" provider-id "authType" auth-type
   "totalAccounts" total-accounts "availableAccounts" available-accounts
   "cooldownAccounts" cooldown-accounts "nextReadyInMs" next-ready-in-ms})

(defn report
  "Health body. `facts` is {:token-configured? bool, :default-status status,
  :all-statuses {provider-id status}} when the key pool answered, or
  {:token-configured? bool, :error message} when it did not (reported as
  `ok: false`, never as an HTTP error, so probes can still read it)."
  [{:keys [token-configured? default-status all-statuses error]}]
  (let [base {"service" service-name "authMode" (auth-mode token-configured?)}]
    (if error
      (assoc base "ok" false "keyPool" {"error" error} "keyPoolProviders" {})
      (assoc base "ok" true
             "keyPool" (default-provider-summary default-status)
             "keyPoolProviders" (into {} (map (fn [[id status]] [id (provider-summary status)])) all-statuses)))))
