(ns proxx.observability.fanout
  "Request-log fan-out as an immutable value with pure transitions.

  The WebSocket and SSE hubs both answer one question per ledger event: which
  subscribed clients may see this entry? Visibility (identity) and interest
  (subscription filter) are facts about the entry, the client and nothing else,
  so they live here; the sockets themselves stay at the edge and are keyed by an
  opaque client id.

  Entries and identities are string-keyed wire maps (\"routeKind\", \"tenantId\",
  \"federationOwnerSubject\", \"authKind\", \"ownerSubject\")."
  (:require [clojure.string :as str]))

(def ^:private route-kinds #{"local" "federated" "bridge" "routed" "any"})

(defn normalize-route-kind
  "Lower-cased route kind when it is one the filter understands, else nil."
  [value]
  (when (string? value)
    (let [n (str/lower-case (str/trim value))]
      (when (route-kinds n) n))))

(defn- trimmed-string [value]
  (if (string? value) (str/trim value) ""))

(defn entry-matches-subscription?
  "Does `entry` satisfy the client's route-kind and owner filters?"
  [entry subscription]
  (let [kind (normalize-route-kind (get subscription "routeKind"))
        entry-kind (get entry "routeKind")
        owner (trimmed-string (get subscription "ownerSubject"))]
    (and (case kind
           (nil "any") true
           "routed" (not= entry-kind "local")
           (= entry-kind kind))
         (or (empty? owner)
             (= (get entry "federationOwnerSubject") owner)))))

(defn entry-visible-to-identity?
  "Admins see everything; any other identity only sees its own tenant."
  [entry who]
  (or (= "legacy_admin" (get who "authKind"))
      (let [tenant (trimmed-string (get who "tenantId"))]
        (and (seq tenant)
             (= (get entry "tenantId") tenant)))))

(defn event-wire-type
  "Wire name of a store event type."
  [event-type]
  (if (= event-type "record") "request_log_record" "request_log_update"))

;; ---------------------------------------------------------------------------
;; Subscription state

(def empty-state {:next-seq 0 :clients {}})

(defn subscribe
  "Register `client-id`. Re-subscribing an id keeps its original position."
  [state client-id who subscription]
  (let [existing (get-in state [:clients client-id])
        seq-no (or (:seq existing) (:next-seq state))]
    (-> state
        (update :next-seq (if existing clojure.core/identity inc))
        (assoc-in [:clients client-id] {:seq seq-no :identity who :subscription subscription}))))

(defn unsubscribe [state client-id]
  (update state :clients dissoc client-id))

(defn client-count [state] (count (:clients state)))

(defn recipients
  "Client ids, in subscription order, that should receive `entry`."
  [state entry]
  (->> (:clients state)
       (filter (fn [[_ c]] (and (entry-visible-to-identity? entry (:identity c))
                                (entry-matches-subscription? entry (:subscription c)))))
       (sort-by (comp :seq val))
       (mapv key)))
