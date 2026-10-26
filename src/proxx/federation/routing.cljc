(ns proxx.federation.routing
  "Decisions inside federated and bridged request routing, over facts the
  TypeScript edge has already fetched (sessions, peers, projected accounts,
  headers). The edge keeps Fastify, fetch and the SQL store; it asks these
  functions what to do. Ordering of projected accounts and tenant-provider
  authorization are not here: proxx.policy owns them.

  Inputs are wire maps (string-keyed, JS `undefined` already dropped)."
  (:require [clojure.string :as str]
            [proxx.federation.helpers :as helpers]
            [proxx.federation.owner :as owner]))

(defn- trimmed [x] (when (string? x) (str/trim x)))
(defn- lower-trim [x] (some-> (trimmed x) str/lower-case))

;; ---------------------------------------------------------------------------
;; Who is asking
;; ---------------------------------------------------------------------------

(def default-tenant-id "default")

(defn bridge-tenant-id
  "The tenant a bridged request runs under: the auth's own, else `default` for the legacy admin."
  [request-auth]
  (let [tenant-id (get request-auth "tenantId")]
    (if (some? tenant-id)
      tenant-id
      (when (= "legacy_admin" (get request-auth "kind")) default-tenant-id))))

(defn subject-did
  "The DID a request is made on behalf of: the auth subject if it is one, else its tenant id."
  [request-auth]
  (let [subject (get request-auth "subject")
        tenant-id (get request-auth "tenantId")]
    (cond
      (and (string? subject) (owner/at-did? subject)) (str/trim subject)
      (and (string? tenant-id) (owner/at-did? tenant-id)) (str/trim tenant-id))))

(defn hop-limit-exceeded?
  "A request that already crossed a federation hop is never forwarded again."
  [hop-count]
  (>= hop-count 1))

;; ---------------------------------------------------------------------------
;; Bridge relay routing
;; ---------------------------------------------------------------------------

