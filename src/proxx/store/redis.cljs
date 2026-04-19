(ns proxx.store.redis
  (:require [cljs.reader :as edn]
            [proxx.cache-policy :as cp]
            [proxx.store.protocol :refer [IStore store-get store-put store-delete store-list store-close]]
            [clojure.string :as str]))

;; ══════════════════════════════════════════════════════════════
;; Redis store (ioredis client)
;; ══════════════════════════════════════════════════════════════

(defn- cache-key [entity-type k]
  (str (name entity-type) ":" k))

(defrecord RedisStore [client]
  IStore
  (store-get [_ entity-type k]
    (.then (.get client (cache-key entity-type k))
           (fn [s]
             (when s (edn/read-string s)))) )

  (store-put [_ entity-type k record]
    (let [ttl (get-in cp/policies [entity-type :redis-ttl-s] 300)]
      (.setex client (cache-key entity-type k) ttl (pr-str record))))

  (store-delete [_ entity-type k]
    (.del client (cache-key entity-type k)))

  (store-list [_ entity-type]
    ;; scan by prefix — for diagnostics, not hot path
    (.then (.keys client (str (name entity-type) ":*"))
           (fn [ks]
             (js/Promise.all
              (map (fn [k]
                     (.then (.get client k)
                            (fn [s]
                              (when s (edn/read-string s)))))
                   ks)))))

  (store-close [_]
    (.quit client)))
