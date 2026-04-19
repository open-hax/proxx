(ns proxx.store.postgres
  (:require [proxx.store.protocol :refer [IStore]]))

;; ══════════════════════════════════════════════════════════════
;; Postgres store — long-term truth
;; ══════════════════════════════════════════════════════════════
;; This driver is deliberately thin: it executes named queries from
;; a provided query-registry. No inline SQL lives here.

(defrecord PostgresStore [sql query-registry]
  IStore
  (store-get [_ entity-type k]
    (let [q (get-in query-registry [entity-type :select-one])]
      (.then (.unsafe sql q #js [k])
             (fn [rows]
               (first rows)))))

  (store-put [_ entity-type _k record]
    (let [q      (get-in query-registry [entity-type :upsert])
          params (get-in query-registry [entity-type :upsert-params])]
      (when-not (fn? params)
        (throw (ex-info "Missing or invalid :upsert-params in query-registry"
                        {:entity-type entity-type})))
      (let [pvec (vec (params record))]
        (.unsafe sql q (clj->js pvec)))))

  (store-delete [_ entity-type k]
    (let [q (get-in query-registry [entity-type :delete])]
      (.unsafe sql q #js [k])))

  (store-list [_ entity-type]
    (let [q (get-in query-registry [entity-type :select-all])]
      (.then (.unsafe sql q #js [])
             (fn [rows] rows))))

  (store-close [_]
    (.end sql)))
