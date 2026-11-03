(ns proxx.runtime.routes
  "Route tables for the HTTP edge. Handlers gather facts (effects) and hand
  them to the pure builders in proxx.http.*."
  (:require [proxx.http.api-v1 :as api-v1]
            [proxx.http.health :as health]
            [proxx.runtime.ring :as http]))

(defn- status->clj [^js s]
  {:provider-id (.-providerId s) :auth-type (.-authType s)
   :total-accounts (.-totalAccounts s) :available-accounts (.-availableAccounts s)
   :cooldown-accounts (.-cooldownAccounts s) :next-ready-in-ms (.-nextReadyInMs s)})

(defn- ^:async health-facts [^js key-pool provider-id token-configured?]
  (try
    (let [default-status (status->clj (await (.getStatus key-pool provider-id)))
          all (js->clj (await (.getAllStatuses key-pool)))]
      {:token-configured? token-configured?
       :default-status default-status
       :all-statuses (into {} (map (fn [[id s]] [id {:provider-id (get s "providerId") :auth-type (get s "authType")
                                                    :total-accounts (get s "totalAccounts")
                                                    :available-accounts (get s "availableAccounts")
                                                    :cooldown-accounts (get s "cooldownAccounts")
                                                    :next-ready-in-ms (get s "nextReadyInMs")}]))
                           all)})
    (catch :default e
      {:token-configured? token-configured? :error (.-message e)})))

(defn health-routes
  "deps: {:key-pool js-key-pool :provider-id string :token-configured? bool}"
  [{:keys [key-pool provider-id token-configured?]}]
  [{:method :get :path "/health"
    :handler (fn ^:async health-handler [_]
               {:status 200
                :body (health/report (await (health-facts key-pool provider-id token-configured?)))})}])

(def api-v1-index-routes
  [{:method :get :path "/api/v1"
    :handler (fn [_] {:status 200 :body (api-v1/index)})}])

(defn register-health-routes-js [app ^js deps]
  (http/register! app (health-routes {:key-pool (.-keyPool deps)
                                      :provider-id (.-upstreamProviderId deps)
                                      :token-configured? (boolean (.-proxyAuthTokenConfigured deps))})))

(defn register-api-v1-index-route-js [app]
  (http/register! app api-v1-index-routes))
