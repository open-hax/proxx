(ns proxx.http.federation-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.federation :as fed]))

(deftest authorize
  (is (= 401 (:status (fed/authorize nil))))
  (is (= 403 (:status (fed/authorize {"kind" "tenant_api_key"}))))
  (is (= 403 (:status (fed/authorize {"kind" "ui_session" "role" "viewer"}))))
  (is (nil? (fed/authorize {"kind" "ui_session" "role" "admin"})))
  (is (nil? (fed/authorize {"kind" "legacy_admin"}))))

(deftest peer-and-lease-bodies
  (is (= 400 (get-in (fed/peer-input {"ownerCredential" "c" "label" " "}) [:response :status])))
  (is (= {:owner-credential "c" :label "L" :base-url "u"} (fed/peer-input {"ownerCredential" " c " "label" "L" "baseUrl" " u "})))
  (is (= "provider_id_required" (get-in (fed/lease-import-request {}) [:response :body "error"])))
  (let [r (fed/lease-import-request {"providerId" " p " "limit" 1e9 "refreshBufferMs" -1 "forceApiKeys" "yes" "agentId" " a "})]
    (is (= "p" (:provider-id r)))
    (is (= 5000 (:limit r)))
    (is (= 0 (:refresh-buffer-ms r)))
    (is (false? (:force-api-keys? r)) "only literal true forces")
    (is (= "a" (:agent-id r))))
  (is (= 600000 (:refresh-buffer-ms (fed/lease-import-request {"providerId" "p"}))))
  (is (= "/api/bridge/credentials/accounts?providerId=a%20b&limit=3" (fed/lease-list-path "a b" 3))))

(deftest sessions-visibility
  (let [ss [{:session-id "s1" :agent-id "a1" :tenant-id "t1"} {:session-id "s2" :agent-id "a2" :tenant-id "t2"}]]
    (is (= ss (fed/visible-sessions {"kind" "legacy_admin"} ss)))
    (is (= [(first ss)] (fed/visible-sessions {"kind" "ui_session" "tenantId" "t1"} ss)))
    (is (= "s1" (:session-id (fed/find-session {"kind" "legacy_admin"} ss "s1" "a2"))) "session id wins over agent id")
    (is (= "s2" (:session-id (fed/find-session {"kind" "legacy_admin"} ss "" "a2"))))
    (is (nil? (fed/find-session {"kind" "ui_session" "tenantId" "t1"} ss "s2" "")))
    (is (nil? (fed/find-session {"kind" "legacy_admin"} ss "" "")))))

