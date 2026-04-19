(ns proxx.store.lmdb
  (:require [cljs.reader :as edn]
            [proxx.cache-policy :as cp]
            [proxx.store.protocol :refer [IStore]]))

;; ══════════════════════════════════════════════════════════════
;; LMDB store — warm buffer
;; ══════════════════════════════════════════════════════════════

(defrecord LmdbStore [env dbs]
  IStore
  (store-get [_ entity-type k]
    (let [db  (get @dbs entity-type)
          raw (.get db k)]
      (when raw
        (let [r (edn/read-string raw)]
          (when (or (nil? (:__expires-at r))
                    (< (.now js/Date) (:__expires-at r)))
            (dissoc r :__expires-at))))))

  (store-put [_ entity-type k record]
    (let [db  (get @dbs entity-type)
          ttl (get-in cp/policies [entity-type :lmdb-ttl-s] 3600)
          exp (+ (.now js/Date) (* ttl 1000))]
      (.put db k (pr-str (assoc record :__expires-at exp)))))

  (store-delete [_ entity-type k]
    (let [db (get @dbs entity-type)]
      (.remove db k)))

  (store-list [_ entity-type]
    (let [db (get @dbs entity-type)
          now (.now js/Date)]
      (->> (seq db)
           (keep (fn [[_ v]]
                   (let [r (edn/read-string v)]
                     (when (or (nil? (:__expires-at r))
                               (< now (:__expires-at r)))
                       (dissoc r :__expires-at))))))))

  (store-close [_]
    (.close env)))
