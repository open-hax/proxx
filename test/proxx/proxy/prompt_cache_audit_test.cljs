(ns proxx.proxy.prompt-cache-audit-test
  "`GET /api/v1/credentials/openai/prompt-cache-audit` through the real application:
  grouping by prompt-cache-key hash, the configured OpenAI provider id, and the
  watchlist being computed from every group rather than the truncated rows."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json inject]]))

(def ^:private audit-buckets
  {:hourlyBuckets [] :dailyBuckets [] :dailyModelBuckets [] :dailyAccountBuckets [] :accountAccumulators []})

(defn- ok-upstream [_ _] (fx/json-reply {:ok true}))

(defn- audit [app query]
  (inject app {:method "GET" :url (str "/api/v1/credentials/openai/prompt-cache-audit?" query)}))

(deftest ^:async groups-prompt-cache-audit-rows-by-hash-and-distinct-accounts-touched
  (let [a-attempts (atom 0)]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload (fx/oauth-openai-keys-2)
        :config-overrides {:upstreamProviderId "openai"}
        :upstream-handler (fn [req _]
                            (let [auth (fx/bearer req)]
                              (if (and (= auth "oa-token-a") (>= (swap! a-attempts inc) 2))
                                {:status 429
                                 :headers {"content-type" "application/json" "retry-after" "1"}
                                 :body (fx/json-str {:error {:message "rate limit"}})}
                                (fx/json-reply {:id (js/crypto.randomUUID) :object "response" :created_at 1772516810
                                                :model "gpt-5.4"
                                                :output [{:id (js/crypto.randomUUID) :type "message" :role "assistant"
                                                          :content [{:type "output_text" :text "OK"}]}]
                                                :usage {:input_tokens 11 :output_tokens 5 :total_tokens 16
                                                        :input_tokens_details {:cached_tokens (if (= auth "oa-token-b") 9 0)}}}))))}
       (^:async fn [{:keys [app]}]
         (let [payload {:model "gpt-5.4"
                        :messages [{:role "user" :content "Reply with exactly: OK"}]
                        :prompt_cache_key "sticky-gpt-oauth-audit-1"
                        :stream false}]
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (let [response (await (audit app "limit=10&scanLimit=100"))
                 body (:json response)
                 row (get-in body ["rows" 0])]
             (is (= 200 (:status response)))
             (is (map? body))
             (is (= 1 (get body "crossAccountHashCount")))
             (is (= 1 (get body "crossSuccessfulAccountHashCount")))
             (is (vector? (get body "rows")))
             (is (= 1 (count (get body "rows"))))
             (is (map? row))
             (is (= 2 (get row "accountCount")))
             (is (= ["openai-a" "openai-b"] (get row "accountIds")))
             (is (= 2 (get row "successfulAccountCount")))
             (is (= ["openai-a" "openai-b"] (get row "successfulAccountIds")))
             (is (= 1 (get row "failedAccountCount")))
             (is (= ["openai-a"] (get row "failedAccountIds")))
             (is (= 2 (get row "successfulRequestCount")))
             (is (= 1 (get row "failedRequestCount")))
             (is (= 3 (get row "requestCount"))))))))))

(deftest ^:async prompt-cache-audit-respects-configured-openai-provider-id-and-keeps-latest-model-from-newest-entry
  (let [entry (fn [id minute provider account model hash prompt completion total extra]
                (merge {:id id
                        :timestamp (js/Date.UTC 2026 3 4 12 minute 0)
                        :providerId provider :accountId account :authType "oauth_bearer"
                        :model model :upstreamMode "responses" :upstreamPath "/v1/responses"
                        :status 200 :latencyMs 100 :promptCacheKeyHash hash
                        :promptTokens prompt :completionTokens completion :totalTokens total}
                       extra))]
    (await
     (with-proxy-app
       {:keys []
        :request-logs-payload
        (assoc audit-buckets :entries
               [(entry "custom-openai-older" 0 "chatgpt-oauth" "acct-1" "gpt-4.1" "sha256:custom-openai-hash" 100 20 120 {:latencyMs 110})
                (entry "custom-openai-newer" 5 "chatgpt-oauth" "acct-1" "gpt-5.4" "sha256:custom-openai-hash" 120 25 145
                       {:latencyMs 105 :cacheHit true :promptCacheKeyUsed true :cachedPromptTokens 90})
                (entry "wrong-provider" 10 "openai" "acct-2" "gpt-5.4" "sha256:wrong-provider-hash" 200 30 230 {})])
        :config-overrides {:openaiProviderId "chatgpt-oauth" :upstreamProviderId "chatgpt-oauth"}
        :upstream-handler ok-upstream}
       (^:async fn [{:keys [app]}]
         (let [response (await (audit app "limit=10&scanLimit=100"))
               body (:json response)
               row (get-in body ["rows" 0])]
           (is (= 200 (:status response)))
           (is (map? body))
           (is (vector? (get body "rows")))
           (is (= 1 (count (get body "rows"))))
           (is (map? row))
           (is (= "chatgpt-oauth" (get row "providerId")))
           (is (= "gpt-5.4" (get row "latestModel")))
           (is (= "sha256:custom-openai-hash" (get row "promptCacheKeyHash")))))))))

(deftest ^:async prompt-cache-audit-watchlist-is-computed-from-all-grouped-hashes-not-only-truncated-rows
  (let [stable (mapv (fn [index]
                       {:id (str "stable-" index)
                        :timestamp (js/Date.UTC 2026 3 4 13 index 0)
                        :providerId "openai" :accountId "acct-stable" :authType "oauth_bearer"
                        :model "gpt-5.4" :upstreamMode "responses" :upstreamPath "/v1/responses"
                        :status 200 :latencyMs 100 :promptCacheKeyHash "sha256:stable-watch-hash"
                        :promptTokens 3000 :completionTokens 100 :totalTokens 3100
                        :cachedPromptTokens (if (zero? index) 0 150)
                        :cacheHit false :promptCacheKeyUsed true
                        :factoryDiagnostics {:shapeFingerprint "shape-stable"}})
                     (range 4))
        cross (fn [id minute account latency]
                {:id id :timestamp (js/Date.UTC 2026 3 4 (if (= minute 0) 14 13) minute 0)
                 :providerId "openai" :accountId account :authType "oauth_bearer"
                 :model "gpt-5.4" :upstreamMode "responses" :upstreamPath "/v1/responses"
                 :status 200 :latencyMs latency :promptCacheKeyHash "sha256:cross-account-hash"
                 :promptTokens 500 :completionTokens 50 :totalTokens 550})]
    (await
     (with-proxy-app
       {:keys []
        :request-logs-payload (assoc audit-buckets :entries
                                     (into [(cross "cross-newer" 0 "acct-a" 120)
                                            (cross "cross-older" 59 "acct-b" 118)]
                                           stable))
        :upstream-handler ok-upstream}
       (^:async fn [{:keys [app]}]
         (let [response (await (audit app "limit=1&scanLimit=100"))
               body (:json response)]
           (is (= 200 (:status response)))
           (is (map? body))
           (is (vector? (get body "rows")))
           (is (vector? (get body "watchRows")))
           (is (= 1 (count (get body "rows"))))
           (is (= "sha256:cross-account-hash" (get-in body ["rows" 0 "promptCacheKeyHash"])))
           (is (= 1 (count (get body "watchRows"))))
           (is (= "sha256:stable-watch-hash" (get-in body ["watchRows" 0 "promptCacheKeyHash"])))))))))
