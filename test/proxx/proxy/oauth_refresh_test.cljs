(ns proxx.proxy.oauth-refresh-test
  "OpenAI OAuth token refresh through the whole application: an expired
  account refreshes before it is used, a 401 refreshes before the account is
  given up on, and a terminal refresh failure clears the refresh token rather
  than retrying forever. The OAuth token endpoint is answered by a patched
  `fetch`; every other request reaches the real local upstream."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.support :as s]))

(def ^:private token-url "https://auth.openai.com/oauth/token")

(defn- chat [app payload] (s/post-json app "/v1/chat/completions" payload))

(defn- init-body [^js init] (let [body (when init (.-body init))] (if (string? body) body "")))

(defn- json-reply [status body]
  (js/Response. (s/json-str body) #js {"status" status "headers" #js {"content-type" "application/json"}}))

(defn- refresh-fetch
  "A patched-fetch handler answering the token endpoint with `reply` (after
  checking the refresh_token grant carries `refresh-token`) and counting calls
  in `calls`; anything else falls through to the real fetch."
  [calls refresh-token reply]
  (fn [input init _original]
    (when (= token-url (s/request-url input))
      (swap! calls inc)
      (let [body (init-body init)]
        (is (re-find #"grant_type=refresh_token" body))
        (is (str/includes? body (str "refresh_token=" refresh-token))))
      (js/Promise.resolve (reply)))))

(defn- header [response name] (get-in response [:headers name]))

(deftest ^:async falls-back-from-vivgrid-to-expired-openai-account-which-refreshes-token-before-gpt-5-4-fallback
  (let [observed (atom [])
        refresh-calls (atom 0)
        refreshed-access-token (s/make-jwt {"chatgpt_account_id" "cgpt-refreshed" "chatgpt_plan_type" "plus"})]
    (await
     (s/with-patched-fetch
       (refresh-fetch refresh-calls "expired-openai-refresh"
                      (fn [] (json-reply 200 {"access_token" refreshed-access-token
                                              "refresh_token" "refreshed-openai-refresh"
                                              "expires_in" 3600 "chatgpt_plan_type" "plus"})))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys [] :keys-payload
             {"providers"
              {"vivgrid" ["vivgrid-failing-key"]
               "openai" {"auth" "oauth_bearer"
                         "accounts" [{"id" "oa-expired-plus" "access_token" "expired-openai-access"
                                      "refresh_token" "expired-openai-refresh"
                                      "expires_at" (- (js/Date.now) 1000)
                                      "chatgpt_account_id" "cgpt-stale" "plan_type" "plus"}]}}}
             :config-overrides {:upstreamProviderId "vivgrid"}
             :upstream-handler
             (fn [request body]
               (if (s/embed-request? request)
                 (s/embed-response)
                 (let [auth (s/header request "authorization")]
                   (when-let [token (s/bearer-token request)] (swap! observed conj token))
                   (if (= auth "Bearer vivgrid-failing-key")
                     (s/json-response 429 {"retry-after" "60"} {"error" {"message" "rate limit"}})
                     (do
                       (is (= (str "Bearer " refreshed-access-token) auth))
                       (is (= "cgpt-refreshed" (s/header request "chatgpt-account-id")))
                       (is (= "gpt-5.4" (get (s/parse-json body) "model")))
                       (s/json-response
                        200 (s/response-output {:id "resp-refreshed-openai-fallback"
                                                :message-id "msg-refreshed-openai-fallback"
                                                :model "gpt-5.4" :created-at 1772916803
                                                :text "refreshed-openai-account-ok"})))))))}
            (fn ^:async run [{:keys [app]}]
              (let [response (await (chat app {"model" "gpt-5.4" "messages" [{"role" "user" "content" "hello"}]
                                               "stream" false}))
                    payload (:json response)]
                (is (= 200 (:status response)))
                (is (= "openai" (header response "x-open-hax-upstream-provider")))
                (is (= "openai_responses" (header response "x-open-hax-upstream-mode")))
                (is (= 1 @refresh-calls))
                (is (= ["vivgrid-failing-key" refreshed-access-token] @observed))
                (is (= "chat.completion" (get payload "object")))
                (is (vector? (get payload "choices")))
                (is (= "refreshed-openai-account-ok" (get-in payload ["choices" 0 "message" "content"]))))))))))))

