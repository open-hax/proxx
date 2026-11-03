(ns proxx.runtime.observability
  "Edge of the request-log hubs: one atom holding the immutable fan-out state,
  behind a JS facade the TypeScript hubs drive. Sockets never enter this
  namespace; the hubs keep them keyed by the ids registered here."
  (:require [proxx.observability.fanout :as fanout]))

(defn- pick [^js o & ks]
  (reduce (fn [m k] (let [v (aget o k)] (if (undefined? v) m (assoc m k v)))) {} ks))

(defn- entry->map [^js entry] (pick entry "routeKind" "federationOwnerSubject" "tenantId"))
(defn- identity->map [^js i] (pick i "authKind" "tenantId"))
(defn- subscription->map [^js s] (pick s "routeKind" "ownerSubject"))

(defn create-request-log-fanout-js
  "JS facade: {subscribe(id, identity, subscription), unsubscribe(id),
  recipients(entry) -> string[], size(), clear(), eventType(type)}."
  []
  (let [state (atom fanout/empty-state)]
    #js {:subscribe (fn [id identity subscription]
                      (swap! state fanout/subscribe id (identity->map identity) (subscription->map subscription))
                      nil)
         :unsubscribe (fn [id] (swap! state fanout/unsubscribe id) nil)
         :recipients (fn [entry] (to-array (fanout/recipients @state (entry->map entry))))
         :size (fn [] (fanout/client-count @state))
         :clear (fn [] (reset! state fanout/empty-state) nil)
         :eventType (fn [t] (fanout/event-wire-type t))}))
