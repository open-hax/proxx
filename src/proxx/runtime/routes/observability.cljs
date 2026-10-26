(ns proxx.runtime.routes.observability
  "Observability routes (src/routes/observability, src/routes/api/ui/analytics):
  request logs, dashboard overview, provider/model analytics, tool seeds and MCP
  server seeds. Stores and the filesystem are read here; who may see what, the
  filters and the choice of data source are proxx.http.observability; every
  number is proxx.analytics.usage."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [proxx.http.guard :as guard]
            [proxx.http.observability :as obs]
            [proxx.runtime.ring :as ring]
            [proxx.runtime.usage-analytics :as usage]))

;; ---------------------------------------------------------------------------
;; Usage facts
;; ---------------------------------------------------------------------------

(defn- earliest-timestamp [^js entries]
  (let [none (js-obj)
        found (reduce (fn [cur ^js e] (if (identical? cur none) (.-timestamp e) (js/Math.min cur (.-timestamp e))))
                      none (array-seq entries))]
    (if (identical? found none) nil found)))

(defn- provider-facts [^js providers]
  (.map providers
        (fn [^js p]
          #js {:id (.-id p)
               :accounts (.map (.-accounts p) (fn [^js a] #js {:id (.-id a) :authType (.-authType a) :planType (.-planType a)}))})))

(defn- status-facts [^js statuses]
  (let [o #js {}]
    (doseq [k (js/Object.keys statuses)]
      (aset o k (.map (aget statuses k) (fn [^js s] #js {:accountId (.-accountId s) :available (.-available s)}))))
    o))

(defn- scope->js [scope] (clj->js (or scope {})))

(defn- entry-coverage [coverage-start retained maximum]
  #js {:coverageStartMs coverage-start :retainedEntryCount retained :maxRetainedEntries maximum})

(defn- sql-coverage [^js coverage]
  (entry-coverage (.-earliestEntryAtMs coverage) (.-retainedEntryCount coverage) (.-maxRetainedEntries coverage)))

(defn- ^:async overview-from-entries
  [^js entries ^js key-pool ^js credential-store sort window now coverage]
  (let [statuses (await (.catch (.getAllAccountStatuses key-pool) (fn [_] #js {})))
        providers (await (.catch (.listProviders credential-store false) (fn [_] #js [])))]
    (usage/usage-overview-from-entries-js
     entries #js {:window window :now now :sort sort :providers (provider-facts providers)
                  :statuses (status-facts statuses) :coverage coverage})))

(defn- ^:async build-usage-overview
  [^js log-store ^js key-pool ^js credential-store sort window scope ^js sql-usage-store]
  (let [now (js/Date.now)
        ^js cfg (usage/usage-window-config-js window now)
        scope-js (scope->js scope)
        scoped? (usage/usage-scope-active-js scope-js)]
    (cond
      sql-usage-store
      (let [[entries coverage] (await (js/Promise.all #js [(.listEntriesSince sql-usage-store (.-entryWindowStart cfg) scope-js)
                                                           (.getCoverage sql-usage-store scope-js)]))]
        (await (overview-from-entries entries key-pool credential-store sort window now (sql-coverage coverage))))

      scoped?
      (let [all (usage/usage-filter-entries-js (.snapshot log-store) scope-js)]
        (await (overview-from-entries all key-pool credential-store sort window now
                                      (entry-coverage (earliest-timestamp all) (.-length all) (aget (.getCoverage log-store) "maxEntries")))))

      :else
      (let [all (.snapshot log-store)
            bucket-start (.-bucketWindowStart cfg)
            persisted? (and (not= window "daily")
                            (or (pos? (.-length (.snapshotDailyBuckets log-store bucket-start)))
                                (pos? (.-length (.snapshotDailyModelBuckets log-store bucket-start)))
                                (pos? (.-length (.snapshotDailyAccountBuckets log-store bucket-start)))))]
        (if (= :entries (obs/overview-source {:log-count (.-length all) :persisted-rollups? persisted?}))
          (await (overview-from-entries all key-pool credential-store sort window now
                                        (entry-coverage (earliest-timestamp all) (.-length all) (aget (.getCoverage log-store) "maxEntries"))))
          (do
            (await (.catch (.getAllStatuses key-pool) (fn [_] #js {})))
            (let [statuses (await (.catch (.getAllAccountStatuses key-pool) (fn [_] #js {})))
                  providers (await (.catch (.listProviders credential-store false) (fn [_] #js [])))]
              ;; evaluated in the order the TS object literal did (store calls are observable)
              (let [model-buckets (.snapshotDailyModelBuckets log-store bucket-start)
                    account-buckets (if (= window "daily") #js [] (.snapshotDailyAccountBuckets log-store bucket-start))
                    buckets (if (= window "daily")
                              (.snapshotHourlyBuckets log-store bucket-start)
                              (.snapshotDailyBuckets log-store bucket-start))
                    coverage (.getCoverage log-store)
                    input #js {}]
                (doseq [[k v] [["window" window] ["now" now] ["sort" sort]
                               ["providers" (provider-facts providers)] ["statuses" (status-facts statuses)]
                               ["entries" all] ["buckets" buckets] ["modelBuckets" model-buckets]
                               ["accountBuckets" account-buckets] ["coverage" coverage]]]
                  (aset input k v))
                (usage/usage-overview-from-rollups-js input)))))))))

(defn- ^:async build-provider-model-analytics
  [^js log-store window sort scope ^js sql-usage-store]
  (let [now (js/Date.now)
        ^js cfg (usage/usage-window-config-js window now)
        scope-js (scope->js scope)
        from-entries (fn [entries coverage]
                       (usage/usage-analytics-from-entries-js entries #js {:window window :sort sort :now now :coverage coverage}))
        local-coverage (fn [entries] (entry-coverage (earliest-timestamp entries) (.-length entries) (aget (.getCoverage log-store) "maxEntries")))]
    (cond
      sql-usage-store
      (let [[entries coverage] (await (js/Promise.all #js [(.listEntriesSince sql-usage-store (.-entryWindowStart cfg) scope-js)
                                                           (.getCoverage sql-usage-store scope-js)]))]
        (from-entries entries (sql-coverage coverage)))

      (usage/usage-scope-active-js scope-js)
      (let [relevant (usage/usage-filter-entries-js (.snapshot log-store) scope-js)]
        (from-entries relevant (local-coverage relevant)))

      :else
      (let [all (.snapshot log-store)]
        (if (= :entries (obs/analytics-source {:log-count (.-length all)}))
          (from-entries all (local-coverage all))
          (usage/usage-analytics-from-rollups-js
           #js {:window window :sort sort :now now :entries (.snapshot log-store)
                :modelBuckets (.snapshotDailyModelBuckets log-store (.-bucketWindowStart cfg))
                :coverage (.getCoverage log-store)}))))))

;; ---------------------------------------------------------------------------
;; MCP seeds (cached 30 s per process, like the TS module-level cache)
;; ---------------------------------------------------------------------------

(defonce ^:private mcp-seed-cache (atom nil))

(defn- ^:async first-existing-path [candidates]
  (loop [[c & more] candidates]
    (when c
      (if (try (await (.access fsp c)) true (catch :default _ false))
        c
        (recur more)))))

(defn- ^:async load-cached-mcp-seeds [load-mcp-seeds]
  (let [now (js/Date.now)
        {:keys [loaded-at seeds]} @mcp-seed-cache]
    (if (obs/mcp-seed-cache-fresh? loaded-at now)
      seeds
      (let [cwd (.cwd js/process)
            dir (await (first-existing-path [(.resolve path cwd "../../ecosystems")
                                             (.resolve path cwd "../ecosystems")
                                             (.resolve path cwd "ecosystems")]))]
        (if-not dir
          (do (reset! mcp-seed-cache {:loaded-at now :seeds #js []}) #js [])
          (let [seeds (await (.catch (js/Promise.resolve (load-mcp-seeds dir)) (fn [_] #js [])))]
            (reset! mcp-seed-cache {:loaded-at now :seeds seeds})
            seeds))))))

;; ---------------------------------------------------------------------------
;; Routes
;; ---------------------------------------------------------------------------

(defn- join-path [prefix suffix]
  (str (if (.endsWith prefix "/") (subs prefix 0 (dec (count prefix))) prefix) suffix))

(defn- usage-handler [fetch-fn]
  (fn ^:async usage-route [{:keys [auth query]}]
    (or (guard/require-auth {:auth auth})
        (let [{:keys [response scope]} (obs/usage-scope auth query)]
          (or response
              {:body (await (fetch-fn scope (let [s (get query "sort")] (when (string? s) s))
                                      (usage/usage-to-window-js (get query "window"))))})))))

(defn routes
  "deps: {:request-log-store :key-pool :credential-store :sql-request-usage-store
          :get-tool-seed-for-model :load-mcp-seeds}
  opts: {:prefix :include-request-logs? ...} (each include flag defaults to true)."
  [{:keys [^js request-log-store ^js key-pool ^js credential-store ^js sql-request-usage-store
           get-tool-seed-for-model load-mcp-seeds]}
   {:keys [prefix include-request-logs? include-dashboard-overview? include-provider-model-analytics?
           include-tools? include-mcp-servers?]}]
  (let [p #(join-path prefix %)]
    (cond-> []
      include-request-logs?
      (conj {:method :get :path (p "/request-logs")
             :handler (fn ^:async request-logs [{:keys [auth query]}]
                        (or (guard/require-auth {:auth auth})
                            (let [{:keys [response] :as scope} (obs/request-log-scope auth query)]
                              (or response
                                  (let [filters (clj->js (obs/request-log-filters query scope))
                                        entries (if sql-request-usage-store
                                                  (await (.listEntries sql-request-usage-store filters))
                                                  (.list request-log-store filters))]
                                    {:body #js {:entries (.map entries (fn [^js e]
                                                                         (let [o (js/Object.assign #js {} e)]
                                                                           (aset o "decodeTps" (.-tps e))
                                                                           o)))}})))))})

      include-dashboard-overview?
      (conj {:method :get :path (p "/dashboard/overview")
             :handler (usage-handler (fn [scope sort window]
                                       (build-usage-overview request-log-store key-pool credential-store sort window scope sql-request-usage-store)))})

      include-provider-model-analytics?
      (conj {:method :get :path (p "/analytics/provider-model")
             :handler (usage-handler (fn [scope sort window]
                                       (build-provider-model-analytics request-log-store window sort scope sql-request-usage-store)))})

      include-tools?
      (conj {:method :get :path (p "/tools")
             :handler (fn [{:keys [query]}]
                        (let [model (obs/tool-model query)]
                          {:body #js {:model model :tools (get-tool-seed-for-model model)}}))})

      include-mcp-servers?
      (conj {:method :get :path (p "/mcp-servers")
             :handler (fn ^:async mcp-servers [_]
                        (let [seeds (await (load-cached-mcp-seeds load-mcp-seeds))]
                          {:body #js {:count (.-length seeds) :servers seeds}}))}))))

(defn register-observability-routes-js
  "`deps`: {requestLogStore, keyPool, credentialStore, sqlRequestUsageStore?,
  getToolSeedForModel, loadMcpSeeds}; `options` (optional): {prefix, includeX flags}."
  [app ^js deps ^js options]
  (let [flag (fn [k] (not= false (when options (aget options k))))]
    (ring/register!
     app
     (routes {:request-log-store (.-requestLogStore deps)
              :key-pool (.-keyPool deps)
              :credential-store (.-credentialStore deps)
              :sql-request-usage-store (.-sqlRequestUsageStore deps)
              :get-tool-seed-for-model (.-getToolSeedForModel deps)
              :load-mcp-seeds (.-loadMcpSeeds deps)}
             {:prefix (let [p (when options (aget options "prefix"))] (if (some? p) p "/api/ui"))
              :include-request-logs? (flag "includeRequestLogs")
              :include-dashboard-overview? (flag "includeDashboardOverview")
              :include-provider-model-analytics? (flag "includeProviderModelAnalytics")
              :include-tools? (flag "includeTools")
              :include-mcp-servers? (flag "includeMcpServers")}))))
