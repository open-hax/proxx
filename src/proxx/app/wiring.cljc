(ns proxx.app.wiring
  "Application composition decisions (src/app.ts): which stores exist given the
  configuration, in what order they start, and the derived settings the
  collaborators are built with. Pure data in, data out; constructing the stores,
  pools and managers stays in TypeScript (the effectful edge).

  `config` is the proxy configuration, string-keyed."
  (:require [clojure.string :as str]))

(def database-stores
  "The SQL-backed stores, in initialisation order. A `:required?` store failing
  aborts startup; an optional one is logged and that feature runs disabled."
  [{:id "credential" :required? true :started "credential store initialized"}
   {:id "accountHealth" :required? true :started "account health store initialized"}
   {:id "event" :required? true :started "event store initialized"}
   {:id "requestUsage" :required? true :started "request usage store initialized"}
   {:id "federation" :required? false :started "federation store initialized"
    :failed "failed to initialize federation store; continuing with federation disabled"}
   {:id "tenantProviderPolicy" :required? false :started "tenant provider policy store initialized"
    :failed "failed to initialize tenant provider policy store; continuing with policy store disabled"}
   {:id "authPersistence" :required? true :started "auth persistence initialized"}])

(def token-refresh-fixed
  {"expiryBufferMs" 60000 "maxConsecutiveFailures" 3})

(def quota-monitor-fixed
  {"checkIntervalMs" (* 20 60 1000) "quotaWarningThreshold" 90 "quotaCriticalThreshold" 98})

(def pheromone-file-name "provider-route-pheromones.json")

(defn- present [s] (when (string? s) (not-empty (str/trim s))))

(defn plan
  "The composition plan for `config`:
    \"database\"     whether a SQL connection is made at all
    \"storeInit\"    the stores to initialise on it, in order (empty without one)
    \"preferAccountStoreProviders\"  the key pool reads its providers from the SQL store
    \"tokenRefresh\" the refresh manager's settings
    \"quotaMonitor\" the quota monitor's settings (provider id defaults to openai)
    \"includeFactoryCatalogRoutes\"  Factory routes join the catalog unless that provider is disabled."
  [config]
  (let [database? (let [url (get config "databaseUrl")] (boolean (and (string? url) (seq url))))]
    {"database" database?
     "storeInit" (if database?
                   (mapv (fn [{:keys [id required? started failed]}]
                           (cond-> {"id" id "required" required? "started" started}
                             failed (assoc "failed" failed)))
                         database-stores)
                   [])
     "preferAccountStoreProviders" database?
     "tokenRefresh" (assoc token-refresh-fixed
                           "maxConcurrency" (get config "oauthRefreshMaxConcurrency")
                           "backgroundIntervalMs" (get config "oauthRefreshBackgroundIntervalMs")
                           "proactiveRefreshWindowMs" (get config "oauthRefreshProactiveWindowMs"))
     "quotaMonitor" (assoc quota-monitor-fixed
                           "providerId" (or (present (get config "openaiProviderId")) "openai"))
     "includeFactoryCatalogRoutes" (not (some #{"factory"} (get config "disabledProviderIds")))
     "pheromoneFileName" pheromone-file-name}))
