;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.relay-law
  "Pure machine capability admission. No remote roles or caller-selected owners.")

(def max-lease-seconds 25)
(def max-future-seconds 1)
(def ws-path "/api/ui/federation/bridge/ws")
(def inference-paths #{"/v1/chat/completions" "/v1/responses" "/v1/embeddings"})
(def rpc-paths (conj inference-paths "/v1/models"))

(defn bounded-string? [value maximum]
  (and (string? value) (<= 1 (count value) maximum)))

(defn models-valid? [models]
  (and (vector? models) (<= 1 (count models) 128)
       (= (count models) (count (set models)))
       (every? #(and (string? %) (boolean (re-matches #"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}" %))) models)
       (<= (reduce + (map count models)) 4096)))

(defn nodes-valid? [nodes]
  (and (vector? nodes) (<= 1 (count nodes) 64)
       (= (count nodes) (count (set (map :nodeId nodes))))
       (every? #(and (= #{:nodeId :subject} (set (keys %)))
                     (bounded-string? (:nodeId %) 64)
                     (bounded-string? (:subject %) 128)) nodes)))

(defn qualified-owner [issuer subject]
  ;; Length prefix is unambiguous even if subject contains separators.
  (str "axxium:" (count issuer) ":" issuer ":" subject))

(defn claims-admitted? [config claims header now]
  (let [{:keys [iss sub aud node_id jti iat exp scope allowed_models grant_revision]} claims]
    (and (= "RS256" (:alg header)) (= "axxium-relay+jwt" (:typ header))
         (= (:issuer config) iss) (= (:audience config) aud)
         (= "proxx:relay" scope)
         (bounded-string? sub 128) (bounded-string? node_id 64)
         (some #(and (= node_id (:nodeId %)) (= sub (:subject %))) (:nodes config))
         (bounded-string? jti 128) (bounded-string? grant_revision 128)
         (integer? iat) (integer? exp) (<= (- exp iat) max-lease-seconds)
         (< iat exp) (<= iat (+ now max-future-seconds)) (< now exp)
         (models-valid? allowed_models))))

(defn hello-admitted? [claims hello now]
  (and (< now (:exp claims))
       (= (:node_id claims) (:agentId hello))
       ;; bridge-ws-v0 calls its bridge identifier agentId, not bridgeId.
       (= (qualified-owner (:iss claims) (:sub claims)) (:ownerSubject hello))
       (= "axxium_node" (:authMode hello))
       (every? #(= (:node_id claims) (:nodeId %)) (get-in hello [:topology :nodes]))
       (every? #(every? #{(:node_id claims)} (:nodeIds %)) (get-in hello [:topology :groups]))))

(defn rpc-admitted? [claims request body now]
  (and (< now (:exp claims))
       (or (and (= "GET" (:method request)) (= "/v1/models" (:path request))
                (or (nil? body) (= {} body)))
           (and (= "POST" (:method request)) (contains? inference-paths (:path request))
                (map? body) (contains? (set (:allowed_models claims)) (:model body))
                ;; Cross-node routing and arbitrary remote background execution
                ;; have no meaning under this local inference capability.
                (not (true? (:background body)))))))

(defn restrict-capabilities [claims capabilities]
  (mapv (fn [capability]
          (assoc capability :modelPrefixes [] :models (:allowed_models claims)
                 :paths (vec rpc-paths) :routes (vec rpc-paths)
                 :supportsWarmImport false :credentialMobility "non_importable"))
        capabilities))

(defn safe-headers [headers]
  (select-keys headers [:accept :content-type]))

(defn session-routable?
  "A node belongs to a verified Axxium person, not a broker tenant. Only that
   qualified person's already-admitted local session may route to it. Native
   bridges retain their owner AND tenant binding during migration."
  [session auth owner tenant]
  (and (= (:ownerSubject session) owner)
       (if (= "axxium_node" (:authKind session))
         (let [identity (:oidc auth)]
           (and (= "ui_session" (:kind auth)) identity
                (bounded-string? tenant 256)
                (= owner (qualified-owner (:issuer identity) (:subject identity)))))
         (= (:tenantId session) tenant))))
