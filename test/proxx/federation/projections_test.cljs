(ns proxx.federation.projections-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.projections :as p]
            [proxx.http.route-path :as route-path]
            [proxx.runtime.federation-projections :as ed]
            [proxx.runtime.federation-routing :as fed-routing]))

(deftest pull-switches
  (is (p/pull-enabled? nil))
  (is (p/pull-enabled? "  "))
  (doseq [on ["1" "true" "YES" " on "]] (is (p/pull-enabled? on) on))
  (doseq [off ["0" "false" "nope"]] (is (not (p/pull-enabled? off)) off))
  (is (= 60000 (p/pull-ttl-ms nil)))
  (is (= 0 (p/pull-ttl-ms "0")))
  (is (= 5000 (p/pull-ttl-ms " 5000 ")))
  (is (= 60000 (p/pull-ttl-ms "-1")))
  (is (= 60000 (p/pull-ttl-ms "bad"))))

(deftest freshness
  (let [now 1000000]
    (is (p/fresh? "1970-01-01T00:16:30.000Z" now 60000) "pulled 10s ago")
    (is (not (p/fresh? "1970-01-01T00:10:00.000Z" now 60000)))
    (is (not (p/fresh? "1970-01-01T00:16:30.000Z" now 0)) "a zero ttl always pulls")
    (is (not (p/fresh? nil now 60000)))
    (is (not (p/fresh? "garbage" now 60000)))))

(deftest active-peers
  (is (p/active-peer? {"status" " ACTIVE "}))
  (is (not (p/active-peer? {"status" "paused"}))))

(def remote
  {"localAccounts" [{"providerId" "OpenAI" "accountId" "a" "authType" "oauth_bearer" "hasCredentials" true
                     "knowledgeSources" ["local_credential"] "cooldownUntilMs" 5 "subject" "s"}
                    {"providerId" "factory" "accountId" "k" "hasCredentials" false}]
   "projectedAccounts" [{"sourcePeerId" "peer-a" "providerId" "openai" "accountId" "a" "availabilityState" "remote_route"
                         "metadata" {}}
                        {"sourcePeerId" "peer-b" "providerId" "openai" "accountId" "a" "availabilityState" "remote_route"
                         "metadata" {"authType" "api_key" "knowledgeSources" ["x" 5] "extra" 1}}
                        {"sourcePeerId" "peer-a" "providerId" "zai" "accountId" "z" "availabilityState" "descriptor"}]})

