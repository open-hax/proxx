(ns proxx.runtime.usage-store
  "Edge of the request-usage table (`src/lib/db/sql-request-usage-store.ts`):
  statements, parameters and row mapping are `proxx.usage.sql` (via the JS
  facade `proxx.runtime.usage`); this only runs them over a postgres.js client."
  (:require [proxx.runtime.usage :as usage]))

(defn create-sql-request-usage-store-js
  "The facade `SqlRequestUsageStore` forwards to."
  [^js sql]
  (let [run (fn [^js q] (.unsafe sql (.-text q) (.-values q)))
        entries (fn [rows] (.map rows (fn [row] (usage/usage-to-entry-js row))))]
    #js {"init" (fn ^:async init []
                  (doseq [statement (usage/usage-ddl-js)] (await (.unsafe sql statement)))
                  js/undefined)

         "upsertEntry" (fn ^:async upsert-entry [entry]
                         (let [^js q (usage/usage-upsert-js entry)]
                           (await (.apply sql nil (.concat #js [(.-strings q)] (.-values q))))
                           js/undefined))

         "listEntriesSince" (fn ^:async list-entries-since [since-ms filters limit after]
                              (entries (await (run (usage/usage-list-since-query-js since-ms filters limit after)))))

         "listEntries" (fn ^:async list-entries [filters]
                         (let [filters (or filters #js {})
                               before (.-before ^js filters)]
                           (if (and (string? before) (pos? (.-length before)))
                             (let [cursor-rows (await (.unsafe sql (usage/usage-cursor-query-js) #js [before]))
                                   cursor-row (aget cursor-rows 0)]
                               (if-not cursor-row
                                 #js []
                                 (entries (await (run (usage/usage-list-query-js filters (usage/usage-to-cursor-js cursor-row)))))))
                             (entries (await (run (usage/usage-list-query-js filters nil)))))))

         "getCoverage" (fn ^:async get-coverage [filters]
                         (let [rows (await (run (usage/usage-coverage-query-js (or filters #js {}))))]
                           (usage/usage-coverage-js (aget rows 0))))}))
