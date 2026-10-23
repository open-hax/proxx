;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.relay-law
  "Pure machine capability admission. No remote roles or caller-selected owners."
  (:require [clojure.set :as set]))

(def max-lease-seconds "Fixed production lease maximum." 25)
(def max-future-seconds "Maximum future lease issuance skew." 1)
(def ws-path "Only scoped enrollment websocket route." "/api/ui/federation/bridge/ws")
(def inference-paths "Exact synchronous inference paths." #{"/v1/chat/completions" "/v1/responses" "/v1/embeddings"})
(def rpc-paths "Closed scoped RPC route set." (conj inference-paths "/v1/models"))

(defn bounded-string? "Require a nonempty bounded string." [value maximum]
  (and (string? value) (<= 1 (count value) maximum)))

(defn models-valid? "Require unique exact model names with bounded aggregate size." [models]
  (and (vector? models) (<= 1 (count models) 128)
       (= (count models) (count (set models)))
       (every? #(and (string? %) (boolean (re-matches #"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}" %))) models)
       (<= (reduce + (map count models)) 4096)))

(defn tenants-valid? "Nonempty exact broker-local tenant ids; no implicit scope." [tenants]
  (and (vector? tenants) (<= 1 (count tenants) 64)
       (= (count tenants) (count (set tenants)))
       (every? #(bounded-string? % 256) tenants)))

(defn nodes-valid? "Closed operator broker node and subject pins." [nodes]
  (and (vector? nodes) (<= 1 (count nodes) 64)
       (= (count nodes) (count (set (map :nodeId nodes))))
       (every? #(and (= #{:nodeId :subject} (set (keys %)))
                     (bounded-string? (:nodeId %) 64)
                     (bounded-string? (:subject %) 128)) nodes)))

(defn qualified-owner "Portable unambiguous issuer-qualified subject." [issuer subject]
  ;; Length prefix is unambiguous even if subject contains separators.
  (str "axxium:" (count issuer) ":" issuer ":" subject))

(defn claims-admitted? "Admit only pinned signed scope, actor-identity, lifetime and explicit tenants." [config claims header now]
  (let [{:keys [iss sub aud node_id jti iat exp scope allowed_models allowed_tenants grant_revision]} claims]
    (and (= "RS256" (:alg header)) (= "axxium-relay+jwt" (:typ header))
         (= (:issuer config) iss) (= (:audience config) aud)
         (= "proxx:relay" scope)
         (bounded-string? sub 128) (bounded-string? node_id 64)
         (some #(and (= node_id (:nodeId %)) (= sub (:subject %))) (:nodes config))
         (bounded-string? jti 128) (bounded-string? grant_revision 128)
         (integer? iat) (integer? exp) (<= (- exp iat) max-lease-seconds)
         (< iat exp) (<= iat (+ now max-future-seconds)) (< now exp)
         (models-valid? allowed_models) (tenants-valid? allowed_tenants))))

(defn hello-admitted? "Bind the protocol actor-identity and topology to the verified lease." [claims hello now]
  (and (< now (:exp claims))
       (= (:node_id claims) (:agentId hello))
       ;; bridge-ws-v0 calls its bridge identifier agentId, not bridgeId.
       (= (qualified-owner (:iss claims) (:sub claims)) (:ownerSubject hello))
       (= "axxium_node" (:authMode hello))
       (every? #(= (:node_id claims) (:nodeId %)) (get-in hello [:topology :nodes]))
       (every? #(every? #{(:node_id claims)} (:nodeIds %)) (get-in hello [:topology :groups]))))

(defn rpc-admitted? "Allow only exact foreground inference or empty-body catalog reads." [claims request body now]
  (and (< now (:exp claims))
       (or (and (= "GET" (:method request)) (= "/v1/models" (:path request))
                (nil? body))
           (and (= "POST" (:method request)) (contains? inference-paths (:path request))
                (map? body) (contains? (set (:allowed_models claims)) (:model body))
                ;; Cross-node routing and arbitrary remote background execution
                ;; have no meaning under this local inference capability.
                (or (not (contains? body :background)) (false? (:background body)))))))

(defn restrict-capabilities "Advertise only signed models and nonexportable bounded RPC routes." [claims capabilities]
  (mapv (fn [capability]
          (assoc capability :modelPrefixes [] :models (:allowed_models claims)
                 :paths (vec rpc-paths) :routes (vec rpc-paths)
                 :supportsWarmImport false :credentialMobility "non_exportable"))
        capabilities))

(defn safe-headers "Allow only noncredential inference headers." [headers]
  (select-keys headers [:accept :content-type]))

(defn renewal-admitted?
  "A renewal must extend a live predecessor, with the same actor-identity and no widening.
   A changed revision is admissible only for strict scope narrowing. The predecessor
   jti binds async verification to the exact current generation."
  [previous fresh predecessor now]
  (and (< now (:exp previous)) (< now (:exp fresh))
       (= predecessor (:jti previous)) (not= (:jti previous) (:jti fresh))
       (every? #(= (get previous %) (get fresh %)) [:iss :sub :aud :node_id :scope])
       (<= (:iat previous) (:iat fresh)) (< (:exp previous) (:exp fresh))
       (set/subset? (set (:allowed_models fresh)) (set (:allowed_models previous)))
       (set/subset? (set (:allowed_tenants fresh)) (set (:allowed_tenants previous)))
       (= (= (:grant_revision fresh) (:grant_revision previous))
          (and (= (set (:allowed_models fresh)) (set (:allowed_models previous)))
               (= (set (:allowed_tenants fresh)) (set (:allowed_tenants previous)))))))

(def delegation-keys "Closed operator delegation fields."
  #{:keyId :tenantId :issuer :subject :nodeIds :models :operations :expiresAt})
(def operations "Exact supported RPC operations." #{"POST /v1/chat/completions" "POST /v1/responses" "POST /v1/embeddings" "GET /v1/models"})

(defn delegations-valid? "Validate finite, explicit key-to-actor delegations." [entries]
  (and (vector? entries) (<= (count entries) 128)
       (= (count entries) (count (set (map (juxt :keyId :tenantId) entries))))
       (every? (fn [entry]
                 (and (= delegation-keys (set (keys entry)))
                      (every? #(bounded-string? (get entry %) 256) [:keyId :tenantId :subject])
                      (bounded-string? (:issuer entry) 2048)
                      (vector? (:nodeIds entry)) (<= 1 (count (:nodeIds entry)) 64)
                      (= (count (:nodeIds entry)) (count (set (:nodeIds entry))))
                      (every? #(bounded-string? % 64) (:nodeIds entry))
                      (models-valid? (:models entry))
                      (vector? (:operations entry)) (seq (:operations entry))
                      (every? operations (:operations entry))
                      (integer? (:expiresAt entry)) (pos? (:expiresAt entry)))) entries)))

(defn delegation-for
  "Only a current server SQL-resolved key/tenant pair may acquire an operator actor-identity."
  [entries auth now]
  (when (and (= "tenant_api_key" (:kind auth)) (contains? (set (:scopes auth)) "proxy:use"))
    (some #(when (and (= (:keyId auth) (:keyId %)) (= (:tenantId auth) (:tenantId %))
                      (< now (:expiresAt %))) %) entries)))

(defn auth-identity "Resolve only verified browser actor-identity or an operator-bound current SQL key." [entries auth now]
  (if (= "ui_session" (:kind auth))
    (:oidc auth)
    (select-keys (delegation-for entries auth now) [:issuer :subject])))

(defn session-routable?
  "Tenant ids are broker-local grant scope; actor-identity alone conveys no machine right.
   Native bridges keep their pre-existing owner/tenant dispatch."
  [session auth owner tenant entries model operation now]
  (and (= (:ownerSubject session) owner)
       (if (= "axxium_node" (:authKind session))
         (let [actor-identity (auth-identity entries auth now)
               delegation (delegation-for entries auth now)]
           (and (= (:tenantId auth) tenant)
                (contains? (set (:allowedTenants session)) tenant)
                (bounded-string? (:issuer actor-identity) 2048) (bounded-string? (:subject actor-identity) 128)
                (= owner (qualified-owner (:issuer actor-identity) (:subject actor-identity)))
                (or (= "ui_session" (:kind auth))
                    (and delegation (contains? (set (:nodeIds delegation)) (:agentId session))
                         (contains? (set (:operations delegation)) operation)
                         (or (= operation "GET /v1/models") (contains? (set (:models delegation)) model))))))
         (= (:tenantId session) tenant))))

(def rpc-validity-seconds "Maximum dispatch envelope validity." 120)
(def rpc-clock-bound-seconds "Replay tombstone clock margin." 5)
(def binding-keys "Closed exact dispatch dispatch fields."
  #{:version :nonce :method :path :model :bodyDigest :actor :tenant :node :audience :issuer :grantRevision :issuedAt :expiresAt})

(defn request-scope-admitted? "Recheck current model, tenant, owner and node before delivery." [claims request body now]
  (and (rpc-admitted? claims request body now)
       (= (qualified-owner (:iss claims) (:sub claims)) (:ownerSubject request))
       (= (:node_id claims) (:agentId request))
       (contains? (set (:allowed_tenants claims)) (get-in request [:relayBinding :tenant]))))

(defn rpc-binding
  "The broker supplies nonce and actor-identity. Digest is SHA-256 over exact UTF-8 body
   bytes, without JSON reserialization. GET uses the empty string. Query forbidden."
  [claims request body digest nonce tenant issued]
  {:version 1 :nonce nonce :method (:method request) :path (:path request) :model (:model body)
   :bodyDigest digest :actor (qualified-owner (:iss claims) (:sub claims)) :tenant tenant
   :node (:node_id claims) :audience (:aud claims) :issuer (:iss claims)
   :grantRevision (:grant_revision claims) :issuedAt issued :expiresAt (+ issued rpc-validity-seconds)})

(defn binding-admitted? "Match every signed grant and immutable dispatch component before consumption." [claims request body digest now]
  (let [dispatch (:relayBinding request)]
    (and (= binding-keys (set (keys dispatch)))
         (= 1 (:version dispatch))
         (string? digest) (boolean (re-matches #"[0-9a-f]{64}" digest))
         (string? (:nonce dispatch))
         (boolean (re-matches #"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" (:nonce dispatch)))
         (integer? (:issuedAt dispatch)) (integer? (:expiresAt dispatch))
         (= rpc-validity-seconds (- (:expiresAt dispatch) (:issuedAt dispatch)))
         (<= (:issuedAt dispatch) (+ now rpc-clock-bound-seconds)) (< now (:expiresAt dispatch))
         (request-scope-admitted? claims request body now)
         (= dispatch (rpc-binding claims request body digest (:nonce dispatch) (:tenant dispatch) (:issuedAt dispatch))))))

(defn failure-terminal?
  "Once a scoped dispatch is attempted, uncertain/completed effects may not fall
   through to another node or provider. Native bridge retry semantics are unchanged."
  [session dispatch-attempted?]
  (and (= "axxium_node" (:authKind session)) (true? dispatch-attempted?)))
