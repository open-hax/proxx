(ns proxx.cache-policy)

;; Cache policy by entity type.
;; Drivers are policy-blind; they consult this data via the pipeline.

(def policies
  {:provider
   {:redis-ttl-s   300
    :lmdb-ttl-s    3600
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :provider-model
   {:redis-ttl-s   300
    :lmdb-ttl-s    3600
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :prompt-affinity
   {:redis-ttl-s   120
    :lmdb-ttl-s    900
    :write-through [:redis :lmdb :postgres]
    :read-order    [:redis :lmdb :postgres]}

   :pheromone-state
   {:redis-ttl-s   60
    :lmdb-ttl-s    300
    :write-through [:redis :lmdb]
    :read-order    [:redis :lmdb]}

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
