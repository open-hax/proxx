(ns proxx.proxy.dashboard-test
  "Port of the dashboard / analytics / `/api/v1` tests of src/tests/proxy.test.ts (end to end
  through the application, over persisted request-log aggregates)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(def ^:private day-ms (* 24 60 60 1000))
(def ^:private hour-ms (* 60 60 1000))

(def ^:private ok-upstream (fn [_ _] (h/json-reply 200 {:ok true})))

(defn- bucket
  "A persisted aggregate bucket: zero counters, then `fields`; `standardRequestCount` follows `requestCount`."
  [fields]
  (let [b (merge {:errorCount 0 :cachedPromptTokens 0 :imageCount 0 :imageCostUsd 0
                  :cacheHitCount 0 :cacheKeyUseCount 0 :fastModeRequestCount 0 :priorityRequestCount 0}
                 fields)]
    (assoc b :standardRequestCount (or (:standardRequestCount b) (:requestCount b)))))

(defn- logs-payload [fields]
  (merge {:entries [] :hourlyBuckets [] :dailyBuckets [] :dailyModelBuckets []
          :dailyAccountBuckets [] :accountAccumulators []}
         fields))

(defn- ^:async get-json [app url headers]
  (let [response (await (h/inject app {:method "GET" :url url :headers headers}))]
    (is (= 200 (:status response)))
    (:json response)))

(deftest ^:async weekly-dashboard-uses-persisted-daily-model-account-aggregates-and-reports-incomplete-coverage
  (let [day0 (* day-ms (js/Math.floor (/ (- (js/Date.now) (* 5 day-ms)) day-ms)))
        day1 (+ day0 day-ms)
        payload (logs-payload
                 {:entries [{:id "recent-entry" :timestamp (- (js/Date.now) 60000) :providerId "openai"
                             :accountId "acct-openai" :authType "oauth_bearer" :model "gpt-5.4"
                             :upstreamMode "responses" :upstreamPath "/v1/responses" :status 200
                             :latencyMs 120 :promptTokens 20 :completionTokens 10 :totalTokens 30
                             :costUsd 0.001 :energyJoules 10 :waterEvaporatedMl 0.005}]
                  :dailyBuckets [(bucket {:startMs day0 :requestCount 5 :totalTokens 1500 :promptTokens 1000
                                          :completionTokens 500 :costUsd 1.5 :energyJoules 150
                                          :waterEvaporatedMl 0.075})
                                 (bucket {:startMs day1 :requestCount 4 :errorCount 1 :totalTokens 900
                                          :promptTokens 600 :completionTokens 300 :costUsd 0.9
                                          :energyJoules 90 :waterEvaporatedMl 0.045})]
                  :dailyModelBuckets [(bucket {:startMs day0 :providerId "openai" :model "gpt-5.4"
                                               :requestCount 5 :totalTokens 1500 :promptTokens 1000
                                               :completionTokens 500 :costUsd 1.5 :energyJoules 150
                                               :waterEvaporatedMl 0.075})
                                      (bucket {:startMs day1 :providerId "factory" :model "claude-sonnet-4-5"
                                               :requestCount 4 :errorCount 1 :totalTokens 900
                                               :promptTokens 600 :completionTokens 300 :costUsd 0.9
                                               :energyJoules 90 :waterEvaporatedMl 0.045})]
                  :dailyAccountBuckets [(bucket {:startMs day0 :providerId "openai" :accountId "acct-openai"
                                                 :authType "oauth_bearer" :requestCount 5 :totalTokens 1500
                                                 :promptTokens 1000 :completionTokens 500
                                                 :ttftSum 500 :ttftCount 5 :tpsSum 50 :tpsCount 5
                                                 :lastUsedAtMs (+ day0 (* 12 hour-ms))
                                                 :costUsd 1.5 :energyJoules 150 :waterEvaporatedMl 0.075})
                                        (bucket {:startMs day1 :providerId "factory" :accountId "acct-factory"
                                                 :authType "oauth_bearer" :requestCount 4 :errorCount 1
                                                 :totalTokens 900 :promptTokens 600 :completionTokens 300
                                                 :ttftSum 400 :ttftCount 4 :tpsSum 40 :tpsCount 4
                                                 :lastUsedAtMs (+ day1 (* 12 hour-ms))
                                                 :costUsd 0.9 :energyJoules 90 :waterEvaporatedMl 0.045})]})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers
                       {:openai {:auth "oauth_bearer"
                                 :accounts [{:account_id "acct-openai"
                                             :access_token (h/make-jwt
                                                            {"https://api.openai.com/auth" {:chatgpt_account_id "acct-openai"
                                                                                            :chatgpt_plan_type "plus"}
                                                             "https://api.openai.com/profile" {:email "acct-openai@example.com"}
                                                             :sub "acct-openai-user"})}]}
                        :factory {:auth "oauth_bearer"
                                  :accounts [{:account_id "acct-factory" :access_token "factory-token-b"
                                              :plan_type "pro"}]}}}
        :request-logs-payload payload
        :upstream-handler ok-upstream}
       (fn ^:async body [{:keys [app]}]
         (let [p (await (get-json app "/api/v1/dashboard/overview?window=weekly&sort=tokens" nil))]
           (is (= "weekly" (:window p)))
           (is (= 2400 (get-in p [:summary :tokens24h])))
           (is (= 2.4 (get-in p [:summary :costUsd24h])))
           (is (= "gpt-5.4" (get-in p [:summary :topModel])))
           (is (= "openai" (get-in p [:summary :topProvider])))
           (is (= false (get-in p [:coverage :hasFullWindowCoverage])))
           (is (= "openai" (get-in p [:accounts 0 :providerId])))
           (is (= 1500 (get-in p [:accounts 0 :totalTokens])))
           (is (= "factory" (get-in p [:accounts 1 :providerId])))
           (is (= 900 (get-in p [:accounts 1 :totalTokens])))))))))

