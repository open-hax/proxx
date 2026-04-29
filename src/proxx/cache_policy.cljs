(ns proxx.cache-policy)

;; ══════════════════════════════════════════════════════════════
;; Cache policy as data
;; ══════════════════════════════════════════════════════════════
;; This namespace encodes read/write behavior for each entity type.
;; Drivers do not embed policy; they consult this map.

(def policies
  {:provider
   {:redis-ttl-s   300        ;; 5 min in redis
    :lmdb-ttl-s    3600       ;; 1 hr warm buffer
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :provider-model
   {:redis-ttl-s   300
    :lmdb-ttl-s    3600
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :prompt-affinity
   {:redis-ttl-s   120        ;; hot routing data
    :lmdb-ttl-s    900        ;; 15 min warm buffer
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :pheromone-state
   {:redis-ttl-s   60         ;; very hot, short-lived
    :lmdb-ttl-s    300
    :write-through [:redis :lmdb]   ;; projected from events, not written to postgres
    :read-order    [:redis :lmdb]}  ;; backing truth is event log

   :routing-policy
   {:redis-ttl-s   600
    :lmdb-ttl-s    7200
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :affinity-policy
   {:redis-ttl-s   600
    :lmdb-ttl-s    7200
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}})
