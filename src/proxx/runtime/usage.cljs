(ns proxx.runtime.usage
  "JS facade over proxx.usage.sql for the TypeScript SqlRequestUsageStore.
  Rows and entries are converted shallowly (nested JSON stays an opaque JS
  value) and results are built key by key so objects keep the property order
  the TypeScript store produced."
  (:require [proxx.usage.sql :as sql]))

(defn- shallow [^js o]
  (reduce (fn [m k] (let [v (aget o k)] (if (undefined? v) m (assoc m k v)))) {} (js-keys o)))

(def ^:private entry-key-order
  ["id" "timestamp" "tenantId" "issuer" "keyId" "routeKind" "federationOwnerSubject" "routedPeerId"
   "routedPeerLabel" "providerId" "accountId" "authType" "model" "upstreamMode" "upstreamPath" "status"
   "latencyMs" "serviceTier" "serviceTierSource" "promptTokens" "completionTokens" "totalTokens"
   "cachedPromptTokens" "imageCount" "imageCostUsd" "promptCacheKeyHash" "promptCacheKeyUsed" "cacheHit"
   "ttftMs" "tps" "endToEndTps" "error" "upstreamErrorCode" "upstreamErrorType" "upstreamErrorMessage"
   "factoryDiagnostics" "costUsd" "energyJoules" "waterEvaporatedMl"])

(defn- truthy? [v] (not (or (nil? v) (false? v) (= v "") (= v 0) (and (number? v) (not= v v)))))

(defn- parse-diagnostics
  "factory_diagnostics column: falsy -> none; JSON text -> its object (or none
  when unparseable / not an object); anything else as-is."
  [v]
  (cond (not (truthy? v)) nil
        (string? v) (try (let [p (js/JSON.parse v)] (when (or (object? p) (array? p)) p))
                         (catch :default _ nil))
        :else v))

(defn- ordered [m order]
  (let [o #js {}]
    (doseq [k order] (when (contains? m k) (aset o k (get m k))))
    o))

(defn- rethrow [f]
  (try (f) (catch :default e (throw (if (some? (ex-data e)) (js/Error. (ex-message e)) e)))))

(defn usage-ddl-js [] (to-array sql/ddl))

(defn usage-to-entry-js [row]
  (rethrow #(let [w (shallow row)]
              (ordered (sql/row->entry w (parse-diagnostics (get w "factory_diagnostics"))) entry-key-order))))

(defn usage-coverage-js [row]
  (let [c (sql/coverage (when row (shallow row)))]
    #js {:earliestEntryAtMs (let [v (get c "earliestEntryAtMs")] (if (nil? v) nil v))
         :retainedEntryCount (get c "retainedEntryCount")
         :maxRetainedEntries (get c "maxRetainedEntries")}))

(defn usage-upsert-js [entry]
  (let [w (shallow entry)
        w (assoc w "factoryDiagnosticsJson"
                 (when (truthy? (get w "factoryDiagnostics")) (js/JSON.stringify (get w "factoryDiagnostics"))))
        {:strs [strings values]} (sql/upsert-statement w)
        arr (to-array strings)]
    (aset arr "raw" (to-array strings))
    #js {:strings arr :values (to-array values)}))

(defn- query->js [{:strs [text values]}] #js {:text text :values (to-array values)})

(defn usage-list-query-js [filters cursor]
  (rethrow #(query->js (sql/list-query (shallow filters)
                                       (when cursor (shallow cursor))))))

(defn usage-list-since-query-js [since-ms filters limit after]
  (query->js (sql/list-since-query since-ms (if filters (shallow filters) {}) limit (when after (shallow after)))))

(defn usage-coverage-query-js [filters]
  (query->js (sql/coverage-query (if filters (shallow filters) {}))))

(defn usage-cursor-query-js [] sql/cursor-query)

(defn usage-to-cursor-js [row]
  (rethrow #(let [c (sql/row->cursor (shallow row))] #js {:timestampMs (get c "timestampMs") :id (get c "id")})))

(defn create-sql-request-usage-store-js
  "The request-usage mirror over postgres.js handle `sql` (formerly SqlRequestUsageStore).
  The statements, parameters and row mapping above are the persisted contract;
  this only executes them."
  [^js sql]
  (let [run (fn [^js q] (.unsafe sql (.-text q) (.-values q)))]
    #js {:init (fn ^:async init []
                 (doseq [statement (array-seq (usage-ddl-js))] (await (.unsafe sql statement)))
                 js/undefined)
         :upsertEntry (fn ^:async upsert-entry [entry]
                        (let [^js q (usage-upsert-js entry)]
                          (await (.apply sql nil (.concat #js [(.-strings q)] (.-values q))))
                          js/undefined))
         :listEntriesSince (fn ^:async list-since [since-ms filters limit after]
                             (let [rs (await (run (usage-list-since-query-js since-ms filters limit after)))]
                               (.map rs (fn [row] (usage-to-entry-js row)))))
         :listEntries (fn ^:async list-entries [filters]
                        (let [filters (if (nil? filters) #js {} filters)
                              before (.-before ^js filters)
                              cursor-rows (when (and (string? before) (pos? (.-length before)))
                                            (await (.unsafe sql (usage-cursor-query-js) #js [before])))]
                          (if (and cursor-rows (not (aget cursor-rows 0)))
                            #js []
                            (let [cursor (when cursor-rows (usage-to-cursor-js (aget cursor-rows 0)))
                                  rs (await (run (usage-list-query-js filters cursor)))]
                              (.map rs (fn [row] (usage-to-entry-js row)))))))
         :getCoverage (fn ^:async get-coverage [filters]
                        (let [rs (await (run (usage-coverage-query-js filters)))]
                          (usage-coverage-js (aget rs 0))))}))
