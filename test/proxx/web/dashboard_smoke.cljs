(ns proxx.web.dashboard-smoke
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private now "2026-04-03T00:00:00.000Z")

(deftest ^:async dashboard-renders-overview-accounts-and-log
  (s/stub-fetch!
   [[#"GET .*/api/v1/settings" {"fastMode" false}]
    [#"GET .*/api/v1/dashboard/overview" {"generatedAt" now
      "summary" {"requests24h" 12 "tokens24h" 3400 "promptTokens24h" 1200 "completionTokens24h" 2200 "cachedPromptTokens24h" 200
                 "imageCount24h" 2 "imageCostUsd24h" 0.12 "costUsd24h" 1.23 "energyJoules24h" 12000 "waterEvaporatedMl24h" 34
                 "cacheKeyUses24h" 3 "cacheHitRate24h" 20 "errorRate24h" 0 "topModel" "gpt-5.3-codex" "topProvider" "openai" "activeAccounts" 1
                 "routingRequests24h" {"local" 10 "federated" 1 "bridge" 1 "distinctPeers" 1 "topPeer" "peer-a"}
                 "serviceTierRequests24h" {"fastMode" 1 "priority" 2 "standard" 9}}
      "trends" {"requests" [{"t" now "v" 12}] "tokens" [{"t" now "v" 3400}] "errors" [{"t" now "v" 0}]}
      "accounts" [{"accountId" "acct-1" "displayName" "Primary OpenAI" "providerId" "openai" "authType" "oauth_bearer" "status" "healthy"
                   "requestCount" 12 "totalTokens" 3400 "promptTokens" 1200 "completionTokens" 2200 "cachedPromptTokens" 200
                   "imageCount" 2 "imageCostUsd" 0.12 "costUsd" 1.23 "energyJoules" 12000 "waterEvaporatedMl" 34 "cacheHitCount" 1 "cacheKeyUseCount" 3
                   "avgTtftMs" 420 "avgDecodeTps" 18 "avgTps" 14 "avgEndToEndTps" 10 "healthScore" 0.92 "transientDebuff" 0 "lastUsedAt" now}]}]
    [#"GET .*/api/v1/credentials" {"providers" [] "requestLogSummary" {}
      "keyPoolStatuses" {"openai" {"providerId" "openai" "authType" "oauth_bearer" "totalAccounts" 1 "availableAccounts" 1 "cooldownAccounts" 0 "nextReadyInMs" 0}}}]
    [#"GET .*/api/v1/request-logs" {"entries" [{"id" "req-1" "timestamp" 0 "routeKind" "local" "providerId" "openai" "accountId" "acct-1"
                                               "authType" "oauth_bearer" "model" "gpt-5.3-codex" "status" 200 "latencyMs" 420 "serviceTierSource" "none"}]}]])
  (await (s/mount-app! "/"))
  (await (s/wait-text "openai/acct-1"))
  (let [t (s/body-text)]
    (is (str/includes? t "Primary OpenAI"))
    (is (str/includes? t "Recent Request Log"))
    (is (str/includes? t "Requests / 7d"))
    (is (str/includes? t "Provider Pool"))
    (is (str/includes? t "openai/acct-1"))
    (is (str/includes? t "Account Health"))
    (is (str/includes? t "Service Tier Mix"))
    (is (str/includes? t "Fast mode"))
    (is (str/includes? t "420 ms"))
    (is (str/includes? t "OAuth")))
  (is (some? (.querySelector js/document "svg.dashboard-donut-chart"))))
