(ns proxx.proxy.account-probes-test
  "Account-facing credential endpoints through the application: live Codex
  quota windows, and minimal hello probes for OpenAI and Ollama Cloud accounts."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.support :as s]))

(defn- ^:async read-keys [temp-dir]
  (s/parse-json (await (.readFile fsp (.join path temp-dir "keys.json") "utf8"))))

(defn- header-of [^js init name] (.get (js/Headers. (.-headers init)) name))

(deftest ^:async fetches-live-openai-codex-quota-windows-and-persists-refreshed-oauth-tokens
  (let [refreshed-access-token (s/make-jwt {"https://api.openai.com/auth" {"chatgpt_account_id" "workspace-a"
                                                                           "chatgpt_plan_type" "pro"}
                                            "https://api.openai.com/profile" {"email" "quota@example.com"}
                                            "sub" "user-quota"})]
    ;; every fetch of the test is answered here: an unexpected URL is an error, as before
    (await
     (s/with-patched-fetch
       (fn ^:async answer [input ^js init _original]
         (let [url (str input)]
           (cond
             (= url "https://auth.openai.com/oauth/token")
             (js/Response. (s/json-str {"access_token" refreshed-access-token
                                        "refresh_token" "refresh-token-new"
                                        "expires_in" 3600})
                           #js {"status" 200 "headers" #js {"content-type" "application/json"}})

             (= url "https://chatgpt.com/backend-api/wham/usage")
             (do
               (is (= (str "Bearer " refreshed-access-token) (header-of init "authorization")))
               (is (= "workspace-a" (header-of init "chatgpt-account-id")))
               (is (= "codex_cli_rs" (header-of init "originator")))
               (js/Response.
                (s/json-str
                 {"usage" {"rate_limit" {"allowed" false "limit_reached" true
                                         "primary_window" {"remaining_percent" 72 "limit_window_seconds" 18000
                                                           "reset_after_seconds" 1800}
                                         "secondary_window" {"allowed" false "remaining_percent" 54
                                                             "limit_window_seconds" 604800
                                                             "resets_at" "2030-01-01T00:00:00.000Z"}}
                           "code_review_rate_limit" {"allowed" true "limit_reached" false
                                                     "primary_window" {"remaining_percent" 100
                                                                       "limit_window_seconds" 604800
                                                                       "reset_after_seconds" 3600}}
                           "plan_type" "pro"}})
                #js {"status" 200 "headers" #js {"content-type" "application/json"}}))

             :else (throw (js/Error. (str "Unexpected fetch URL in quota test: " url))))))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys [] :models ["gpt-5.4-mini"]
             :keys-payload
             {"providers"
              {"openai"
               {"auth" "oauth_bearer"
                "accounts" [{"id" "openai-a"
                             "access_token" (s/make-jwt {"https://api.openai.com/auth" {"chatgpt_account_id" "workspace-a"
                                                                                       "chatgpt_plan_type" "plus"}
                                                         "https://api.openai.com/profile" {"email" "quota@example.com"}
                                                         "sub" "user-quota"})
                             "refresh_token" "refresh-token-old"
                             "expires_at" (- (js/Date.now) 1000)
                             "chatgpt_account_id" "workspace-a"
                             "email" "quota@example.com"
                             "plan_type" "plus"}]}}}
             :config-overrides {:openaiBaseUrl "https://chatgpt.com/backend-api"
                                :openaiResponsesPath "/codex/responses"}
             :upstream-handler (fn [_ _] (s/json-response 404 {"error" "not_used"}))}
            (fn ^:async run [{:keys [app temp-dir]}]
              (let [response (await (s/inject app {:method "GET" :url "/api/v1/credentials/openai/quota"}))
                    payload (:json response)
                    account (get-in payload ["accounts" 0])
                    persisted (await (read-keys temp-dir))
                    persisted-account (get-in persisted ["providers" "openai" "accounts" 0])]
                (is (= 200 (:status response)))
                (is (map? payload))
                (is (vector? (get payload "accounts")))
                (is (= 1 (count (get payload "accounts"))))
                (is (map? account))
                (is (= "openai" (get account "providerId")))
                (is (= "openai-a" (get account "accountId")))
                (is (= "ok" (get account "status")))
                (is (= "pro" (get account "planType")))
                (is (map? (get account "fiveHour")))
                (is (= 72 (get-in account ["fiveHour" "remainingPercent"])))
                (is (= 18000 (get-in account ["fiveHour" "limitWindowSeconds"])))
                (is (map? (get account "weekly")))
                (is (= 54 (get-in account ["weekly" "remainingPercent"])))
                (is (= 604800 (get-in account ["weekly" "limitWindowSeconds"])))
                (is (map? (get account "rateLimit")))
                (is (false? (get-in account ["rateLimit" "allowed"])))
                (is (map? (get account "codeReviewRateLimit")))
                (is (true? (get-in account ["codeReviewRateLimit" "allowed"])))
                (is (map? (get persisted "providers")))
                (is (map? (get-in persisted ["providers" "openai"])))
                (is (vector? (get-in persisted ["providers" "openai" "accounts"])))
                (is (map? persisted-account))
                (is (= refreshed-access-token (get persisted-account "access_token")))
                (is (= "refresh-token-new" (get persisted-account "refresh_token")))
                (is (= "pro" (get persisted-account "plan_type"))))))))))))