(def ^:private admin {"authorization" "Bearer ui-token"})

(defn- ^:async check-me [{:keys [app]}]
  (let [response (await (h/inject app {:method "GET" :url "/api/v1/me" :headers admin}))
        p (:json response)]
    (is (= 200 (:status response)))
    (is (= "legacy_admin" (get-in p [:auth :kind])))
    (is (= "default" (get-in p [:auth :tenantId])))
    (is (= "default" (:activeTenantId p)))
    (is (vector? (:tenants p)))))

(deftest ^:async api-v1-me-exposes-resolved-auth-context-for-legacy-admin-token
  (await (with-proxy-app {:keys ["key-a"] :proxy-auth-token "ui-token" :upstream-handler ok-upstream}
           check-me)))

;; The TypeScript file declared this test twice, verbatim; both are kept.
(deftest ^:async api-v1-me-exposes-resolved-auth-context-for-legacy-admin-token-duplicate
  (await (with-proxy-app {:keys ["key-a"] :proxy-auth-token "ui-token" :upstream-handler ok-upstream}
           check-me)))

(deftest ^:async api-v1-settings-round-trips-settings-for-legacy-admin-token
  (await
   (with-proxy-app
     {:keys ["key-a"] :proxy-auth-token "ui-token" :upstream-handler ok-upstream}
     (fn ^:async body [{:keys [app]}]
       (let [update (await (h/inject app {:method "POST" :url "/api/v1/settings"
                                          :headers (merge admin h/json-headers)
                                          :payload {:fastMode true :requestsPerMinute 5}}))]
         (is (= 200 (:status update)))
         (is (= true (get-in update [:json :fastMode])))
         (is (= 5 (get-in update [:json :requestsPerMinute]))))
       (let [fetched (await (h/inject app {:method "GET" :url "/api/v1/settings" :headers admin}))]
         (is (= 200 (:status fetched)))
         (is (= true (get-in fetched [:json :fastMode])))
         (is (= 5 (get-in fetched [:json :requestsPerMinute]))))))))

