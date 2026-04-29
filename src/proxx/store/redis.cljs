(ns proxx.store.redis
  (:require [cljs.reader :as edn]
            [proxx.cache-policy :as cp]
            [proxx.store.protocol :refer [IStore]]))

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
             (when s (edn/read-string s)))))

  (store-put [_ entity-type k record]
    (let [ttl (get-in cp/policies [entity-type :redis-ttl-s] 300)]
      (.setex client (cache-key entity-type k) ttl (pr-str record))))

  (store-delete [_ entity-type k]
    (.del client (cache-key entity-type k)))

  (store-list [_ entity-type]
    ;; Use SCAN to avoid blocking Redis with KEYS.
    (let [pattern (str (name entity-type) ":*")]
      (letfn [(scan-loop [cursor acc]
                (.then (.scan client cursor "MATCH" pattern "COUNT" 100)
                       (fn [[next-cursor keys]]
                         (let [acc' (into acc keys)]
                           (if (= "0" next-cursor)
                             (js/Promise.resolve acc')
                             (scan-loop next-cursor acc'))))))]
        (.then (scan-loop "0" [])
               (fn [keys]
                 (js/Promise.all
                  (map (fn [k]
                         (.then (.get client k)
                                (fn [s]
                                  (when s (edn/read-string s)))))
                       keys)))))))

  (store-close [_]
    (.quit client)))