(deftest lease-planning
  (let [remote [{"accountId" "k" "authType" "api_key"} {"accountId" "o" "authType" "oauth_bearer"} {"accountId" "n" "authType" "oauth_bearer"}]]
    (testing "api keys only when missing (or forced); oauth when missing, unknown or expiring"
      (is (= ["n"] (map #(get % "accountId") (fed/lease-to-import remote {"k" nil "o" 5000000} 1000 100 false))))
      (is (= ["k" "n"] (map #(get % "accountId") (fed/lease-to-import remote {"k" nil "o" 5000000} 1000 100 true))))
      (is (= ["o" "n"] (map #(get % "accountId") (fed/lease-to-import remote {"k" 1 "o" 1050} 1000 100 false)))))))

(deftest credential-mobility
  (is (fed/projected-allows-credential-import? {"metadata" {}}))
  (is (not (fed/projected-allows-credential-import? {"metadata" {"credentialMobility" "descriptor_only"}})))
  (is (not (fed/projected-allows-credential-import? {"metadata" {"authType" "oauth_bearer"}})))
  (is (fed/projected-allows-credential-import? {"metadata" {"authType" "oauth_bearer" "credentialMobility" " access_token_only "}}))
  (testing "explicit non-exportable wins over an oauth lease"
    (is (not (fed/projected-allows-credential-import? {"metadata" {"authType" "oauth_bearer" "credentialMobility" "local_only"}}))))
  (is (= :skip (fed/import-all-action {"availabilityState" "imported" "metadata" {}} nil 0)))
  (is (= :fail (fed/import-all-action {"availabilityState" "descriptor" "metadata" {"credentialMobility" "non_exportable"}} nil 0)))
  (let [lease {"availabilityState" "imported" "metadata" {"authType" "oauth_bearer" "credentialMobility" "access_token_only"}}]
    (is (= :skip (fed/import-all-action lease (+ 1000000 600001) 1000)))
    (is (= :import (fed/import-all-action lease 1000 1000)))))

(deftest export-refresh
  (let [acct {"providerId" " OpenAI " "expiresAt" 1050 "refreshToken" "rt"}]
    (is (fed/export-needs-refresh? acct 1000 "openai" true))
    (is (not (fed/export-needs-refresh? acct 1000 "openai" false)))
    (is (not (fed/export-needs-refresh? (assoc acct "refreshToken" "  ") 1000 "openai" true)))
    (is (not (fed/export-needs-refresh? (assoc acct "expiresAt" 100000) 1000 "openai" true)))
    (is (not (fed/export-needs-refresh? acct 1000 "other" true)))))

(deftest usage-entry-sanitizing
  (let [row {"id" " e " "providerId" "p" "accountId" "a" "model" "m" "upstreamMode" "chat" "upstreamPath" "/x"
             "timestamp" 5 "status" 200 "latencyMs" 3}]
    (is (nil? (fed/sanitize-usage-entry (dissoc row "model"))))
    (is (nil? (fed/sanitize-usage-entry (assoc row "status" "200"))))
    (is (nil? (fed/sanitize-usage-entry 5)))
    (let [e (fed/sanitize-usage-entry (assoc row "authType" "weird" "routeKind" "bridge" "promptTokens" "9" "totalTokens" 9
                                             "cacheHit" true "promptCacheKeyUsed" "yes" "tenantId" 5))]
      (is (= "e" (get e "id")))
      (is (= "none" (get e "authType")))
      (is (= "bridge" (get e "routeKind")))
      (is (not (contains? e "promptTokens")) "a numeric string is not a number")
      (is (= 9 (get e "totalTokens")))
      (is (true? (get e "cacheHit")))
      (is (false? (get e "promptCacheKeyUsed")) "only literal true counts")
      (is (not (contains? e "tenantId"))))))

(deftest account-knowledge
  (let [providers [{"id" "openai" "accounts" [{"id" "a1" "displayName" "A1" "subject" "o1"}
                                                {"id" "a2" "displayName" "A2"}
                                                {"id" "a3" "displayName" "A3" "subject" "other"}]}]
        projected [{"providerId" "openai" "accountId" "a1" "ownerSubject" "o1" "sourcePeerId" "p" "availabilityState" "descriptor" "warmRequestCount" 2}
                   {"providerId" "openai" "accountId" "r" "ownerSubject" "o1" "sourcePeerId" "p" "availabilityState" "remote_route" "email" "r@x"}]
        {:keys [local-accounts known-accounts]} (fed/account-knowledge providers projected {:owner-subject "o1" :now 0})]
    (testing "other owners' local accounts are hidden unless projected; ownerless ones are shown"
      (is (= ["a1" "a2"] (map #(get % "accountId") local-accounts))))
    (is (= ["a1" "a2" "r"] (map #(get % "accountId") known-accounts)))
    (let [a1 (first known-accounts)]
      (is (= ["local_credential" "projected:descriptor"] (get a1 "knowledgeSources")))
      (is (= 2 (get a1 "warmRequestCount"))))
    (is (= "r@x" (get (last known-accounts) "displayName")))
    (is (false? (get (last known-accounts) "hasCredentials")))
    (testing "the default owner (or no owner) sees every local account"
      (is (= 3 (count (:local-accounts (fed/account-knowledge providers [] {:now 0})))))
      (is (= 3 (count (:local-accounts (fed/account-knowledge providers [] {:owner-subject " d " :default-owner-subject "d" :now 0}))))))
    (testing "an active cooldown is reported, an expired one is not"
      (is (= 50 (get (first (:local-accounts (fed/account-knowledge providers [] {:cooldowns {"openai\u0000a1" 50} :now 1}))) "cooldownUntilMs")))
      (is (not (contains? (first (:local-accounts (fed/account-knowledge providers [] {:cooldowns {"openai\u0000a1" 50} :now 60}))) "cooldownUntilMs"))))))