(deftest ^:async refreshes-oauth-tokens-on-401-unauthorized-before-marking-rate-limited
  (let [observed (atom [])
        refresh-calls (atom 0)
        first-request (atom true)
        valid-access-token (s/make-jwt {"chatgpt_account_id" "cgpt-refreshed-from-401" "chatgpt_plan_type" "team"})]
    (await
     (s/with-patched-fetch
       (refresh-fetch refresh-calls "revoked-openai-refresh"
                      (fn [] (json-reply 200 {"access_token" valid-access-token
                                              "refresh_token" "refreshed-from-401-refresh"
                                              "expires_in" 3600 "chatgpt_plan_type" "team"})))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys [] :keys-payload
             {"providers"
              {"openai" {"auth" "oauth_bearer"
                         "accounts" [{"id" "oa-revoked-team" "access_token" "revoked-openai-access"
                                      "refresh_token" "revoked-openai-refresh"
                                      "expires_at" (+ (js/Date.now) 86400000)
                                      "chatgpt_account_id" "cgpt-revoked" "plan_type" "team"}]}}}
             :config-overrides {:upstreamProviderId "openai"}
             :upstream-handler
             (fn [request _body]
               (let [auth (s/header request "authorization")]
                 (when-let [token (s/bearer-token request)] (swap! observed conj token))
                 (if (and @first-request (= auth "Bearer revoked-openai-access"))
                   (do (reset! first-request false)
                       (s/json-response 401 {"error" {"message" "Unauthorized" "type" "invalid_request_error"}}))
                   (do
                     (is (= (str "Bearer " valid-access-token) auth))
                     (is (= "cgpt-refreshed-from-401" (s/header request "chatgpt-account-id")))
                     (s/json-response
                      200 {"id" "resp-refreshed-after-401" "object" "response" "created_at" 1772916803
                           "model" "gpt-5.4"
                           "output" [{"id" "msg-refreshed-after-401" "type" "message" "role" "assistant"
                                      "content" [{"type" "output_text" "text" "refreshed-after-401-ok"}]}]}))))) }
            (fn ^:async run [{:keys [app]}]
              (let [response (await (chat app {"model" "gpt-5.4" "messages" [{"role" "user" "content" "test"}]}))
                    payload (:json response)]
                (is (= 200 (:status response)))
                (is (= "openai" (header response "x-open-hax-upstream-provider")))
                (is (= "openai_responses" (header response "x-open-hax-upstream-mode")))
                (is (= 1 @refresh-calls))
                (is (= ["revoked-openai-access" valid-access-token] @observed))
                (is (= "chat.completion" (get payload "object")))
                (is (vector? (get payload "choices")))
                (is (= "refreshed-after-401-ok" (get-in payload ["choices" 0 "message" "content"]))))))))))))

(deftest ^:async terminal-openai-refresh-failures-clear-the-refresh-token-and-do-not-retry-indefinitely
  (let [refresh-calls (atom 0)]
    (await
     (s/with-patched-fetch
       (refresh-fetch
        refresh-calls "stale-openai-refresh"
        (fn [] (json-reply 401 {"error" {"message" "Your refresh token has already been used to generate a new access token. Please try signing in again."
                                         "type" "invalid_request_error"
                                         "code" "refresh_token_reused"}})))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys [] :keys-payload
             {"providers"
              {"openai" {"auth" "oauth_bearer"
                         "accounts" [{"id" "oa-terminal-refresh"
                                      "access_token" (s/make-jwt {"chatgpt_account_id" "cgpt-terminal-refresh"
                                                                  "chatgpt_plan_type" "free"
                                                                  "exp" (js/Math.floor (/ (- (js/Date.now) 60000) 1000))})
                                      "refresh_token" "stale-openai-refresh"
                                      "expires_at" (- (js/Date.now) 60000)
                                      "chatgpt_account_id" "cgpt-terminal-refresh" "plan_type" "free"}]}}}
             :config-overrides {:upstreamProviderId "openai"}
             :upstream-handler (fn [_ _] (s/json-response 200 {"object" "response" "output" []}))}
            (fn ^:async run [{:keys [app temp-dir]}]
              (let [first-response (await (chat app {"model" "gpt-5.4" "messages" [{"role" "user" "content" "hello"}]
                                                     "stream" false}))]
                (is (= 429 (:status first-response)))
                (is (= 1 @refresh-calls)))
              (let [second-response (await (chat app {"model" "gpt-5.4"
                                                      "messages" [{"role" "user" "content" "hello again"}]
                                                      "stream" false}))]
                (is (= 429 (:status second-response)))
                (is (= 1 @refresh-calls)))
              (let [persisted (s/parse-json (await (.readFile fsp (.join path temp-dir "keys.json") "utf8")))
                    account (get-in persisted ["providers" "openai" "accounts" 0])]
                (is (map? (get persisted "providers")))
                (is (map? (get-in persisted ["providers" "openai"])))
                (is (vector? (get-in persisted ["providers" "openai" "accounts"])))
                (is (map? account))
                (is (not (contains? account "refresh_token"))))))))))))
