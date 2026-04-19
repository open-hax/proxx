(ns proxx.store.seed
  (:require [proxx.store.protocol :refer [IStore]]))

;; ══════════════════════════════════════════════════════════════
;; Seed store — EDN files at boot
;; ══════════════════════════════════════════════════════════════
;; This store is read-only at runtime; writes are handled by
;; the boot process via Postgres.

(defrecord SeedStore [seed-data]
  IStore
  (store-get [_ entity-type k]
    (let [coll (get seed-data entity-type)]
      (if (nil? k)
        coll
        (first (filter #(= (:id %) k) coll)))))

  (store-put [_ _entity-type _k _record]
    nil)

  (store-delete [_ _entity-type _k]
    nil)

  (store-list [_ entity-type]
    (get seed-data entity-type))

  (store-close [_]
    nil))
