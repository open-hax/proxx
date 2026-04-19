(ns proxx.store.postgres
  (:require [proxx.store.protocol :refer [IStore store-get store-put store-delete store-list store-close]]))

;; ══════════════════════════════════════════════════════════════
;; Postgres store — long-term truth
;; ══════════════════════════════════════════════════════════════
;; This driver is deliberately thin: it executes named queries from
;; a provided query-registry. No inline SQL lives here.

(defrecord PostgresStore [sql query-registry]
  IStore
  (store-get [_ entity-type k]
    (let [q (get-in query-registry [entity-type :select-one])]
      (-> (.unsafe sql q #js [k])
          (.then (fn [rows]
                   (first rows))))) )

  (store-put [_ entity-type _k record]
    (let [q      (get-in query-registry [entity-type :upsert])
          params (or (get-in query-registry [entity-type :upsert-params])
                     identity)]
      (.unsafe sql q (clj->js (params record)))))

  (store-delete [_ entity-type k]
    (let [q (get-in query-registry [entity-type :delete])]
      (.unsafe sql q #js [k])))

  (store-list [_ entity-type]
    (let [q (get-in query-registry [entity-type :select-all])]
      (.unsafe sql q #js [])))

  (store-close [_]
    (.end sql)))