(deftest ^:async probes-an-openai-account-with-a-minimal-hello-request
  (let [observed (atom [])]
    (await
     (s/with-patched-fetch
       (fn ^:async answer [input ^js init _original]
         (let [url (str input)]
           (if (= url "https://chatgpt.com/backend-api/codex/responses")
             (do
               (swap! observed conj {:url url
                                     :headers (js/Headers. (.-headers init))
                                     :body (s/parse-json (str (or (.-body init) "{}")))})
               (js/Response.
                (str/join "\n"
                          ["event: response.completed"
                           (str "data: " (s/json-str {"type" "response.completed"
                                                      "response" {"id" "resp_probe_hello" "status" "completed"
                                                                  "model" "gpt-5.4-mini"
                                                                  "output" [{"type" "message" "role" "assistant"
                                                                             "content" [{"type" "output_text" "text" "hello"}]}]
                                                                  "usage" {"input_tokens" 5 "output_tokens" 1 "total_tokens" 6}}}))
                           "" ""])
                #js {"status" 200 "headers" #js {"content-type" "text/event-stream"}}))
             (throw (js/Error. (str "Unexpected fetch URL in probe test: " url))))))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys []
             :keys-payload
             {"providers"
              {"openai"
               {"auth" "oauth_bearer"
                "accounts" [{"id" "openai-probe-a"
                             "access_token" (s/make-jwt {"https://api.openai.com/auth" {"chatgpt_account_id" "workspace-probe-a"
                                                                                       "chatgpt_plan_type" "free"}
                                                         "sub" "user-probe-a"})
                             "chatgpt_account_id" "workspace-probe-a"}]}}}
             :config-overrides {:openaiBaseUrl "https://chatgpt.com/backend-api"
                                :openaiResponsesPath "/codex/responses"}
             :upstream-handler (fn [_ _] (s/json-response 404 {"error" "not_used"}))}
            (fn ^:async run [{:keys [app]}]
              (let [response (await (s/inject app {:method "POST" :url "/api/v1/credentials/openai/probe"
                                                   :payload {"accountId" "openai-probe-a"}}))
                    payload (:json response)]
                (is (= 200 (:status response)))
                (is (map? payload))
                (is (= "ok" (get payload "status")))
                (is (true? (get payload "ok")))
                (is (true? (get payload "matchesExpectedOutput")))
                (is (= "hello" (get payload "outputText")))
                (is (= "gpt-5.4-mini" (get payload "model"))))))))))
    (let [{:keys [^js headers body]} (first @observed)]
      (is (= 1 (count @observed)))
      (is (= "workspace-probe-a" (.get headers "chatgpt-account-id")))
      (is (= "codex_cli_rs" (.get headers "originator")))
      (is (= "gpt-5.4-mini" (get body "model")))
      (is (= "none" (get-in body ["reasoning" "effort"])))
      (is (true? (get body "stream")))
      (is (false? (get body "store"))))))

(deftest ^:async probes-an-ollama-cloud-account-with-a-minimal-hello-request
  (await
   (s/with-proxy-app
     {:keys []
      :keys-payload {"providers" {"ollama-cloud" {"auth" "api_key"
                                                  "accounts" [{"id" "ollama-probe-a" "api_key" "ollama-cloud-key"}]}}}
      :upstream-handler
      (fn [request body]
        (is (= "POST" (.-method request)))
        (is (= "/api/chat" (.-url request)))
        (is (= "Bearer ollama-cloud-key" (s/header request "authorization")))
        (let [parsed (s/parse-json body)]
          (is (= "gemma4:31b" (get parsed "model")))
          (is (false? (get parsed "stream")))
          (is (false? (get parsed "think")))
          (is (vector? (get parsed "messages")))
          (is (map? (get-in parsed ["messages" 0])))
          (is (= "user" (get-in parsed ["messages" 0 "role"])))
          (is (= "Reply with exactly hello." (get-in parsed ["messages" 0 "content"]))))
        (s/json-response 200 {"model" "gemma4:31b" "created_at" "2026-04-21T00:00:00.000Z"
                              "message" {"role" "assistant" "content" "hello"}
                              "done" true "done_reason" "stop"}))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/inject app {:method "POST" :url "/api/v1/credentials/ollama-cloud/probe"
                                            :payload {"accountId" "ollama-probe-a"}}))
             payload (:json response)]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (= "ollama-cloud" (get payload "providerId")))
         (is (= "ollama-probe-a" (get payload "accountId")))
         (is (= "ok" (get payload "status")))
         (is (true? (get payload "ok")))
         (is (true? (get payload "matchesExpectedOutput")))
         (is (= "hello" (get payload "outputText")))
         (is (= "gemma4:31b" (get payload "model"))))))))
