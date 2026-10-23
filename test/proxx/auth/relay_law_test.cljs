;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.relay-law-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.auth.relay-law :as law]))

(def config {:issuer "https://authority.example/oidc" :audience "https://broker.example"
             :nodes [{:nodeId "synthetic-node" :subject "synthetic-actor"}]})
(def claims {:iss (:issuer config) :aud (:audience config) :sub "synthetic-actor"
             :node_id "synthetic-node" :jti "once" :iat 100 :exp 125
             :scope "proxx:relay" :allowed_models ["test-model"] :grant_revision "rev"})
(def header {:alg "RS256" :typ "axxium-relay+jwt"})

(deftest claims-refuse-confused-authority
  (is (law/claims-admitted? config claims header 100))
  (doseq [bad [(assoc claims :iss "https://evil.example/oidc") (assoc claims :aud [(:audience config)])
               (assoc claims :scope "openid proxx:relay") (assoc claims :node_id "other")
               (assoc claims :sub "other") (dissoc claims :sub) (assoc claims :exp 126)
               (assoc claims :iat 102) (assoc claims :exp 100) (dissoc claims :jti)
               (assoc claims :allowed_models ["*"]) (assoc claims :allowed_models [])]]
    (is (not (law/claims-admitted? config bad header 100))))
  (is (not (law/claims-admitted? config claims (assoc header :typ "JWT") 100)))
  (is (not (law/claims-admitted? config claims (assoc header :alg "HS256") 100)))
  (is (not (law/claims-admitted? config claims header 125))))

(deftest hello-and-rpc-boundaries
  (let [hello {:agentId "synthetic-node" :ownerSubject (law/qualified-owner (:iss claims) (:sub claims))
               :authMode "axxium_node"}]
    (is (law/hello-admitted? claims hello 100))
    (is (not (law/hello-admitted? claims (assoc hello :agentId "other") 100)))
    (is (not (law/hello-admitted? claims (assoc hello :ownerSubject "synthetic-actor") 100)))
    (is (not (law/hello-admitted? claims hello 125))))
  (is (law/rpc-admitted? claims {:method "GET" :path "/v1/models"} nil 100))
  (doseq [path law/inference-paths]
    (is (law/rpc-admitted? claims {:method "POST" :path path} {:model "test-model"} 100)))
  (doseq [path ["/v1/models?full=1" "/v1/responses/123" "/v1/chat/completions/../models"
                "https://host/v1/models" "/api/bridge/credentials/export" "/api/ui/settings"]]
    (is (not (law/rpc-admitted? claims {:method "GET" :path path} nil 100))))
  (is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "forbidden"} 100)))
  (is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "test-model" :background true} 100)))
  (is (not (law/rpc-admitted? claims {:method "POST" :path "/v1/responses"} {:model "test-model"} 125))))

(deftest qualified-node-routing
  (let [owner (law/qualified-owner (:issuer config) "synthetic-actor")
        session {:ownerSubject owner :authKind "axxium_node"}
        auth {:kind "ui_session" :oidc {:issuer (:issuer config) :subject "synthetic-actor"}}]
    (is (law/session-routable? session auth owner "local-tenant"))
    (is (not (law/session-routable? session (assoc auth :kind "legacy_admin") owner "local-tenant")))
    (is (not (law/session-routable? session (dissoc auth :oidc) owner "local-tenant")))
    (is (not (law/session-routable? session auth "other-owner" "local-tenant")))
    (is (not (law/session-routable? session auth owner nil)))
    (is (not (law/session-routable? (assoc session :authKind "ui_session" :tenantId "other") auth owner "local-tenant")))))
