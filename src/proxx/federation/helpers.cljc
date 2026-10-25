(ns proxx.federation.helpers
  "Pure decisions behind federation request handling: peer credentials, hop
  counts, and who a request is acting for.

  Headers arrive as the raw header value (string or repeated-header vector);
  `request-auth` is the wire map {\"kind\" \"subject\" \"tenantId\"}. Anything
  environmental (the default owner subject) is an argument."
  (:require [clojure.string :as str]
            [proxx.http.request :as request]))

(def hop-header "x-open-hax-federation-hop")
(def owner-subject-header "x-open-hax-federation-owner-subject")
(def bridge-tenant-header "x-open-hax-bridge-tenant-id")
(def forced-provider-header "x-open-hax-forced-provider")
(def forced-account-id-header "x-open-hax-forced-account-id")
(def routed-peer-header "x-open-hax-federation-routed-peer")
(def routed-provider-header "x-open-hax-federation-routed-provider")
(def routed-account-header "x-open-hax-federation-routed-account")
(def imported-header "x-open-hax-federation-imported")

(def blocked-response-headers
  "Headers a peer's response may never set on ours: cookies and every
  federation control header."
  #{"set-cookie" hop-header owner-subject-header routed-peer-header routed-provider-header
    routed-account-header imported-header forced-provider-header forced-account-id-header})

(defn- trimmed [x] (when (string? x) (str/trim x)))

(defn extract-peer-credential
  "The peer's `credential`, else its `bearer`, trimmed; nil when neither is a non-blank string."
  [auth]
  (or (not-empty (trimmed (get auth "credential")))
      (not-empty (trimmed (get auth "bearer")))))

(defn- parse-int-prefix
  "JavaScript's parseInt(s, 10): optional sign and leading digits, NaN otherwise."
  [s]
  #?(:cljs (js/parseInt s 10)
     :clj (if-let [[_ digits] (re-find #"^\s*([+-]?\d+)" s)] (parse-long digits) ##NaN)))

(defn hop-count
  "Hops already travelled, from the raw hop header; 0 for absent, malformed or negative."
  [raw-header]
  (let [raw (not-empty (trimmed (request/single-header-value raw-header)))
        n (when raw (parse-int-prefix raw))]
    (if (and n (== n n) (< n ##Inf) (>= n 0)) n 0)))

(defn- tenant-api-key-bound-owner
  "The DID a tenant API key is bound to, via its tenant id or its
  `tenant_api_key:<did>` subject; nil for any other credential kind."
  [request-auth]
  (when (= "tenant_api_key" (get request-auth "kind"))
    (let [tenant-id (trimmed (get request-auth "tenantId"))
          subject (trimmed (get request-auth "subject"))
          prefix "tenant_api_key:"]
      (cond
        (and tenant-id (str/starts-with? tenant-id "did:")) tenant-id
        (and subject (str/starts-with? subject prefix))
        (let [bound (str/trim (subs subject (count prefix)))]
          (when (and (seq bound) (str/starts-with? bound "did:")) bound))))))

(defn owner-subject
  "The owner a request acts for, or nil when none can be established.

  An explicit owner header is honoured only when the caller may assert it: on
  a federated hop, as the legacy admin, or as a tenant key bound to that very
  owner. A tenant key naming any other owner is refused outright."
  [{:keys [header request-auth hop-count default-owner-subject]}]
  (let [explicit (not-empty (trimmed (request/single-header-value header)))
        bound (tenant-api-key-bound-owner request-auth)
        kind (get request-auth "kind")]
    (cond
      (and explicit (or (pos? (or hop-count 0)) (= "legacy_admin" kind) (= bound explicit))) explicit
      (and explicit (= "tenant_api_key" kind)) nil
      (= "tenant_api_key" kind) bound
      :else (let [subject (trimmed (get request-auth "subject"))]
              (cond
                (and (seq subject) (not= "legacy:proxy-auth-token" subject)) subject
                (= "legacy_admin" kind) (not-empty (trimmed default-owner-subject)))))))

;; ---------------------------------------------------------------------------
;; fetchFederationJson: the request to send and the verdict on the answer
;; ---------------------------------------------------------------------------

(defn json-request-headers
  "Headers for a federation JSON call: always JSON, bearer when a credential is given."
  [credential]
  (cond-> {"content-type" "application/json"}
    (and (string? credential) (seq credential)) (assoc "authorization" (str "Bearer " credential))))

(defn failure-message
  "Message for a non-2xx federation reply: the peer's own `error` string, else the status."
  [error-field status]
  (if (string? error-field) error-field (str "request failed with " status)))