(deftest ^:async api-v1-root-labels-planned-migration-targets-separately-from-implemented-documentation
  (await
   (with-proxy-app
     {:keys ["key-a"] :proxy-auth-token "ui-token" :upstream-handler ok-upstream}
     (fn ^:async body [{:keys [app]}]
       (let [p (await (get-json app "/api/v1" admin))]
         (is (= "/api/ui" (get-in p [:migration :legacyPrefix])))
         (is (= "/api/v1" (get-in p [:migration :targetPrefix])))
         (is (= 2 (get-in p [:summary :planned])))
         (is (= 6 (get-in p [:summary :implemented])))
         (is (= "/api/v1/sessions" (get-in p [:endpoints :sessions :path])))
         (is (= "/api/ui/sessions" (get-in p [:endpoints :sessions :legacyPath])))
         (is (= "implemented" (get-in p [:endpoints :sessions :status])))
         (is (= "implemented" (get-in p [:endpoints :settings :status])))
         (is (= "implemented" (get-in p [:endpoints :credentials :status])))
         (is (= "implemented" (get-in p [:endpoints :hosts :status])))
         (is (= "implemented" (get-in p [:endpoints :events :status])))
         (is (= "implemented" (get-in p [:endpoints :observability :status])))
         (is (= "planned" (get-in p [:endpoints :mcp :status])))
         (is (= "/api/v1/openapi.json" (get-in p [:documentation :path])))
         (is (= "implemented" (get-in p [:documentation :status]))))))))

(deftest ^:async provider-model-analytics-summarizes-global-models-providers-and-provider-model-pairs
  (let [day0 (* day-ms (js/Math.floor (/ (- (js/Date.now) (* 5 day-ms)) day-ms)))
        day1 (+ day0 day-ms)
        payload (logs-payload
                 {:dailyModelBuckets
                  [(bucket {:startMs day0 :providerId "openai" :model "gpt-5.4" :requestCount 6
                            :totalTokens 1800 :promptTokens 1200 :completionTokens 600 :cachedPromptTokens 100
                            :cacheHitCount 2 :cacheKeyUseCount 4 :ttftSum 600 :ttftCount 6 :tpsSum 72 :tpsCount 6
                            :lastUsedAtMs (+ day0 (* 12 hour-ms)) :costUsd 1.8 :energyJoules 180
                            :waterEvaporatedMl 0.09})
                   (bucket {:startMs day1 :providerId "factory" :model "gpt-5.4" :requestCount 4 :errorCount 1
                            :totalTokens 1000 :promptTokens 700 :completionTokens 300 :cachedPromptTokens 40
                            :cacheHitCount 1 :cacheKeyUseCount 2 :ttftSum 500 :ttftCount 4 :tpsSum 44 :tpsCount 4
                            :lastUsedAtMs (+ day1 (* 12 hour-ms)) :costUsd 1.0 :energyJoules 100
                            :waterEvaporatedMl 0.05})
                   (bucket {:startMs day1 :providerId "factory" :model "claude-sonnet-4-5" :requestCount 3
                            :totalTokens 900 :promptTokens 600 :completionTokens 300 :ttftSum 420 :ttftCount 3
                            :tpsSum 24 :tpsCount 3 :lastUsedAtMs (+ day1 (* 15 hour-ms)) :costUsd 0.9
                            :energyJoules 90 :waterEvaporatedMl 0.045})]})]
    (await
     (with-proxy-app
       {:keys [] :request-logs-payload payload :upstream-handler ok-upstream}
       (fn ^:async body [{:keys [app]}]
         (let [p (await (get-json app "/api/v1/analytics/provider-model?window=weekly&sort=tokens" nil))
               model (first (:models p))
               provider (first (:providers p))
               pair (first (filter #(and (= "openai" (:providerId %)) (= "gpt-5.4" (:model %)))
                                   (:providerModels p)))]
           (is (= "weekly" (:window p)))
           (is (= false (get-in p [:coverage :hasFullWindowCoverage])))
           (is (= "gpt-5.4" (:model model)))
           (is (= 2 (:providerCoverageCount model)))
           (is (= 10 (:requestCount model)))
           (is (= 2800 (:totalTokens model)))
           (is (= 110 (js/Math.round (:avgTtftMs model))))
           (is (= 11.6 (/ (js/Math.round (* (:avgTps model) 10)) 10)))
           (is (= "factory" (:providerId provider)))
           (is (= 2 (:modelCoverageCount provider)))
           (is (= 7 (:requestCount provider)))
           (is (= 1900 (:totalTokens provider)))
           (is (some? pair))
           (is (= 6 (:requestCount pair)))
           (is (= 100 (js/Math.round (:avgTtftMs pair))))
           (is (= 12 (js/Math.round (:avgTps pair))))
           (is (number? (:suitabilityScore pair)))))))))

