;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.relay
  "JOSE, HTTP, websocket lifecycle and native-data adapters for relay laws."
  (:require ["jose" :as jose]
            ["node:crypto" :as crypto]
            [clojure.string :as str]
            [proxx.auth.relay-law :as law]))

(defn- now [] (/ (.now js/Date) 1000))
(defn- refuse! [] (throw (ex-info "Scoped relay authorization refused" {})))
(defn- decode [value] (js->clj value :keywordize-keys true))
(defn- request-body [body-text]
  (try (when (seq body-text) (decode (js/JSON.parse body-text)))
       (catch :default _ (refuse!))))

(defn- https! [value origin?]
  (let [url (js/URL. value)]
    (when-not (and (= "https:" (.-protocol url))
                   (= "" (.-username url)) (= "" (.-password url))
                   (= "" (.-search url)) (= "" (.-hash url))
                   (or (not origin?) (= value (.-origin url))))
      (refuse!)))
  value)

(defn- require-config! [config]
  (https! (:issuer config) false)
  (https! (:audience config) true)
  (when-not (and (= "/oidc" (.-pathname (js/URL. (:issuer config))))
                 (law/nodes-valid? (:nodes config))) (refuse!))
  config)

(defn- jwks [config]
  ;; Fixed configured issuer, never JWT jku/x5u/discovery-selected endpoints.
  (jose/createRemoteJWKSet (js/URL. (str (:issuer config) "/jwks"))
    #js {:timeoutDuration 3000 :cooldownDuration 1000 :cacheMaxAge 30000}))

(defn ^:async verify!
  "Verify signature first, then pure scope/time/node/owner contracts. The optional
   resolver is a synthetic-key fixture seam, not an environment trust override."
  [config resolver token]
  (try
    (when-not (and (string? token) (<= 1 (count token) 16384)) (refuse!))
    (let [^js verified (await (jose/jwtVerify token resolver
                          #js {:issuer (:issuer config) :audience (:audience config)
                               :algorithms #js ["RS256"] :typ "axxium-relay+jwt"
                               :clockTolerance law/max-future-seconds
                               :requiredClaims #js ["iss" "sub" "aud" "jti" "iat" "exp"]}))
          claims (decode (.-payload verified))]
      (when-not (law/claims-admitted? config claims (decode (.-protectedHeader verified)) (now)) (refuse!))
      claims)
    (catch :default _ (refuse!))))

(defn- digest [text]
  (.digest (.update (.createHash crypto "sha256") (or text "") "utf8") "hex"))

(defn- delegations []
  ;; Operator-owned configuration only, reread on request. No positive auth cache.
  (let [entries (decode (js/JSON.parse (or (.-AXXIUM_RELAY_DELEGATIONS (.-env js/process)) "[]")))]
    (when-not (law/delegations-valid? entries) (refuse!))
    (doseq [entry entries] (https! (:issuer entry) false))
    entries))

(defn capability-js
  "A session owns a mutable verified generation. Async verification and durable
   consumption must both complete before compare-and-set advances its deadline."
  [initial verify-token! consume-lease! consume-rpc!]
  (let [state (atom initial)
        active? (atom true)
        current! (fn [] (let [claims @state]
                          (when-not (and @active? (< (now) (:exp claims))) (refuse!)) claims))
        scope! (fn [request body-text]
                 (let [claims (current!) shaped (decode request) body (request-body body-text)]
                   (when-not (law/request-scope-admitted? claims shaped body (now)) (refuse!))))
        capability
        #js {:ownerSubject (law/qualified-owner (:iss initial) (:sub initial))
             :nodeId (:node_id initial)
             :close (fn [] (reset! active? false))
             :assertActive (fn [] (current!) nil)
             :assertHello (fn [hello] (when-not (law/hello-admitted? (current!) (decode hello) (now)) (refuse!)))
             :assertRequest (fn [request body-text]
                              (when-not (law/rpc-admitted? (current!) (decode request) (request-body body-text) (now)) (refuse!)))
             :assertDelivery scope!
             :bindRequest (fn [request body-text tenant auth]
                            (let [claims (current!) shaped (decode request) body (request-body body-text)
                                  actor-identity (law/auth-identity (delegations) (decode auth) (now))
                                  owner (when (:issuer actor-identity) (law/qualified-owner (:issuer actor-identity) (:subject actor-identity)))
                                  session {:ownerSubject (law/qualified-owner (:iss claims) (:sub claims))
                                           :authKind "axxium_node" :agentId (:node_id claims) :allowedTenants (:allowed_tenants claims)}
                                  dispatch (law/rpc-binding claims shaped body (digest body-text) (.randomUUID crypto) tenant (js/Math.floor (now)))
                                  bound (assoc shaped :relayBinding dispatch)]
                              (when-not (and (law/session-routable? session (decode auth) owner tenant (delegations)
                                                                   (:model body) (str (:method shaped) " " (:path shaped)) (now))
                                             (law/binding-admitted? claims bound body (digest body-text) (now))) (refuse!))
                              (clj->js dispatch)))
             :renew (fn ^:async renew [authorization predecessor]
                      (let [previous (current!)]
                        (when-not (and (string? authorization) (str/starts-with? authorization "Bearer ")) (refuse!))
                        (let [fresh (await (verify-token! (subs authorization 7)))]
                          (when-not (law/renewal-admitted? previous fresh predecessor (now)) (refuse!))
                          (when (and consume-lease! (not (true? (await (consume-lease! (:iss fresh) (:jti fresh) (:exp fresh)))))) (refuse!))
                          (when-not (and @active? (law/renewal-admitted? @state fresh predecessor (now))
                                         (compare-and-set! state previous fresh)) (refuse!)))))
             :execute (fn ^:async execute [request body-text handler signal]
                        (let [claims (current!) shaped (decode request) body (request-body body-text)]
                          (when-not (and (fn? consume-rpc!)
                                         (law/binding-admitted? claims shaped body (digest body-text) (now))
                                         (not (.-aborted signal))) (refuse!))
                          ;; Only hashes/nonce and time enter the existing durable SQL gate.
                          ;; Separate replay namespace from connection jtis and other nodes.
                          (when-not (true? (await (consume-rpc! (str "rpc:" (pr-str [(:iss claims) (:aud claims) (:node_id claims)]))
                                                               (get-in shaped [:relayBinding :nonce])
                                                               (+ law/rpc-clock-bound-seconds (get-in shaped [:relayBinding :expiresAt]))))) (refuse!))
                          ;; A close, renewal, narrowing or cancel while SQL was pending cannot execute.
                          (when-not (and (not (.-aborted signal))
                                         (law/binding-admitted? (current!) shaped body (digest body-text) (now))) (refuse!))
                          (if (= "/v1/models" (:path shaped))
                            #js {:status 200 :headers #js {"content-type" "application/json"}
                                 :body (js/JSON.stringify
                                         (clj->js {:object "list" :data (mapv (fn [id] {:id id :object "model"}) (:allowed_models (current!)))}))}
                            (await (handler #js {:request (clj->js (-> shaped
                                                                     (assoc :headers (law/safe-headers (:headers shaped)))
                                                                     (dissoc :requestContext :routingIntent :relayBinding)))
                                                 :bodyText body-text :signal signal})))))
             :headers (fn [headers] (clj->js (law/safe-headers (decode headers))))
             :capabilities (fn [capabilities] (clj->js (law/restrict-capabilities (current!) (decode capabilities))))}]
    (js/Object.defineProperties capability
      #js {:expiresAt #js {:get (fn [] (* 1000 (:exp @state)))}
           :leaseId #js {:get (fn [] (:jti @state))}
           :allowedTenants #js {:get (fn [] (clj->js (:allowed_tenants @state)))}})
    capability))

