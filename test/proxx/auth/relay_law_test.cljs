;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.relay-law-test
  (:require [cljs.test :as t]
            [proxx.auth.relay-law :as law]))

(def config "Synthetic config fixture." {:issuer "https://authority.example/oidc" :audience "https://broker.example"
             :nodes [{:nodeId "synthetic-node" :subject "synthetic-actor"}]})
(def claims "Synthetic claims fixture." {:iss (:issuer config) :aud (:audience config) :sub "synthetic-actor"
             :node_id "synthetic-node" :jti "once" :iat 100 :exp 125
             :scope "proxx:relay" :allowed_models ["test-model"] :allowed_tenants ["local-tenant"] :grant_revision "rev"})
(def header "Synthetic header fixture." {:alg "RS256" :typ "axxium-relay+jwt"})

(t/deftest claims-refuse-confused-authority
  (t/is (law/claims-admitted? config claims header 100))
  (doseq [bad [(assoc claims :iss "https://evil.example/oidc") (assoc claims :aud [(:audience config)])
               (assoc claims :scope "openid proxx:relay") (assoc claims :node_id "other")
               (assoc claims :sub "other") (dissoc claims :sub) (assoc claims :exp 126)
               (assoc claims :iat 102) (assoc claims :exp 100) (dissoc claims :jti)
               (assoc claims :allowed_models ["*"]) (assoc claims :allowed_models [])]]
    (t/is (not (law/claims-admitted? config bad header 100))))
  (t/is (not (law/claims-admitted? config claims (assoc header :typ "JWT") 100)))
  (t/is (not (law/claims-admitted? config claims (assoc header :alg "HS256") 100)))
  (t/is (not (law/claims-admitted? config claims header 125))))

(t/deftest hello-and-rpc-boundaries
  (let [hello {:agentId "synthetic-node" :ownerSubject (law/qualified-owner (:iss claims) (:sub claims))
               :authMode "axxium_node"}]
    (t/is (law/hello-admitted? claims hello 100))
    (t/is (not (law/hello-admitted? claims (assoc hello :agentId "other") 100)))
    (t/is (not (law/hello-admitted? claims (assoc hello :ownerSubject "synthetic-actor") 100)))
    (t/is (not (law/hello-admitted? claims hello 125))))
  (t/is (law/rpc-admitted? claims {:method "GET" :path "/v1/models"} nil 100))
  (doseq [path law/inference-paths]
    (t/is (law/rpc-admitted? claims {:method "POST" :path path} {:model "test-model"} 100)))
  (doseq [path ["/v1/models?full=1" "/v1/responses/123" "/v1/chat/completions/../models"
                "https://host/v1/models" "/api/bridge/credentials/export" "/api/ui/settings"]]
    (t/is (not (law/rpc-admitted? claims {:method "GET" :path path} nil 100))))
  (t/is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "forbidden"} 100)))
  (t/is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "test-model" :background true} 100)))
  (doseq [background ["true" 1 {} []]]
    (t/is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "test-model" :background background} 100))))
  (t/is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "test-model"} 125))))

(t/deftest qualified-node-routing
  (let [owner (law/qualified-owner (:issuer config) "synthetic-actor")
        session {:ownerSubject owner :authKind "axxium_node" :agentId "synthetic-node" :allowedTenants ["local-tenant"]}
        auth {:kind "ui_session" :tenantId "local-tenant" :oidc {:issuer (:issuer config) :subject "synthetic-actor"}}]
    (t/is (law/session-routable? session auth owner "local-tenant" [] "test-model" "POST /v1/responses" 100))
    (t/is (not (law/session-routable? session (assoc auth :kind "legacy_admin") owner "local-tenant" [] "test-model" "POST /v1/responses" 100)))
    (t/is (not (law/session-routable? session (dissoc auth :oidc) owner "local-tenant" [] "test-model" "POST /v1/responses" 100)))
    (t/is (not (law/session-routable? session auth "other-owner" "local-tenant" [] "test-model" "POST /v1/responses" 100)))
    (t/is (not (law/session-routable? session auth owner nil [] "test-model" "POST /v1/responses" 100)))
    (t/is (not (law/session-routable? (assoc session :authKind "ui_session" :tenantId "other") auth owner "local-tenant" [] "test-model" "POST /v1/responses" 100)))))