(defn- tenant-entries [now latencies]
  [{:id "entry-acme-openai" :timestamp (- now (* 3 hour-ms)) :tenantId "acme" :issuer "local"
    :keyId "key-acme-1" :providerId "openai" :accountId "acct-1" :authType "oauth_bearer"
    :model "gpt-5.4" :upstreamMode "responses" :upstreamPath "/v1/responses" :status 200
    :latencyMs (first latencies) :promptTokens 700 :completionTokens 300 :totalTokens 1000
    :costUsd 1.0 :energyJoules 100 :waterEvaporatedMl 0.05}
   {:id "entry-acme-factory" :timestamp (- now (* 2 hour-ms)) :tenantId "acme" :issuer "local"
    :keyId "key-acme-2" :providerId "factory" :accountId "acct-2" :authType "oauth_bearer"
    :model "claude-sonnet-4-5" :upstreamMode "messages" :upstreamPath "/v1/messages" :status 500
    :latencyMs 240 :promptTokens 300 :completionTokens 200 :totalTokens 500 :error "upstream failed"
    :costUsd 0.5 :energyJoules 50 :waterEvaporatedMl 0.025}
   {:id "entry-beta-openai" :timestamp (- now hour-ms) :tenantId "beta" :issuer "local"
    :keyId "key-beta-1" :providerId "openai" :accountId "acct-1" :authType "oauth_bearer"
    :model "gpt-5.4" :upstreamMode "responses" :upstreamPath "/v1/responses" :status 200
    :latencyMs (second latencies) :promptTokens 600 :completionTokens 300 :totalTokens 900
    :costUsd 0.9 :energyJoules 90 :waterEvaporatedMl 0.045}])

(deftest ^:async dashboard-overview-scopes-usage-to-the-requested-tenant
  (await
   (with-proxy-app
     {:keys [] :request-logs-payload (logs-payload {:entries (tenant-entries (js/Date.now) [120 110])})
      :upstream-handler ok-upstream}
     (fn ^:async body [{:keys [app]}]
       (let [p (await (get-json app "/api/v1/dashboard/overview?window=weekly&tenantId=acme" nil))]
         (is (= 1500 (get-in p [:summary :tokens24h])))
         (is (= 1.5 (get-in p [:summary :costUsd24h])))
         (is (= "openai" (get-in p [:summary :topProvider])))
         (is (= "gpt-5.4" (get-in p [:summary :topModel])))
         (is (= 2 (count (:accounts p))))
         (is (= "openai" (get-in p [:accounts 0 :providerId])))
         (is (= 1000 (get-in p [:accounts 0 :totalTokens])))
         (is (= "factory" (get-in p [:accounts 1 :providerId])))
         (is (= 500 (get-in p [:accounts 1 :totalTokens]))))))))

