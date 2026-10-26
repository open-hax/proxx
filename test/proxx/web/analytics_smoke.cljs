(ns proxx.web.analytics-smoke
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private now "2026-04-03T00:00:00.000Z")
(defn- r [m] (merge {"requestCount" 12 "errorCount" 0 "errorRate" 0 "totalTokens" 3400 "promptTokens" 1200 "completionTokens" 2200
                     "cachedPromptTokens" 200 "cacheHitRate" 20 "avgTtftMs" 420 "avgDecodeTps" 18 "avgTps" 14 "avgEndToEndTps" 10
                     "costUsd" 1.23 "energyJoules" 12000 "waterEvaporatedMl" 34 "firstSeenAt" now "lastSeenAt" now
                     "confidenceScore" 0.9 "suitabilityScore" 0.86} m))

(deftest ^:async analytics-page-renders
  (s/stub-fetch! [[#"GET .*/api/v1/settings" {"fastMode" false}]
                  [#"GET .*/api/v1/analytics/provider-model" {"window" "weekly" "generatedAt" now
                    "coverage" {"requestedWindowStart" now "coverageStart" now "hasFullWindowCoverage" true "retainedEntryCount" 1 "maxRetainedEntries" 1000}
                    "models" [(r {"model" "gpt-5.3-codex"})] "providers" [(r {"providerId" "openai"})]
                    "providerModels" [(r {"providerId" "openai" "model" "gpt-5.3-codex"})]}]])
  (await (s/mount-app! "/analytics"))
  (let [t (s/body-text)]
    (is (str/includes? t "Provider + model analytics"))
    (is (str/includes? t "Controls"))
    (is (str/includes? t "Analytics Views"))
    (is (str/includes? t "Models"))
    (is (str/includes? t "Providers"))
    (is (str/includes? t "Pairs"))
    (is (str/includes? t "Top model: gpt-5.3-codex"))
    (is (str/includes? t "Auto-refresh every 30s"))
    (is (str/includes? t "86%"))
    (is (str/includes? t "$1.23"))))
