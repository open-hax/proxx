;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-law-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.auth.oidc-law :as law]
            [proxx.auth.oidc-runtime :as runtime]
            [proxx.extern.oidc-client :as io]))

(def config {:issuer "https://axxium.promethean.rest/oidc" :clientId "proxx-stealth"
             :publicOrigin "https://proxx.example"})
(def session-binding {:issuer (:issuer config) :subject "CaseSensitiveActor" :user-id "local-1"
              :expires-at 200000})
(def evidence {:active true :client_id (:clientId config) :sub (:subject session-binding)
               :scope "openid profile" :exp 200})
(def links [{:issuer (:issuer config) :subject (:subject session-binding) :userId "local-1"}])

(deftest qualified-explicit-account-links-only
  (is (= "local-1" (law/linked-user-id links (:issuer config) (:subject session-binding))))
  (is (nil? (law/linked-user-id links "https://other.example/oidc" (:subject session-binding))))
  (is (nil? (law/linked-user-id links (:issuer config) "casesensitiveactor")))
  (is (nil? (law/linked-user-id links (:issuer config) "same-email@example.com")))
  (is (nil? (law/linked-user-id (conj links (first links)) (:issuer config) (:subject session-binding))))
  (is (false? (law/links-valid? (:issuer config) (conj links (first links)))))
  (is (false? (law/links-valid? (:issuer config) [{:issuer (:issuer config) :subject "x"}]))))

(deftest current-client-scoped-evidence-is-mandatory
  (is (law/grant-admitted? config session-binding evidence 100000))
  (doseq [invalid [(assoc evidence :active false)
                   (dissoc evidence :active) (dissoc evidence :client_id)
                   (assoc evidence :client_id "knoxx-stealth")
                   (assoc evidence :iss "https://attacker.example/oidc")
                   (assoc evidence :aud "other-client")
                   (assoc evidence :sub "another-actor")
                   (assoc evidence :scope "profile")
                   (assoc evidence :exp 100) (dissoc evidence :exp)]]
    (is (not (law/grant-admitted? config session-binding invalid 100000))))
  (is (not (law/grant-admitted? config session-binding evidence 200000)))
  (is (not (law/grant-admitted? config (assoc session-binding :issuer "other") evidence 100000)))
  (is (not (law/grant-admitted? config nil evidence 100000))))

(deftest state-is-browser-bound-expiring-and-one-use
  (let [state (runtime/create-state)
        tx {:state "random-state" :binding (io/digest "browser") :created-at 1000}]
    (swap! (:transactions state) assoc "random-state" tx)
    (is (= tx (runtime/consume! state "random-state" "browser" 1001)))
    (is (nil? (runtime/consume! state "random-state" "browser" 1001)))
    (doseq [[browser now] [[nil 1001] ["other-browser" 1001] ["browser" 301000] ["browser" 999]]]
      (swap! (:transactions state) assoc "random-state" tx)
      (is (nil? (runtime/consume! state "random-state" browser now)))
      (is (nil? (runtime/consume! state "random-state" "browser" 1001))))))

(deftest local-resource-attribution-and-current-membership
  (let [user {:id "local-1" :subject "legacy-owner" :email "irrelevant@example.com"}
        memberships [{:tenantId "tenant-1" :tenantStatus "active" :role "viewer"}]
        auth (law/local-context user memberships session-binding)]
    (is (= "legacy-owner" (:subject auth)))
    (is (= "local-1" (:userId auth)))
    (is (= "viewer" (:role auth)))
    (is (= "tenant-1" (:tenantId auth)))
    (is (= {:issuer (:issuer config) :subject (:subject session-binding)} (:oidc auth)))
    (is (nil? (law/local-context user [] session-binding)))
    (is (nil? (law/local-context (assoc user :id "collision") memberships session-binding)))
    (is (nil? (law/local-context user [(assoc (first memberships) :tenantStatus "disabled")] session-binding)))
    (is (nil? (law/local-context user [(assoc (first memberships) :role "remote-admin")] session-binding)))))

(deftest fixed-origin-csrf-and-no-implicit-node-enrollment
  (is (law/csrf-admitted? config "POST" "https://proxx.example"))
  (doseq [origin [nil "https://attacker.example" "https://proxx.example.attacker.example"]]
    (is (not (law/csrf-admitted? config "POST" origin))))
  (doseq [path ["/api/ui/federation/bridge/ws" "/api/v1/federation/bridge/sse" "/api/ui/bridge/lease" "/api/ui/federation/bridges/lease/import"
                "/api/v1/federation/bridges/lease/import"]]
    (is (law/node-enrollment-path? path)))
  (is (not (law/node-enrollment-path? "/api/v1/federation/observability/sse"))))

(deftest strict-fixed-configuration
  (let [raw (assoc config :clientSecret "fixture-only" :linksJson "[]")]
    (is (= "https://proxx.example/api/auth/axxium/callback" (:callback (io/require-config! raw))))
    (doseq [bad [(assoc raw :publicOrigin "https://proxx.example/path")
                 (assoc raw :publicOrigin "https://proxx.example?redirect=evil")
                 (assoc raw :issuer "http://axxium.example/oidc")
                 (assoc raw :issuer "https://user:secret@axxium.example/oidc")
                 (assoc raw :clientSecret "")
                 (assoc raw :allowUnauthenticated true)]]
      (is (thrown? js/Error (io/require-config! bad))))))

(deftest current-transport-never-retains-a-withdrawn-local-capability
  (let [context {:userId "local-1" :subject "legacy-owner" :tenantId "t" :role "admin"
                 :memberships [{:tenantId "t" :role "admin"}]}]
    (is (law/transport-context-current? context context))
    (is (not (law/transport-context-current? context (assoc context :role "viewer"))))
    (is (not (law/transport-context-current? context (assoc context :memberships []))))))

(deftest tenant-selection-and-callback-refusals
  (is (law/tenant-admitted? {:memberships [{:tenantId "local"}]} "local"))
  (is (not (law/tenant-admitted? {:memberships [{:tenantId "local"}]} "remote")))
  (is (= 400 (:status (law/callback-failure "OAUTH_JWT_CLAIM_COMPARISON_FAILED"))))
  (is (= 503 (:status (law/callback-failure "network failure")))))
