(ns proxx.proxy.openai-oauth-test
  "Port of the openai oauth account tests of src/tests/proxy.test.ts: account failover on rate
  limits and cooldown until the quota reset reported by a quota lookup (end to end through the
  application)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(deftest ^:async routes-openai-prefixed-models-with-oauth-account-failover
  (let [observed-path (atom "")
        observed-body (atom nil)
        observed-auth (atom [])
        observed-account-ids (atom [])]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers {:vivgrid {:auth "api_key" :accounts ["vivgrid-key-1" "vivgrid-key-2"]}
                                   :openai {:auth "oauth_bearer"
                                            :accounts [{:id "openai-a" :access_token "oa-token-a" :chatgpt_account_id "chatgpt-a"}
                                                       {:id "openai-b" :access_token "oa-token-b" :chatgpt_account_id "chatgpt-b"}]}}}
        :upstream-handler
        (fn [request body]
          (reset! observed-path (or (.-url request) ""))
          (reset! observed-body (h/parse-json body))
          (let [auth (h/req-header request "authorization")
                chatgpt-account-id (h/req-header request "chatgpt-account-id")]
            (when auth (swap! observed-auth conj auth))
            (when chatgpt-account-id (swap! observed-account-ids conj chatgpt-account-id))
            (if (= auth "Bearer oa-token-a")
              (h/json-reply 429 {:error {:message "rate limit"}} {"retry-after" "60"})
              (h/json-reply 200 {:id "resp_openai_oauth" :object "response" :created_at 1772516809
                                 :model "gpt-5.3-codex"
                                 :output [{:id "msg_openai_oauth" :type "message" :role "assistant"
                                           :content [{:type "output_text" :text "openai-oauth-ok"}]}]
                                 :usage {:input_tokens 7 :output_tokens 5 :total_tokens 12}}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "openai/gpt-5.3-codex")))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "openai_responses" (get-in response [:headers "x-open-hax-upstream-mode"])))
           (is (= "/v1/responses" @observed-path))
           (is (map? @observed-body))
           (is (= "gpt-5.3-codex" (:model @observed-body)))
           (is (= ["Bearer oa-token-a" "Bearer oa-token-b"] @observed-auth))
           (is (= ["chatgpt-a" "chatgpt-b"] @observed-account-ids))
           (is (map? payload))
           (is (= "chat.completion" (:object payload)))
           (is (= "gpt-5.3-codex" (:model payload)))
           (is (vector? (:choices payload)))
           (is (map? (get-in payload [:choices 0 :message])))
           (is (= "openai-oauth-ok" (get-in payload [:choices 0 :message :content])))
           (is (map? (:usage payload)))
           (is (= 12 (get-in payload [:usage :total_tokens])))))))))

(defn- request-url [input]
  (cond (string? input) input
        (instance? js/URL input) (.toString input)
        :else (.-url ^js input)))

(deftest ^:async openai-oauth-accounts-stay-cooled-until-quota-reset-after-a-quota-lookup-refresh
  (let [upstream-calls (atom 0)
        quota-lookups (atom [])]
    (await
     (h/with-patched-fetch
       (fn [input init _original]
         (when (= "https://chatgpt.com/backend-api/wham/usage" (request-url input))
           (let [auth (.get (js/Headers. (when init (.-headers ^js init))) "authorization")
                 reset-after-seconds (if (= auth "Bearer oa-token-a") 7200 10800)]
             (swap! quota-lookups conj (or auth "missing"))
             (js/Response. (h/json-body {:usage {:rate_limit {:allowed false
                                                              :limit_reached true
                                                              :primary_window {:remaining_percent 80
                                                                               :limit_window_seconds 18000
                                                                               :reset_after_seconds reset-after-seconds}}}})
                           #js {:status 200 :headers #js {"content-type" "application/json"}}))))
       (fn ^:async patched []
         (await
          (with-proxy-app
            {:keys []
             :keys-payload {:providers {:openai {:auth "oauth_bearer"
                                                 :accounts [{:id "openai-a" :access_token "oa-token-a" :chatgpt_account_id "chatgpt-a"}
                                                            {:id "openai-b" :access_token "oa-token-b" :chatgpt_account_id "chatgpt-b"}]}}}
             :upstream-handler
             (fn [_ _]
               (swap! upstream-calls inc)
               (h/json-reply 429 {:error {:message "rate limit"}}))}
            (fn ^:async body [{:keys [app]}]
              (let [first-r (await (h/chat app (h/hello "openai/gpt-5.3-codex")))]
                (is (= 429 (:status first-r)))
                (is (= 2 @upstream-calls))
                (is (= ["Bearer oa-token-a" "Bearer oa-token-b"] @quota-lookups)))
              (let [second-r (await (h/chat app (h/hello "openai/gpt-5.3-codex"
                                                          {:messages [{:role "user" :content "hello again"}]})))]
                (is (= 429 (:status second-r)))
                (is (= 2 @upstream-calls))
                (is (= ["Bearer oa-token-a" "Bearer oa-token-b"] @quota-lookups)))))))))))
