(ns proxx.store.hot
  (:require [proxx.store.protocol :refer [IStore store-get store-put store-delete store-list store-close]]))

;; ══════════════════════════════════════════════════════════════
;; Hot in-process cache (per-process atom)
;; ══════════════════════════════════════════════════════════════

(defrecord HotCache [state-atom]
  IStore
  (store-get [_ entity-type k]
    (get-in @state-atom [entity-type k]))

  (store-put [_ entity-type k v]
    (swap! state-atom assoc-in [entity-type k] v)
    nil)

  (store-delete [_ entity-type k]
    (swap! state-atom update entity-type dissoc k)
    nil)

  (store-list [_ entity-type]
    (vals (get @state-atom entity-type)))

  (store-close [_]
    (reset! state-atom {})))
