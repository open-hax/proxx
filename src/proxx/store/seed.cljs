(ns proxx.store.seed
  (:require [cljs.reader :as edn]
            [proxx.store.protocol :refer [IStore store-get store-put store-delete store-list store-close]]))

;; ══════════════════════════════════════════════════════════════
;; Seed store — EDN files at boot
;; ══════════════════════════════════════════════════════════════
;; This store is read-only at runtime; writes are handled by
;; the boot process via Postgres.

(defrecord SeedStore [seed-data]
  IStore
  (store-get [_ entity-type _k]
    ;; seed is by-entity full snapshot; keyed lookups are not supported here
    (get seed-data entity-type))

  (store-put [_ _entity-type _k _record]
    nil)

  (store-delete [_ _entity-type _k]
    nil)

  (store-list [_ entity-type]
    (get seed-data entity-type))

  (store-close [_]
    nil))
