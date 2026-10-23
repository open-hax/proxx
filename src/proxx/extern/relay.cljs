;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.relay
  "JOSE, HTTP, websocket lifecycle and native-data adapters for relay laws."
  (:require [clojure.string :as str]
            [proxx.auth.relay-law :as law]
            ["jose" :as jose]))

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

(defn capability-js
  "Opaque qualified capability. All semantic decisions stay behind this boundary."
  [claims]
  #js {:ownerSubject (law/qualified-owner (:iss claims) (:sub claims))
       :nodeId (:node_id claims) :expiresAt (* 1000 (:exp claims))
       :assertActive (fn [] (when-not (< (now) (:exp claims)) (refuse!)))
       :assertHello (fn [hello] (when-not (law/hello-admitted? claims (decode hello) (now)) (refuse!)))
       :assertRequest (fn [request body-text]
                        (let [body (request-body body-text)]
                          (when-not (law/rpc-admitted? claims (decode request) body (now)) (refuse!))))
       :execute (fn ^:async execute [request body-text handler signal]
                  (let [shaped (decode request)
                        body (request-body body-text)]
                    (when-not (and (= (law/qualified-owner (:iss claims) (:sub claims)) (:ownerSubject shaped))
                                   (law/rpc-admitted? claims shaped body (now))) (refuse!))
                    (if (= "/v1/models" (:path shaped))
                      #js {:status 200 :headers #js {"content-type" "application/json"}
                           :body (js/JSON.stringify
                                   (clj->js {:object "list" :data (mapv (fn [id] {:id id :object "model"}) (:allowed_models claims))}))}
                      (await (handler #js {:request (clj->js (-> shaped
                                                                                (assoc :headers (law/safe-headers (:headers shaped)))
                                                                                (dissoc :requestContext :routingIntent)))
                                           :bodyText body-text :signal signal})))))
       :headers (fn [headers] (clj->js (law/safe-headers (decode headers))))
       :capabilities (fn [capabilities] (clj->js (law/restrict-capabilities claims (decode capabilities))))})

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
                      #js {:authKind "axxium_node" :subject (:sub claims) :relay (capability-js claims)})
                    (catch :default _ (refuse!))))}))

(defn env-broker-js [consume!]
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
  [raw-config ^js options]
  (let [config (node-config! (decode raw-config) (.-relayUrl options))
        resolver (jwks config)
        node (first (:nodes config))
        owner (law/qualified-owner (:issuer config) (:subject node))]
    (js/Object.assign #js {} options
      #js {:authorization js/undefined :ownerSubject owner :agentId (:nodeId node)
           :clusterId (or (.-clusterId options) "operator-relay")
           :peerDid (str "operator-node:" (:nodeId node)) :authMode "axxium_node"
           :prepareConnection
           (fn ^:async prepare []
             (let [{:keys [token claims]} (await (request-lease! config resolver))]
               #js {:authorization (str "Bearer " token) :relay (capability-js claims)}))})))

(defn env-node-options-js [options]
  (let [env (.-env js/process)]
    (if (or (.-AXXIUM_RELAY_NODE_ID env) (.-AXXIUM_RELAY_NODE_SECRET env)
            (.-AXXIUM_RELAY_NODE_ISSUER env) (.-AXXIUM_RELAY_NODE_SUBJECT env)
            (.-AXXIUM_RELAY_NODE_AUDIENCE env))
      (node-options-js #js {:issuer (.-AXXIUM_RELAY_NODE_ISSUER env)
                            :audience (.-AXXIUM_RELAY_NODE_AUDIENCE env)
                            :nodes #js [#js {:nodeId (.-AXXIUM_RELAY_NODE_ID env) :subject (.-AXXIUM_RELAY_NODE_SUBJECT env)}]
                            :secret (.-AXXIUM_RELAY_NODE_SECRET env)} options)
      options)))

(defn qualified-owner-js [auth]
  (when-let [oidc (:oidc (decode auth))]
    (when (and (law/bounded-string? (:issuer oidc) 2048) (law/bounded-string? (:subject oidc) 128))
      (law/qualified-owner (:issuer oidc) (:subject oidc)))))

(defn session-routable-js [session auth owner tenant]
  (boolean (law/session-routable? (decode session) (decode auth) owner tenant)))