(deftest ^:async provider-model-analytics-scopes-rollups-to-the-requested-tenant
  (await
   (with-proxy-app
     {:keys [] :request-logs-payload (logs-payload {:entries (tenant-entries (js/Date.now) [100 90])})
      :upstream-handler ok-upstream}
     (fn ^:async body [{:keys [app]}]
       (let [p (await (get-json app "/api/v1/analytics/provider-model?window=weekly&tenantId=acme" nil))]
         (is (= 2 (count (:models p))))
         (is (= 1000 (get-in p [:models 0 :totalTokens])))
         (is (= 2 (count (:providers p))))
         (is (= "openai" (get-in p [:providers 0 :providerId])))
         (is (= 1000 (get-in p [:providers 0 :totalTokens])))
         (is (= "factory" (get-in p [:providers 1 :providerId])))
         (is (= 500 (get-in p [:providers 1 :totalTokens])))
         (is (= 2 (count (:providerModels p))))
         (is (not-any? #(= 900 (:totalTokens %)) (:providerModels p))))))))

(defn- cache-entries
  "Three openai attempts (miss, hit, rate-limited) `offsets-ms` before now; `extra` per entry id suffix."
  [now extras]
  [(merge {:id (str (:prefix extras) "cache-miss") :timestamp (- now 60000) :providerId "openai"
           :accountId "acct-1" :authType "oauth_bearer" :model "gpt-5.4" :upstreamMode "responses"
           :upstreamPath "/v1/responses" :status 200 :latencyMs 120 :promptTokens 800 :completionTokens 200
           :totalTokens 1000 :promptCacheKeyUsed true :cacheHit false :cachedPromptTokens 0}
          (:miss extras))
   (merge {:id (str (:prefix extras) "cache-hit") :timestamp (- now 45000) :providerId "openai"
           :accountId "acct-1" :authType "oauth_bearer" :model "gpt-5.4" :upstreamMode "responses"
           :upstreamPath "/v1/responses" :status 200 :latencyMs 110 :promptTokens 700 :completionTokens 300
           :totalTokens 1000 :promptCacheKeyUsed true :cacheHit true :cachedPromptTokens 600}
          (:hit extras))
   {:id (str (:prefix extras) "cache-rate-limit") :timestamp (- now 30000) :providerId "openai"
    :accountId "acct-1" :authType "oauth_bearer" :model "gpt-5.4" :upstreamMode "responses"
    :upstreamPath "/v1/responses" :status 429 :latencyMs 40 :promptCacheKeyUsed true :cacheHit false
    :error "rate limit"}])

(deftest ^:async provider-model-analytics-excludes-failed-prompt-cache-attempts-from-cache-hit-rates
  (let [entries (cache-entries (js/Date.now)
                               {:prefix "entry-"
                                :miss {:ttftMs 90 :tps 10 :endToEndTps 8}
                                :hit {:ttftMs 80 :tps 12 :endToEndTps 10}})]
    (await
     (with-proxy-app
       {:keys [] :request-logs-payload (logs-payload {:entries entries}) :upstream-handler ok-upstream}
       (fn ^:async body [{:keys [app]}]
         (let [p (await (get-json app "/api/v1/analytics/provider-model?window=daily" nil))
               pair (first (filter #(and (= "openai" (:providerId %)) (= "gpt-5.4" (:model %))) (:providerModels p)))
               provider (first (filter #(= "openai" (:providerId %)) (:providers p)))
               model (first (filter #(= "gpt-5.4" (:model %)) (:models p)))]
           (is (some? pair))
           (is (= 3 (:requestCount pair)))
           (is (= 1 (:errorCount pair)))
           (is (= 50 (:cacheHitRate pair)))
           (is (some? provider))
           (is (= 50 (:cacheHitRate provider)))
           (is (some? model))
           (is (= 50 (:cacheHitRate model)))))))))

(deftest ^:async dashboard-overview-excludes-failed-prompt-cache-attempts-from-cache-hit-summary
  (let [entries (cache-entries (js/Date.now) {:prefix "entry-overview-"})]
    (await
     (with-proxy-app
       {:keys [] :request-logs-payload (logs-payload {:entries entries}) :upstream-handler ok-upstream}
       (fn ^:async body [{:keys [app]}]
         (let [p (await (get-json app "/api/v1/dashboard/overview?window=daily" nil))
               account (first (filter #(and (= "openai" (:providerId %)) (= "acct-1" (:accountId %))) (:accounts p)))]
           (is (= 2 (get-in p [:summary :cacheKeyUses24h])))
           (is (= 50 (get-in p [:summary :cacheHitRate24h])))
           (is (some? account))
           (is (= 2 (:cacheKeyUseCount account)))
           (is (= 1 (:cacheHitCount account)))))))))
