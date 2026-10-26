(ns proxx.federation.projections-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.projections :as p]))

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
