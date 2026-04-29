(ns proxx.store.protocol)

(defprotocol IStore
  (store-get    [this entity-type k])
  (store-put    [this entity-type k record])
  (store-delete [this entity-type k])
  (store-list   [this entity-type])
  (store-close  [this]))
