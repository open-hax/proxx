(ns proxx.store.protocol)

;; ══════════════════════════════════════════════════════════════
;; Store protocol
;; ══════════════════════════════════════════════════════════════

(defprotocol IStore
  (store-get    [this entity-type key])
  (store-put    [this entity-type key record])
  (store-delete [this entity-type key])
  (store-list   [this entity-type])
  (store-close  [this]))