(defn normalized-path
  "The path part of an upstream path (query dropped)."
  [upstream-path]
  (first (str/split upstream-path #"\?" 2)))

(defn allowed-provider-ids
  "Lower-cased, trimmed, non-empty provider ids a request is restricted to."
  [provider-ids]
  (into #{} (comp (map #(str/lower-case (str/trim %))) (remove empty?)) provider-ids))

(defn session-eligible?
  "May a request for `owner-subject`/`tenant-id` be offered to this relay session at all?
  The session must be connected, belong to the owner and tenant, and either not have reported
  health yet or report a healthy upstream with accounts."
  [session owner-subject tenant-id]
  (and (= "connected" (get session "state"))
       (= owner-subject (get session "ownerSubject"))
       (= tenant-id (get session "tenantId"))
       (let [health (get session "health")]
         (or (nil? health)
             (and (= true (get health "upstreamHealthy")) (pos? (get health "availableAccountCount")))))))

(defn capability-admissible?
  "May this advertised capability be considered at all: its provider is in the allowed set (when one
  is given) and it still has an available account? Path and model support (proxx.routing.bridge)
  and tenant policy are asked separately."
  [capability allowed-ids]
  (let [provider-id (str/lower-case (str/trim (get capability "providerId")))]
    (and (or (empty? allowed-ids) (contains? allowed-ids provider-id))
         (pos? (get capability "availableAccountCount")))))

(defn event-stream-content-type? [content-type]
  (and (string? content-type) (str/includes? (str/lower-case content-type) "text/event-stream")))

(defn json-content-type? [content-type]
  (and (string? content-type) (str/includes? (str/lower-case content-type) "application/json")))

(defn response-content-type
  "The content type of a bridged response head, tolerating either header spelling."
  [headers]
  (let [v (or (get headers "content-type") (get headers "Content-Type"))]
    (if (nil? v) "" v)))

(defn routed-peer-label [cluster-id agent-id] (str "bridge:" cluster-id ":" agent-id))

;; ---------------------------------------------------------------------------
;; Serving a request that arrived over the bridge
;; ---------------------------------------------------------------------------

(def allowed-bridge-paths
  ["/v1/chat/completions" "/v1/models" "/v1/responses" "/v1/embeddings" "/v1/images/generations"
   "/api/bridge/credentials/accounts" "/api/bridge/credentials/providers" "/api/bridge/credentials/export"])

(defn bridge-pathname
  "Pathname of a bridged request path as a URL parser would resolve it (so `..`
  segments and doubled slashes cannot sneak past the allow-list)."
  [path]
  #?(:cljs (.-pathname (js/URL. (normalized-path path) "http://x"))
     :clj (normalized-path path)))

(defn bridge-path-allowed? [path]
  (boolean (some #{(bridge-pathname path)} allowed-bridge-paths)))

(def bridge-forbidden-body
  {"error" {"message" "Bridge requests are restricted to model API paths" "type" "invalid_request_error"}})

(defn bridge-request-headers
  "Headers for the in-process request a bridged call becomes. A dedicated bridge
  identity marker stands in for the admin token, so a bridge is never a privileged proxy."
  [{:keys [accept content-type owner-subject tenant-id]}]
  (cond-> {"accept" (or accept "application/json")
           "x-open-hax-bridge-auth" "internal"
           helpers/hop-header "1"
           helpers/owner-subject-header owner-subject}
    (seq (trimmed tenant-id)) (assoc helpers/bridge-tenant-header (str/trim tenant-id))
    (string? content-type) (assoc "content-type" content-type)))

(defn utf8-chunk-encoding?
  "Can a response with this content type travel as UTF-8 text (else base64)?"
  [content-type]
  (let [n (str/lower-case (str/trim (or content-type "")))]
    (boolean (or (empty? n) (str/starts-with? n "text/")
                 (some #(str/includes? n %) ["json" "xml" "javascript" "event-stream"])))))

;; ---------------------------------------------------------------------------
;; Federated (peer-to-peer) routing
;; ---------------------------------------------------------------------------

(defn local-provider-ids [route-provider-ids]
  (into #{} (map #(str/lower-case (str/trim %))) route-provider-ids))

(defn local-account-key
  "Key of a locally held account. Unlike a peer reply's key, the account id is not trimmed."
  [provider-id account-id]
  (str (str/lower-case (str/trim provider-id)) "\u0000" account-id))

(defn active-peer? [peer] (= "active" (lower-trim (get peer "status"))))

(defn forwarded-request-overrides
  "Headers set on the request forwarded to a peer, replacing whatever the client sent."
  [credential hop-count owner-subject projected-account]
  {"authorization" (str "Bearer " credential)
   helpers/hop-header (str (inc hop-count))
   helpers/owner-subject-header owner-subject
   helpers/forced-provider-header (get projected-account "providerId")
   helpers/forced-account-id-header (get projected-account "accountId")})

(defn copyable-response-header?
  "Peer response headers we may pass on: never cookies or federation control headers."
  [name]
  (not (contains? helpers/blocked-response-headers (str/lower-case name))))

(defn routed-response-headers
  "Headers describing how a request was routed, set on the reply."
  [owner-subject peer-id projected-account imported?]
  (cond-> {helpers/owner-subject-header owner-subject
           helpers/routed-peer-header peer-id
           helpers/routed-provider-header (get projected-account "providerId")
           helpers/routed-account-header (get projected-account "accountId")}
    imported? (assoc helpers/imported-header "true")))

(defn warm-import-allowed?
  "Warm import is allowed unless a tenant-provider policy is present and does not authorize it
  (legacy federation behavior: no policy, no constraint)."
  [policy-present? policy-authorizes?]
  (if policy-present? (boolean policy-authorizes?) true))

(defn export-urls
  "Where to ask a peer for a credential export: the v1 path, then the legacy UI path."
  [peer]
  (let [base (or (get peer "controlBaseUrl") (get peer "baseUrl"))]
    [(str base "/api/v1/federation/accounts/export") (str base "/api/ui/federation/accounts/export")]))

(defn routed-diff-event
  "The ledger event recording that a projected account served a request."
  [projected-account imported?]
  {"ownerSubject" (get projected-account "ownerSubject")
   "entityType" "projected_account"
   "entityKey" (str (get projected-account "sourcePeerId") ":" (get projected-account "providerId") ":" (get projected-account "accountId"))
   "op" "note_routed"
   "payload" {"providerId" (get projected-account "providerId") "accountId" (get projected-account "accountId")
              "availabilityState" (get projected-account "availabilityState")
              "warmRequestCount" (get projected-account "warmRequestCount") "importedCredential" imported?}})