(defn create-broker-js
  "Create only with explicit trust and durable replay storage. No native auth or
   HTTP account endpoint consumes this capability. No memory-only replay fallback."
  [raw-config consume!]
  (let [config (require-config! (decode raw-config)) resolver (jwks config)]
    (when-not (fn? consume!) (refuse!))
    #js {:admit (fn ^:async admit [authorization]
                  (try
                    (when-not (and (string? authorization) (str/starts-with? authorization "Bearer ")) (refuse!))
                    (let [claims (await (verify! config resolver (subs authorization 7)))]
                      (when-not (true? (await (consume! (:iss claims) (:jti claims) (:exp claims)))) (refuse!))
                      ;; The store may block; never admit an expired lease afterward.
                      (when-not (< (now) (:exp claims)) (refuse!))
                      #js {:authKind "axxium_node" :subject (:sub claims) :relay (capability-js claims #(verify! config resolver %) consume! nil)})
                    (catch :default _ (refuse!))))}))

(defn env-broker-js "Decode operator broker configuration; no implicit trust defaults." [consume!]
  (let [env (.-env js/process)]
    (when (or (.-AXXIUM_RELAY_ISSUER env) (.-AXXIUM_RELAY_AUDIENCE env) (.-AXXIUM_RELAY_NODES env))
      (create-broker-js #js {:issuer (.-AXXIUM_RELAY_ISSUER env)
                             :audience (.-AXXIUM_RELAY_AUDIENCE env)
                             :nodes (js/JSON.parse (or (.-AXXIUM_RELAY_NODES env) "null"))} consume!))))

