(ns proxx.runtime.events
  "JS facade over the pure event modules for the TypeScript EventStore and its
  labeler classes. Conversions drop `undefined` object fields (JSON semantics)
  so absent and null stay distinguishable in the pure core."
  (:require [proxx.events.labelers :as labelers]
            [proxx.events.store :as store]))

(defn- ->wire [x]
  (cond
    (undefined? x) nil
    (array? x) (mapv ->wire x)
    (object? x) (reduce (fn [m k] (let [v (aget x k)] (if (undefined? v) m (assoc m k (->wire v)))))
                        {} (js-keys x))
    :else x))

(defn- ->js [m] (clj->js m))

(defn event-labeler-applies-js [id event] (labelers/applies? id (->wire event)))
(defn event-labeler-label-js [id event] (to-array (labelers/label id (->wire event))))

(defn event-ddl-js [] (to-array store/ddl))

(defn- filters->wire [^js filters]
  (let [w (->wire filters)]
    (cond-> w
      (some? (get w "since")) (assoc "since" (.toISOString (.-since filters)))
      (some? (get w "until")) (assoc "until" (.toISOString (.-until filters))))))

(defn event-build-query-js [filters] (->js (store/build-query (filters->wire filters))))
(defn event-build-count-js [filters] (->js (store/build-count (filters->wire filters))))
(defn event-count-by-tag-query-js [^js since] (->js (store/count-by-tag-query (when since (.toISOString since)))))

(defn event-parse-row-js [row]
  (let [r (store/parse-row (reduce (fn [m k] (assoc m k (let [v (aget row k)] (if (undefined? v) nil v)))) {} (js-keys row))
                           js/JSON.parse
                           {"tags" #js [] "meta" #js {}})
        o #js {}]
    (doseq [k ["id" "kind" "entryId" "providerId" "accountId" "model" "status" "tags" "meta" "payload" "payloadBytes"]]
      (when (contains? r k) (aset o k (get r k))))
    (aset o "ts" (let [ts (get r "ts")] (if (string? ts) (js/Date. ts) ts)))
    o))

(defn- json-bytes [payload]
  (js/Buffer.byteLength (js/JSON.stringify (clj->js payload)) "utf8"))

(defn event-sanitize-payload-js [payload]
  (->js (store/sanitize-payload (->wire payload) json-bytes)))
