(ns proxx.runtime.github-oauth
  "JS edge for the GitHub login route decisions (`proxx.oauth.github`): a
  pending-authorization table in an atom plus thin converters. Fastify routes
  stay in TypeScript."
  (:require [proxx.oauth.github :as gh]))

(defn- form-pairs [pairs] (.toString (js/URLSearchParams. (clj->js pairs))))

(defn github-oauth-constants-js []
  #js {"authorizeUrl" gh/authorize-url "tokenUrl" gh/token-url "userUrl" gh/user-url
       "accessTokenTtlSeconds" gh/access-token-ttl-seconds "refreshTokenTtlSeconds" gh/refresh-token-ttl-seconds
       "clientId" gh/client-id})

(defn create-github-pending-store-js
  "An in-memory table of pending authorizations: add(state, entry) and
  take(state, nowMs) -> {entry?, rejection?}."
  []
  (let [table (atom {})]
    #js {"add" (fn [state redirect-uri now-ms]
                 (swap! table gh/add-pending state {:redirect-uri redirect-uri :created-at now-ms})
                 js/undefined)
         "take" (fn [state now-ms]
                  (let [[entry table'] (gh/take-pending @table state)
                        _ (reset! table table')
                        rejection (gh/pending-rejection entry now-ms)
                        out #js {}]
                    (if rejection
                      (aset out "rejection" (clj->js rejection))
                      (aset out "redirectUri" (:redirect-uri entry)))
                    out))}))

(defn github-authorize-query-js [github-client-id redirect-uri state]
  (form-pairs (gh/authorize-params github-client-id redirect-uri state)))

(defn- shallow->clj
  "Fastify query objects have a null prototype, which `js->clj` leaves
  unconverted; copy the own keys explicitly."
  [^js o]
  (into {} (map (fn [k] [k (aget o k)])) (js/Object.keys o)))

(defn github-callback-rejection-js [query]
  (some-> (gh/callback-rejection (shallow->clj query)) clj->js))

(defn github-refresh-plan-js [found expires-at now-s]
  (name (gh/refresh-plan found expires-at now-s)))

(defn github-admin-account-view-js [credential]
  (clj->js (gh/admin-account-view (shallow->clj credential))))

(defn github-normalize-login-js [login] (gh/normalize-login login))

(defn github-cookie-value-js [header name decode] (gh/cookie-value header name decode))
(defn github-set-cookie-header-js [name value expires] (gh/set-cookie-header name value expires))
(defn github-clear-cookie-header-js [name] (gh/clear-cookie-header name))
(defn github-bearer-js [authorization] (gh/bearer-from-authorization authorization))