(defn- node-config! [config relay-url]
  (require-config! config)
  (let [url (js/URL. relay-url)]
    (when-not (and (= "wss:" (.-protocol url)) (= law/ws-path (.-pathname url))
                   (= "" (.-search url)) (= "" (.-hash url))
                   (= "" (.-username url)) (= "" (.-password url))
                   (= (:audience config) (str "https://" (.-host url)))
                   (string? (:secret config)) (<= 32 (count (:secret config)) 512)
                   (= 1 (count (:nodes config)))) (refuse!)))
  config)

(defn- ^:async request-lease! [config resolver]
  (try
    (let [node (first (:nodes config))
          url (str (.-origin (js/URL. (:issuer config))) "/api/federation/relay-lease")
          response (await (js/fetch url
                            #js {:method "POST" :redirect "error"
                                 :signal (.timeout js/AbortSignal 3000)
                                 :headers #js {"content-type" "application/json"}
                                 :body (js/JSON.stringify #js {:node-id (:nodeId node) :secret (:secret config)})}))]
      (when-not (.-ok response) (refuse!))
      (let [text (await (.text response))]
        (when (> (count text) 32768) (refuse!))
        (let [token (.-lease (js/JSON.parse text)) claims (await (verify! config resolver token))]
          {:token token :claims claims})))
    (catch :default _ (refuse!))))

(defn node-options-js
  "Scoped mode has no global-token fallback. Obtain and verify a NEW one-use lease
   before EACH websocket. Keep the local execution handler and credentials local."
  [raw-config ^js options consume!]
  (let [config (node-config! (decode raw-config) (.-relayUrl options))
        resolver (jwks config)
        _ (when-not (fn? consume!) (refuse!))
        node (first (:nodes config))
        owner (law/qualified-owner (:issuer config) (:subject node))]
    (js/Object.assign #js {} options
      #js {:authorization js/undefined :ownerSubject owner :agentId (:nodeId node)
           :clusterId (or (.-clusterId options) "operator-relay")
           :peerDid (str "operator-node:" (:nodeId node)) :authMode "axxium_node"
           :renewConnection (fn ^:async renew-connection []
                              (let [{:keys [token]} (await (request-lease! config resolver))]
                                (str "Bearer " token)))
           :prepareConnection
           (fn ^:async prepare []
             (let [{:keys [token claims]} (await (request-lease! config resolver))]
               #js {:authorization (str "Bearer " token) :relay (capability-js claims #(verify! config resolver %) nil consume!)}))})))

(defn env-node-options-js "Select scoped node transport only from complete operator configuration." [options consume!]
  (let [env (.-env js/process)]
    (if (or (.-AXXIUM_RELAY_NODE_ID env) (.-AXXIUM_RELAY_NODE_SECRET env)
            (.-AXXIUM_RELAY_NODE_ISSUER env) (.-AXXIUM_RELAY_NODE_SUBJECT env)
            (.-AXXIUM_RELAY_NODE_AUDIENCE env))
      (node-options-js #js {:issuer (.-AXXIUM_RELAY_NODE_ISSUER env)
                            :audience (.-AXXIUM_RELAY_NODE_AUDIENCE env)
                            :nodes #js [#js {:nodeId (.-AXXIUM_RELAY_NODE_ID env) :subject (.-AXXIUM_RELAY_NODE_SUBJECT env)}]
                            :secret (.-AXXIUM_RELAY_NODE_SECRET env)} options consume!)
      options)))

(defn qualified-owner-js "Resolve a qualified owner only from current server-owned authentication." [auth]
  (let [actor-identity (law/auth-identity (delegations) (decode auth) (now))]
    (when (and (law/bounded-string? (:issuer actor-identity) 2048) (law/bounded-string? (:subject actor-identity) 128))
      (law/qualified-owner (:issuer actor-identity) (:subject actor-identity)))))

(defn session-routable-js "Apply current tenant and delegation contracts at the TS transport boundary." [session auth owner tenant model operation]
  (boolean (law/session-routable? (decode session) (decode auth) owner tenant (delegations) model operation (now))))

(defn failure-terminal-js
  "Expose the pure replay refusal decision to the transport orchestrator."
  [session dispatch-attempted?]
  (boolean (law/failure-terminal? (decode session) dispatch-attempted?)))