(t/deftest renewal-law
  (let [fresh (assoc claims :jti "next" :iat 110 :exp 135)]
    (t/is (law/renewal-admitted? claims fresh "once" 110))
    (doseq [bad [(assoc fresh :sub "other") (assoc fresh :node_id "other")
                 (assoc fresh :aud "other") (assoc fresh :iss "other")
                 (assoc fresh :jti "once") (assoc fresh :exp 125)
                 (assoc fresh :allowed_models ["test-model" "widened"])
                 (assoc fresh :allowed_tenants ["local-tenant" "wrong-tenant"])
                 (assoc fresh :grant_revision "mismatched")]]
      (t/is (not (law/renewal-admitted? claims bad "once" 110))))
    (t/is (not (law/renewal-admitted? claims fresh "superseded" 110)))
    (t/is (not (law/renewal-admitted? claims fresh "once" 125)))
    (t/is (law/renewal-admitted? (assoc claims :allowed_models ["test-model" "removed"])
                              (assoc fresh :grant_revision "narrower") "once" 110))))

(def delegation "Synthetic delegation fixture." {:keyId "sql-key" :tenantId "local-tenant" :issuer (:issuer config) :subject "synthetic-actor"
                 :nodeIds ["synthetic-node"] :models ["test-model"] :operations ["POST /v1/responses"] :expiresAt 200})

(t/deftest delegation-and-tenant-law
  (let [owner (law/qualified-owner (:issuer config) "synthetic-actor")
        session {:ownerSubject owner :authKind "axxium_node" :agentId "synthetic-node" :allowedTenants ["local-tenant"]}
        auth {:kind "tenant_api_key" :keyId "sql-key" :tenantId "local-tenant" :scopes ["proxy:use"]}]
    (t/is (law/delegations-valid? [delegation]))
    (t/is (not (law/delegations-valid? [(assoc delegation :secret "not-allowed")])) )
    (t/is (law/session-routable? session auth owner "local-tenant" [delegation] "test-model" "POST /v1/responses" 100))
    (doseq [bad [(assoc auth :keyId "wrong") (assoc auth :tenantId "wrong") (assoc auth :scopes []) (assoc auth :kind "legacy_admin")]]
      (t/is (not (law/session-routable? session bad owner "local-tenant" [delegation] "test-model" "POST /v1/responses" 100))))
    (doseq [[node model op t] [["other" "test-model" "POST /v1/responses" 100]
                              ["synthetic-node" "wrong" "POST /v1/responses" 100]
                              ["synthetic-node" "test-model" "POST /v1/embeddings" 100]
                              ["synthetic-node" "test-model" "POST /v1/responses" 200]]]
      (t/is (not (law/session-routable? (assoc session :agentId node) auth owner "local-tenant" [delegation] model op t))))
    (t/is (not (law/session-routable? session {:kind "ui_session" :tenantId "wrong" :oidc {:issuer (:issuer config) :subject "synthetic-actor"}}
                                   owner "wrong" [] "test-model" "POST /v1/responses" 100)))))

(t/deftest exact-rpc-binding-law
  (let [request {:method "POST" :path "/v1/responses" :agentId "synthetic-node"
                 :ownerSubject (law/qualified-owner (:iss claims) (:sub claims))}
        body {:model "test-model"}
        dispatch (law/rpc-binding claims request body (apply str (repeat 64 "a")) "a0000000-0000-4000-8000-000000000000" "local-tenant" 100)
        bound (assoc request :relayBinding dispatch)]
    (t/is (law/binding-admitted? claims bound body (apply str (repeat 64 "a")) 100))
    (t/is (not (law/binding-admitted? claims bound body "mutated-digest" 100)))
    (t/is (law/binding-admitted? (assoc claims :iat 210 :exp 235) bound body (apply str (repeat 64 "a")) 219))
    (t/is (not (law/binding-admitted? (assoc claims :iat 210 :exp 235) bound body (apply str (repeat 64 "a")) 220)))
    (doseq [[k v] [[:tenant "wrong"] [:actor "wrong"] [:node "wrong"] [:audience "wrong"]
                   [:issuer "wrong"] [:grantRevision "superseded"] [:method "GET"] [:path "/v1/responses?x=1"]
                   [:model "wrong"] [:issuedAt 106] [:expiresAt 221]]]
      (t/is (not (law/binding-admitted? claims (assoc-in bound [:relayBinding k] v) body (apply str (repeat 64 "a")) 100))))))

(t/deftest uncertain-effects-are-never-replayed
  (t/is (law/failure-terminal? {:authKind "axxium_node"} true))
  (t/is (not (law/failure-terminal? {:authKind "axxium_node"} false)))
  (t/is (not (law/failure-terminal? {:authKind "legacy_admin"} true))))
