(ns proxx.analytics.usage-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.analytics.usage :as u]))

(def now 1770000000000)

(defn- entry [m]
  (merge {"timestamp" (- now 60000) "providerId" "p" "accountId" "a" "authType" "api_key" "model" "m"
          "status" 200 "routeKind" "local"}
         m))

(def entries
  [(entry {"totalTokens" 10 "ttftMs" 100 "tps" 20 "cacheHit" true "promptCacheKeyUsed" true})
   (entry {"status" 500 "totalTokens" 5 "model" "n" "timestamp" (- now 3600000)})
   (entry {"accountId" "b" "routeKind" "federated" "routedPeerLabel" " peer " "serviceTier" "priority"
           "timestamp" (- now 30000)})])

(def ctx {"window" "daily" "now" now "providers" [{"id" "p" "accounts" [{"id" "a" "authType" "api_key"} {"id" "z" "authType" "oauth_bearer" "planType" "plus"}]}]
          "statuses" {"p" [{"accountId" "b" "available" false}]}
          "coverage" {"coverageStartMs" (- now 7200000) "retainedEntryCount" 3 "maxRetainedEntries" 100}})

(deftest windows-and-parsers
  (is (= "monthly" (u/to-usage-window " 30D ")))
  (is (= "daily" (u/to-usage-window 5)))
  (is (= 5 (u/to-safe-limit "5abc" 1 10)))
  (is (= 10 (u/to-safe-limit 99 1 10)))
  (is (= 1 (u/to-safe-limit "x" 1 10)))
  (let [c (u/window-config "weekly" now)]
    (is (= (* 7 86400000) (- now (:entry-window-start c))))
    (is (zero? (mod (:bucket-window-start c) 86400000)))))

(deftest overview-is-a-pure-fold
  (let [r (u/overview-from-entries entries ctx)
        s (get r "summary")]
    (is (= r (u/overview-from-entries entries ctx)) "same facts, same report")
    (is (= 3 (get s "requests24h")))
    (is (= 15 (get s "tokens24h")))
    (is (= 33.33 (get s "errorRate24h")) "percentages are rounded to two places")
    (is (= 100 (get s "cacheHitRate24h")))
    (is (= "m" (get s "topModel")))
    (is (= {"local" 2 "federated" 1 "bridge" 0 "distinctPeers" 1 "topPeer" "peer"} (get s "routingRequests24h")))
    (is (= {"fastMode" 0 "priority" 1 "standard" 2} (get s "serviceTierRequests24h")))
    (is (= 24 (count (get-in r ["trends" "requests"]))))
    (testing "configured but idle accounts appear; cooling ones are flagged"
      (let [accts (into {} (map (juxt #(get % "accountId") identity)) (get r "accounts"))]
        (is (= "idle" (get-in accts ["z" "status"])))
        (is (= "plus" (get-in accts ["z" "planType"])))
        (is (= "cooldown" (get-in accts ["b" "status"])))
        (is (= 1 (get-in accts ["b" "transientDebuff"])))
        (is (= "healthy" (get-in accts ["a" "status"])))))))

(deftest account-sorting
  (let [names (fn [sort] (mapv #(get % "accountId") (get (u/overview-from-entries entries (assoc ctx "sort" sort)) "accounts")))]
    (is (= "a" (first (names "tokens"))))
    (is (= "a" (first (names "requests"))))
    (is (= (names "health") (names "no-such-sort")) "unknown keys fall back to health")))

(deftest analytics-rows
  (let [r (u/analytics-from-entries entries {"window" "daily" "sort" "requests" "now" now
                                             "coverage" {"coverageStartMs" nil "retainedEntryCount" 0 "maxRetainedEntries" 5}})
        by-model (into {} (map (juxt #(get % "model") identity)) (get r "models"))]
    (is (= 2 (count (get r "models"))))
    (is (= 1 (get-in by-model ["m" "providerCoverageCount"])))
    (is (not (contains? (get by-model "m") "providerId")) "model rows carry no providerId")
    (is (= 2 (count (get r "providerModels"))))
    (is (nil? (get-in r ["coverage" "coverageStart"])))
    (is (= 2 (get-in r ["providers" 0 "modelCoverageCount"])))))

(deftest scope
  (is (u/scope-active? {"tenantId" "t"}))
  (is (not (u/scope-active? {"tenantId" ""})))
  (is (u/entry-matches-scope? {"tenantId" "t"} {"tenantId" "t" "keyId" nil}))
  (is (not (u/entry-matches-scope? {"tenantId" "x"} {"tenantId" "t"}))))
