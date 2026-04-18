(ns proxx.pipeline
  (:require [proxx.cache-policy :as cp]
            [proxx.store.protocol :as store]))

(defn make-pipeline
  [{:keys [hot redis lmdb postgres]}]
  {:stores {:hot      hot
            :redis    redis
            :lmdb     lmdb
            :postgres postgres}})

(defn store-for [pipeline store-key]
  (get-in pipeline [:stores store-key]))

(defn route!
  "Write a record through the write-through chain defined by cache policy.
   Assumes record already validated and provenance-stamped."
  [pipeline entity-type record]
  (let [policy      (get cp/policies entity-type)
        write-chain (:write-through policy [:postgres])
        k           (or (:id record)
                        (:prompt-cache-key record)
                        (:provider-id record))]
    ;; always write hot cache first
    (store/store-put (store-for pipeline :hot) entity-type k record)
    ;; then follow declared chain
    (doseq [store-key write-chain]
      (when-let [s (store-for pipeline store-key)]
        (store/store-put s entity-type k record)))
    record))

(defn fetch!
  "Read a record through the read-order chain.
   On cache miss, back-fill upstream layers."
  [pipeline entity-type k]
  (let [policy     (get cp/policies entity-type)
        read-chain (:read-order policy [:postgres])
        full-chain (cons :hot read-chain)]
    (loop [remaining full-chain]
      (when-let [store-key (first remaining)]
        (let [s (store-for pipeline store-key)
              v (when s (store/store-get s entity-type k))]
          (if v
            (do
              ;; backfill earlier caches
              (doseq [backfill-key (take-while #(not= % store-key) full-chain)]
                (when-let [bs (store-for pipeline backfill-key)]
                  (store/store-put bs entity-type k v)))
              v)
            (recur (rest remaining)))))))
