(ns proxx.proxy.retry-test
  (:require ["node:fs/promises" :as fsp]
            ["node:os" :as os]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.policy.loader :as loader]
            [proxx.proxy.support :as s]
            [proxx.runtime.keypool :as keypool]))

(defn- ^:async with-retry-policy [f]
  (let [directory (await (.mkdtemp fsp (.join path (.tmpdir os) "proxx-owned-retry-")))
        manifest (.join path directory "00-manifest.edn")
        contracts (mapv (fn [clause]
                          (if (= :model-pricing-snapshot (:contract/kind clause))
                            (assoc clause :snapshot/path (.resolve path "resources/data/models-dev-pricing.edn"))
                            clause))
                        (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))]
    (try
      (await (.writeFile fsp (.join path directory "rules.edn")
                         (pr-str
                          (into [{:contract/id :model-family/owned-retry
                                  :contract/kind :model-family :match/model-pattern "^fixture-retry$"}
                                 {:contract/id :provider-order/owned-retry
                                  :contract/kind :preference-order :preference/items ["vivgrid"]}
                                 {:contract/id :route/owned-retry
                                  :contract/kind :routing-clause :match/family :model-family/owned-retry
                                  :prefer/providers :provider-order/owned-retry :prefer/providers-strict? true
                                  :prefer/strategies [:chat-completions] :account/order :account-order/prefer-free}
                                 {:contract/id :model-family/cloud-retry
                                  :contract/kind :model-family :match/model-pattern "^fixture-cloud$"}
                                 {:contract/id :provider-order/cloud-retry
                                  :contract/kind :preference-order :preference/items ["ollama-cloud"]}
                                 {:contract/id :route/cloud-retry :contract/kind :routing-clause
                                  :match/family :model-family/cloud-retry :prefer/providers :provider-order/cloud-retry
                                  :prefer/providers-strict? true :prefer/strategies [:chat-completions]
                                  :account/order :account-order/prefer-free}]
                                (conj contracts
                                      {:contract/id :credential-failure/quota-retry-test
                                       :contract/kind :credential-failure-classification
                                       :match/provider-pattern "^vivgrid$" :match/status 403
                                       :match/message-pattern "^fixture quota exhausted$"
                                       :classify/result :credential/quota-exhausted :classify/cooldown-ms 60000}
                                      {:contract/id :credential-failure/images-retry-test
                                       :contract/kind :credential-failure-classification
                                       :match/provider-pattern "^openai$" :match/status 403
                                       :match/message-pattern "^fixture model unavailable$"
                                       :classify/result :credential/model-unavailable :classify/cooldown-ms 60000})))))
      (await (.writeFile fsp manifest
                         (pr-str {:contract/id :proxx.policy.runtime/manifest :contract/kind :policy-manifest
                                  :policy.dsl/version 0 :policy.dsl/status :target-contract
                                  :policy.loader/order ["rules.edn"]})))
      (await (f manifest))
      (finally (await (.rm fsp directory #js {"recursive" true "force" true}))))))

(def ^:private platform "https://api.openai.com/v1/images/generations")
(def ^:private codex "https://chatgpt.com/backend-api/codex/responses")
(def ^:private image-request {"model" "gpt-image-1" "prompt" "a red square" "response_format" "b64_json"})
(def ^:private image-reply
  (str "data: " (s/json-str {"type" "response.completed"
                             "response" {"id" "resp-retry"
                                         "output" [{"type" "image_generation_call" "id" "ig-retry"
                                                    "status" "completed" "result" "AAAA"}]}})
       "\n\ndata: [DONE]\n\n"))

(defn- response [status body & [headers]]
  (js/Response. (s/json-str body)
                #js {"status" status "headers" (clj->js (merge {"content-type" "application/json"} headers))}))

(deftest ^:async image-concurrency-retry-preserves-step-fallback-and-delivers-codex-success
  (await
   (with-retry-policy
     (fn ^:async check-policy [manifest]
       (doseq [throttled-step [:platform :codex]]
         (let [seen (atom []) platform-calls (atom 0) codex-calls (atom 0)]
           (await
            (s/with-patched-fetch
              (fn [input init _]
                (let [url (s/request-url input)]
                  (when (or (str/includes? url "api.openai.com") (str/includes? url "chatgpt.com"))
                    (if (and (= url "https://chatgpt.com/backend-api/wham/usage")
                             (= "GET" (.-method ^js init)))
                      ;; Background quota polling is independent of the image
                      ;; POST sequence under test and may interleave with it.
                      (response 200 {"rate_limit" {"allowed" true "limit_reached" false
                                                   "primary_window" {"remaining_percent" 100
                                                                     "reset_after_seconds" 0}}})
                      (do
                        (swap! seen conj url)
                        (cond
                          (= url platform)
                          (if (and (= :platform throttled-step) (= 1 (swap! platform-calls inc)))
                            (response 429 {"error" {"message" "Too many concurrent requests"}} {"retry-after" "0.001"})
                            (response 403 {"error" {"message" "fixture model unavailable"}}))

                          (= url codex)
                          (do
                            (is (= "image_generation" (get-in (s/parse-json (.-body ^js init)) ["tools" 0 "type"])))
                            (if (and (= :codex throttled-step) (= 1 (swap! codex-calls inc)))
                              (response 429 {"error" {"message" "Too many concurrent requests"}} {"retry-after" "0.001"})
                              (js/Response. image-reply #js {"status" 200 "headers" #js {"content-type" "text/event-stream"}})))

                          :else (response 500 {"error" {"message" (str "Unexpected retry URL " url)}})))))))
              (fn ^:async run []
                (await
                 (s/with-proxy-app
                   {:keys [] :keys-payload {"providers" {"openai" {"auth" "oauth_bearer"
                                                                              "accounts" [{"access_token" (s/make-jwt {"https://api.openai.com/auth" {"chatgpt_account_id" "acc-retry"}})
                                                                                           "chatgpt_account_id" "acc-retry"}]}}}
                    :upstream-response-headers {"connection" "close"}
                    :config-overrides {:upstreamProviderId "openai" :openaiProviderId "openai"
                                       :openaiImagesUpstreamMode "auto" :openaiApiBaseUrl "https://api.openai.com"
                                       :openaiBaseUrl "https://chatgpt.com/backend-api" :openaiResponsesPath "/codex/responses"
                                       :cljsPolicyManifestPath manifest :requestTimeoutMs 30000 :keyCooldownMs 1
                                       :localOllamaEnabled false}
                    :upstream-handler (fn [_ _] {:status 500 :body "unexpected upstream call"})}
                   (fn ^:async verify [{:keys [app]}]
                     (dotimes [_ 2]
                       (let [result (await (s/post-json app "/v1/images/generations" image-request s/local-auth))]
                         (is (= 200 (:status result)) (pr-str result))
                         (is (= [{"b64_json" "AAAA"}] (get (:json result) "data"))
                             "The retry reply is delivered and a fallback 403 never caches a model denial")))))))))
           (is (= (if (= :platform throttled-step)
                    [platform platform codex platform codex]
                    [platform codex codex platform codex])
                  @seen)
               "A retry stays on the current step's path, and fallback precedes model denial")))))))

(deftest ^:async ordinary-concurrency-success-and-concurrent-quota-preservation
  (await
   (with-retry-policy
     (fn ^:async check-policy [manifest]
       (doseq [scenario [:success :quota-during-wait :quota-on-exhaustion]]
         (let [calls (atom 0) active-pool (atom nil) active-account (atom nil)
               create-pool keypool/create-key-pool-js]
           (with-redefs [keypool/create-key-pool-js
                         (fn [config deps]
                           (let [^js pool (create-pool config deps)
                                 mark (.-markRateLimitedAtLeast pool)
                                 scheduled (atom false)]
                             (reset! active-pool pool)
                             (aset pool "markRateLimitedAtLeast"
                                   (fn [account duration]
                                     (reset! active-account account)
                                     (let [claim (mark account duration)]
                                       (when (and (= :quota-during-wait scenario)
                                                  (compare-and-set! scheduled false true))
                                         (js/setTimeout #(.markRateLimited pool account 600000) 0))
                                       claim)))
                             pool))]
             (await
              (s/with-proxy-app
                {:keys-payload {"providers" {"vivgrid" {"auth" "api_key" "accounts" ["fixture-owned-retry-key"]}}}
                 :models ["fixture-retry"]
                 :upstream-response-headers {"connection" "close"}
                 :config-overrides {:cljsPolicyManifestPath manifest :keyCooldownMs 1
                                    :requestTimeoutMs 30000 :localOllamaEnabled false}
                 :upstream-handler
                 (fn [request _]
                   (if (s/embed-request? request)
                     (s/embed-response)
                     (case (swap! calls inc)
                       1 (s/json-response 429 {"retry-after" "0.02"} {"error" {"message" "Too many concurrent requests"}})
                       2 (if (= :quota-on-exhaustion scenario)
                           (do (.markRateLimited ^js @active-pool @active-account 600000)
                               (s/json-response 503 {"error" {"message" "fixture retry unavailable"}}))
                           (s/json-response 200 (s/chat-completion "fixture-ready" "fixture-retry" "ready")))
                       (s/json-response 200 (s/chat-completion "fixture-next" "fixture-retry" "ready")))))}
                (fn ^:async verify [{:keys [app]}]
                  (let [result (await (s/post-json app "/v1/chat/completions"
                                                  {"model" "fixture-retry" "messages" [{"role" "user" "content" "hello"}]}
                                                  s/local-auth))]
                    (if (= :success scenario)
                      (do
                        (is (= 200 (:status result)) (pr-str result))
                        (is (= "ready" (get-in result [:json "choices" 0 "message" "content"])))
                        (is (= 2 @calls)))
                      (do
                        (if (= :quota-during-wait scenario)
                          (is (= 429 (:status result)) "Preserving another request's quota still reports the observed throttle")
                          (is (>= (:status result) 400)))
                        (is (= (if (= :quota-during-wait scenario) 1 2) @calls))
                        (let [^js status (await (.getStatus ^js @active-pool "vivgrid"))]
                          (is (> (.-nextReadyInMs status) 500000)
                              "A newer quota cooldown survives both waiting and retry-exhaustion writes")))))))))))))))

(deftest ^:async retry-response-effects-preserve-newer-quota-and-install-missing-quota
  (await
   (with-retry-policy
     (fn ^:async verify-policy [manifest]
       (doseq [scenario [:cloud-success :classified-quota-with-newer :classified-quota-without-newer]]
         (let [cloud? (= scenario :cloud-success)
               provider (if cloud? "ollama-cloud" "vivgrid")
               model (if cloud? "fixture-cloud" "fixture-retry")
               calls (atom 0) active-pool (atom nil) active-account (atom nil)
               create-pool keypool/create-key-pool-js]
           (with-redefs [keypool/create-key-pool-js
                         (fn [config deps]
                           (let [^js pool (create-pool config deps)
                                 mark (.-markRateLimitedAtLeast pool)]
                             (reset! active-pool pool)
                             (aset pool "markRateLimitedAtLeast"
                                   (fn [account duration]
                                     (reset! active-account account)
                                     (mark account duration)))
                             pool))]
             (await
              (s/with-proxy-app
                {:keys-payload {"providers" {provider {"auth" "api_key" "accounts" ["fixture-retry-effect-key"]}}}
                 :models [model] :handle-model-catalog true
                 :upstream-response-headers {"connection" "close"}
                 :config-overrides {:cljsPolicyManifestPath manifest :keyCooldownMs 1
                                    :requestTimeoutMs 30000 :localOllamaEnabled false}
                 :upstream-handler
                 (fn [request _]
                   (cond
                     (s/embed-request? request) (s/embed-response)
                     (= "GET" (.-method request)) (s/json-response 404 {})
                     (= 1 (swap! calls inc))
                     (s/json-response 429 {"retry-after" "0.001"}
                                      {"error" {"message" "Too many concurrent requests"}})
                     :else
                     (do
                       (when-not (= scenario :classified-quota-without-newer)
                         (.markRateLimited ^js @active-pool @active-account 600000))
                       (if cloud?
                         (s/json-response 200 (s/chat-completion "cloud-retry" model "ready"))
                         (s/json-response 403 {"retry-after" "60"}
                                          {"error" {"message" "fixture quota exhausted"}})))))}
                (fn ^:async verify [{:keys [app]}]
                  (let [result (await (s/post-json app "/v1/chat/completions"
                                                  {"model" model "messages" [{"role" "user" "content" "hello"}]}
                                                  s/local-auth))
                        ^js status (await (.getStatus ^js @active-pool provider))]
                    (is (= 2 @calls) (pr-str result))
                    (if cloud?
                      (do (is (= 200 (:status result)) (pr-str result))
                          (is (= "ready" (get-in result [:json "choices" 0 "message" "content"]))))
                      (is (= 429 (:status result)) (pr-str result)))
                    (if (= scenario :classified-quota-without-newer)
                      (is (< 30000 (.-nextReadyInMs status) 70000)
                          "A retry quota still installs its response deadline when none is longer")
                      (is (> (.-nextReadyInMs status) 500000)
                          "Neither successful retry cleanup nor classified quota can erase a later deadline")))))))))))))