(deftest projection-rows
  (let [rows (p/projection-upserts "peer-a" "did:o" remote)]
    (is (= ["a" "k" "a" "z"] (map #(get % "accountId") rows)))
    (testing "own accounts become remote routes (oauth) or descriptors, with mobility facts"
      (is (= "remote_route" (get (first rows) "availabilityState")))
      (is (= {"hasCredentials" true "knowledgeSources" ["local_credential"] "authType" "oauth_bearer"
              "credentialMobility" "access_token_only" "refreshAuthority" "owner_only" "cooldownUntilMs" 5}
             (get (first rows) "metadata")))
      (is (= "descriptor" (get (second rows) "availabilityState")))
      (is (= {"hasCredentials" false "credentialMobility" "importable" "refreshAuthority" "portable"}
             (get (second rows) "metadata")) "absent facts are absent, not null"))
    (testing "a projection of the peer's own account is skipped; others' are kept"
      (is (= ["peer-a" "peer-a" "peer-a" "peer-a"] (map #(get % "sourcePeerId") rows))
          "every row is attributed to the peer that told us")
      (is (= {"authType" "api_key" "knowledgeSources" ["x"] "extra" 1} (get (nth rows 2) "metadata"))
          "foreign metadata survives; non-string sources are dropped"))))

(deftest malformed-replies-are-rejected-before-any-write
  (is (= "remoteAccounts.localAccounts is not iterable"
         (try (p/projection-upserts "p" "o" {}) (catch :default e (ex-message e)))))
  (is (= "remoteAccounts.projectedAccounts is not iterable"
         (try (p/projection-upserts "p" "o" {"localAccounts" []}) (catch :default e (ex-message e)))))
  (testing "intentional divergence: an entry that is not an object fails the whole reply up front"
    (is (some? (try (p/projection-upserts "p" "o" {"localAccounts" [{"providerId" "a" "accountId" "b"} nil] "projectedAccounts" []})
                    (catch :default e (ex-message e)))))))

;; ---- src/tests/on-demand-projections.test.ts: the edge over a stubbed global fetch ------

(deftest ^:async ensure-fresh-pulls-remote-api-v1-federation-accounts-when-stale
  (let [seen-urls (atom [])
        upserts (atom [])
        sync-updates (atom [])
        original-fetch (.-fetch js/globalThis)
        body (js/JSON.stringify
              (clj->js {:localAccounts [{:providerId "openai" :accountId "acct-a" :authType "oauth_bearer"
                                         :hasCredentials true :knowledgeSources ["local_credential"]
                                         :cooldownUntilMs 1780632049684}]
                        :projectedAccounts [{:sourcePeerId "peer-b" :ownerSubject "did:web:example.com"
                                             :providerId "openai" :accountId "acct-a"
                                             :availabilityState "remote_route" :warmRequestCount 0
                                             :metadata {:hasCredentials false :knowledgeSources ["projected:remote_route"]}}]}))
        now-iso (.toISOString (js/Date.))
        store #js {:listPeers (fn [_owner] (js/Promise.resolve
                                            #js [#js {:id "peer-a" :ownerSubject "did:web:example.com" :label "Peer A"
                                                      :baseUrl "http://peer-a:8789" :controlBaseUrl "http://peer-a:8789"
                                                      :authMode "admin_key" :auth #js {:credential "peer-token"}
                                                      :status "active" :capabilities #js {}
                                                      :createdAt now-iso :updatedAt now-iso}]))
                   :getSyncState (fn [_] (js/Promise.resolve js/undefined))
                   :upsertProjectedAccount (fn [record] (swap! upserts conj (js->clj record)) (js/Promise.resolve record))
                   :upsertSyncState (fn [record] (swap! sync-updates conj (js->clj record)) (js/Promise.resolve record))}
        deps #js {:fetchFederationJson fed-routing/fetch-federation-json
                  :resolveFederationRoutePath (fn [suffix options]
                                                (route-path/join (if (some? options) (.-prefix ^js options) "/api/ui") suffix))}]
    (aset js/globalThis "fetch"
          (fn [input init]
            (swap! seen-urls conj (str input))
            (is (= "GET" (or (some-> init (.-method)) "GET")))
            (let [auth (some-> init (.-headers) (js/Headers.) (.get "authorization"))]
              (is (or (nil? auth) (.startsWith auth "Bearer "))))
            (js/Promise.resolve (js/Response. body #js {:status 200 :headers #js {"content-type" "application/json"}}))))
    (try
      (let [^js result (await (ed/ensure-projected-accounts-fresh-js
                               #js {:sqlFederationStore store :ownerSubject "did:web:example.com" :timeoutMs 1000} deps))]
        (is (= ["peer-a"] (vec (.-pulledPeerIds result))))
        (is (= 1 (count @seen-urls)))
        (is (.includes (first @seen-urls) "/api/v1/federation/accounts"))
        (is (.includes (first @seen-urls) "ownerSubject=did%3Aweb%3Aexample.com"))
        ;; local account upserted first, then projected account from peer-b (different source: not filtered)
        (is (= 2 (count @upserts)))
        (let [[u0 u1] @upserts]
          (is (= "peer-a" (get u0 "sourcePeerId")))
          (is (= "remote_route" (get u0 "availabilityState")))
          (is (= "openai" (get u0 "providerId")))
          (is (= "acct-a" (get u0 "accountId")))
          (is (= 1780632049684 (get-in u0 ["metadata" "cooldownUntilMs"])))
          (is (= "peer-a" (get u1 "sourcePeerId")))
          (is (= "openai" (get u1 "providerId")))
          (is (= "acct-a" (get u1 "accountId")))
          (is (= "remote_route" (get u1 "availabilityState"))))
        (is (= 1 (count @sync-updates)))
        (is (= "peer-a" (get (first @sync-updates) "peerId"))))
      (finally (aset js/globalThis "fetch" original-fetch)))))
