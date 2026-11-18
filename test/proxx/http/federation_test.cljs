(ns proxx.http.federation-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.auth.request :as request-auth]
            [proxx.http.federation :as fed]
            [proxx.runtime.routes.federation :as routes]))

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


(defn- route-handler [deps method prefix suffix]
  (:handler (first (filter #(and (= method (:method %)) (= (str prefix suffix) (:path %)))
                           (routes/routes deps prefix)))))

(deftest ^:async federation-global-credentials-require-the-operator
  (let [calls (atom 0)
        deps {:env #js {}
              :credential-store #js {:listProviders (fn [_]
                                                     (swap! calls inc)
                                                     (js/Promise.resolve #js []))}
              :sql-federation-store #js {:listPeers (constantly (js/Promise.resolve #js []))}}
        principals [nil
                    {"kind" "tenant_api_key" "role" "member"}
                    {"kind" "ui_session" "role" "owner"}
                    {"kind" "ui_session" "role" "admin"}]]
    (doseq [prefix ["/api/v1" "/api/ui"]
            suffix ["/federation/accounts/export"
                    "/federation/projected-accounts/import-all"
                    "/federation/bridges/lease/import"]
            auth principals]
      (let [handler (route-handler deps :post prefix suffix)
            response (await (handler {:auth auth :body {"providerId" "p" "accountId" "a"}}))]
        (is (= (if auth 403 401) (:status response)))))
    (is (zero? @calls) "Denied requests never read global provider credentials")
    (let [metadata (route-handler deps :get "/api/v1" "/federation/self")
          response (await (metadata {:auth {"kind" "ui_session" "role" "owner"}}))]
      (is (some? (:body response)) "Tenant owners retain federation metadata access"))))

(deftest ^:async operator-peer-import-keeps-the-authorized-export-flow
  (let [peer-token "fixture-operator-peer-bearer"
        fixture-account #js {:id "a" :authType "api_key" :secret "fixture-provider-key"}
        exports (atom 0)
        imported (atom [])
        source-deps {:credential-store
                     #js {:listProviders (fn [reveal?]
                                           (is (true? reveal?))
                                           (swap! exports inc)
                                           (js/Promise.resolve
                                            #js [#js {:id "p" :accounts #js [fixture-account]}]))}}
        export-handler (route-handler source-deps :post "/api/v1" "/federation/accounts/export")
        destination-deps
        {:credential-store #js {:listProviders (constantly (js/Promise.resolve #js []))
                                :upsertApiKeyAccount (fn [p a secret]
                                                       (swap! imported conj [p a secret])
                                                       (js/Promise.resolve nil))}
         :key-pool #js {:warmup (constantly (js/Promise.resolve nil))}
         :sql-federation-store
         #js {:getPeer (fn [_]
                         (js/Promise.resolve #js {:baseUrl "https://peer.fixture"
                                                 :auth #js {:credential peer-token}}))
              :listProjectedAccounts
              (fn [_]
                (js/Promise.resolve #js [#js {:sourcePeerId "peer" :providerId "p" :accountId "a"
                                             :availabilityState "descriptor" :metadata #js {}}]))
              :markProjectedAccountImported (fn [_] (js/Promise.resolve nil))}}
        import-handler (route-handler destination-deps :post "/api/v1" "/federation/projected-accounts/import-all")
        original-fetch js/fetch]
    (set! js/fetch
          (fn ^:async peer-request [url ^js options]
            (is (= "https://peer.fixture/api/v1/federation/accounts/export" url))
            (let [token (request-auth/bearer-token (.get ^js (.-headers options) "authorization"))
                  source (request-auth/legacy-admin-source peer-token token nil)
                  auth (when source (request-auth/legacy-admin source "default"))
                  response (await (export-handler {:auth auth
                                                   :body (js->clj (js/JSON.parse (.-body options)))}))]
              (is (= :bearer source))
              (js/Response. (js/JSON.stringify (:body response))
                            #js {:status (or (:status response) 200)}))))
    (try
      (let [response (await (import-handler
                             {:auth {"kind" "legacy_admin"}
                              :body {"sourcePeerId" "peer" "providerId" "p"}}))]
        (is (= 1 (get-in response [:body "imported"])))
        (is (= 0 (get-in response [:body "failed"])))
        (is (= 1 @exports))
        (is (= [["p" "a" "fixture-provider-key"]] @imported)))
      (finally
        (set! js/fetch original-fetch)))))

(deftest ^:async peer-transport-writes-require-the-operator
  (let [writes (atom 0)
        peer #js {:id "peer" :ownerSubject "owner" :label "Peer"
                  :baseUrl "https://peer.fixture" :auth #js {:credential "fixture-peer-bearer"}}
        deps {:sql-federation-store
              #js {:upsertPeer (fn [_] (swap! writes inc) (js/Promise.resolve peer))
                   :appendDiffEvent (constantly (js/Promise.resolve nil))}}]
    (doseq [prefix ["/api/v1" "/api/ui"]]
      (let [handler (route-handler deps :post prefix "/federation/peers")
            body {"id" "peer" "ownerCredential" "owner" "label" "Peer"
                  "baseUrl" "https://changed.fixture" "controlBaseUrl" "https://changed-control.fixture"}
            raw #js {:body (clj->js body)}]
        (doseq [auth [nil {"kind" "tenant_api_key"}
                      {"kind" "ui_session" "role" "owner"}
                      {"kind" "ui_session" "role" "admin"}]]
          (is (= (if auth 403 401) (:status (await (handler {:auth auth :body body :raw raw}))))))
        (is (zero? @writes) "A tenant cannot retarget a stored peer bearer even when auth is omitted")
        (let [response (await (handler {:auth {"kind" "legacy_admin"} :body body :raw raw}))
              ^js visible (.-peer ^js (:body response))]
          (is (= 201 (:status response)))
          (is (= "peer" (.-id visible)))
          (is (undefined? (.-auth visible)))
          (is (not (.includes (js/JSON.stringify visible) "fixture-peer-bearer")))))
      (reset! writes 0))))

(deftest ^:async public-peer-responses-never-reveal-authentication
  (let [peer-token "fixture-peer-bearer"
        peer #js {:id "peer" :ownerSubject "owner" :label "Peer" :baseUrl "https://peer.fixture"
                  :controlBaseUrl "https://control.fixture" :authMode "bearer" :status "active"
                  :auth #js {:credential peer-token} :auth_json #js {:credential peer-token}
                  :ownerCredential peer-token :createdAt "fixture-time"}
        requests (atom 0)
        deps {:sql-federation-store
              #js {:listPeers (constantly (js/Promise.resolve #js [peer]))
                   :getPeer (constantly (js/Promise.resolve peer))
                   :getSyncState (constantly (js/Promise.resolve nil))
                   :upsertSyncState (constantly (js/Promise.resolve #js {:peerId "peer"}))}}
        original-fetch js/fetch]
    (set! js/fetch
          (fn [url ^js options]
            (swap! requests inc)
            (is (.startsWith url "https://control.fixture/"))
            (is (= (str "Bearer " peer-token) (.get ^js (.-headers options) "authorization")))
            (js/Promise.resolve
             (js/Response. (js/JSON.stringify
                            (if (.includes url "diff-events") #js {:events #js []}
                                #js {:localAccounts #js [] :projectedAccounts #js []}))
                           #js {:status 200}))))
    (try
      (doseq [prefix ["/api/v1" "/api/ui"]
              auth [{"kind" "ui_session" "role" "owner"}
                    {"kind" "ui_session" "role" "admin"}
                    {"kind" "legacy_admin"}]]
        (let [listed (await ((route-handler deps :get prefix "/federation/peers") {:auth auth :query {}}))
              synced (await ((route-handler deps :post prefix "/federation/sync/pull")
                              {:auth auth :body {"peerId" "peer"} :raw #js {:body #js {:pullUsage false}}}))]
          (doseq [^js visible [(aget (.-peers ^js (:body listed)) 0) (.-peer ^js (:body synced))]]
            (is (= "peer" (.-id visible)))
            (is (= "https://control.fixture" (.-controlBaseUrl visible)))
            (is (= "bearer" (.-authMode visible)))
            (is (= "fixture-time" (.-createdAt visible)))
            (is (undefined? (.-auth visible)))
            (is (undefined? (.-auth_json visible)))
            (is (undefined? (.-ownerCredential visible)))
            (is (not (.includes (js/JSON.stringify visible) peer-token))))))
      (is (= 12 @requests) "Authorized metadata sync retains its configured peer authentication")
      (is (= peer-token (.-credential (.-auth peer))) "Response sanitizing never mutates the private store record")
      (finally (set! js/fetch original-fetch)))))

(deftest ^:async tenant-routing-notifications-do-not-authorize-credential-import
  (let [account #js {:sourcePeerId "peer" :ownerSubject "owner" :providerId "p" :accountId "a"
                     :availabilityState "descriptor" :warmRequestCount 9 :metadata #js {}}
        imported-account (js/Object.assign #js {} account #js {:availabilityState "imported"})
        notes (atom 0) locks (atom 0) imports (atom 0) requests (atom 0)
        deps {:should-warm-import (constantly true)
              :credential-store #js {:upsertApiKeyAccount (fn [p a secret]
                                                           (is (= ["p" "a" "fixture-provider-key"] [p a secret]))
                                                           (swap! imports inc)
                                                           (js/Promise.resolve nil))}
              :sql-federation-store
              #js {:noteProjectedAccountRouted (fn [_] (swap! notes inc) (js/Promise.resolve account))
                   :appendDiffEvent (constantly (js/Promise.resolve nil))
                   :withProjectedAccountImportLock (fn [_ f] (swap! locks inc) (f nil))
                   :getProjectedAccount (constantly (js/Promise.resolve account))
                   :getPeer (constantly (js/Promise.resolve #js {:baseUrl "https://peer.fixture"
                                                               :auth #js {:credential "fixture-peer-bearer"}}))
                   :markProjectedAccountImported (constantly (js/Promise.resolve imported-account))}}
        original-fetch js/fetch]
    (set! js/fetch
          (fn [_ ^js options]
            (swap! requests inc)
            (is (= "Bearer fixture-peer-bearer" (.get ^js (.-headers options) "authorization")))
            (js/Promise.resolve
             (js/Response. (js/JSON.stringify #js {:account #js {:providerId "p" :accountId "a"
                                                                :authType "api_key" :secret "fixture-provider-key"}})
                           #js {:status 200}))))
    (try
      (doseq [prefix ["/api/v1" "/api/ui"]]
        (let [handler (route-handler deps :post prefix "/federation/projected-accounts/routed")
              body {"sourcePeerId" "peer" "providerId" "p" "accountId" "a"}]
          (doseq [auth [{"kind" "ui_session" "role" "owner"} {"kind" "ui_session" "role" "admin"}]]
            (let [response (await (handler {:auth auth :body body}))]
              (is (= account (.-account ^js (:body response))))
              (is (false? (.-importedCredential ^js (:body response))))))
          (is (zero? @locks) "Tenant notifications record usage without entering the credential import lock")
          (is (zero? @requests) "Tenant notifications never send a configured operator bearer to a peer")
          (is (zero? @imports) "Tenant notifications never write global credentials")
          (let [response (await (handler {:auth {"kind" "legacy_admin"} :body body}))]
            (is (true? (.-importedCredential ^js (:body response))))
            (is (= imported-account (.-account ^js (:body response))))
            (is (= 1 @locks))
            (is (= 1 @requests))
            (is (= 1 @imports))))
        (reset! locks 0) (reset! requests 0) (reset! imports 0))
      (is (= 6 @notes) "Tenant and operator routing notifications are still recorded")
      (finally (set! js/fetch original-fetch)))))
