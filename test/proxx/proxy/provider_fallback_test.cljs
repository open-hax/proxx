(ns proxx.proxy.provider-fallback-test
  "Provider ordering and fallback across providers and accounts through the
  whole application: glm prefers z.ai, a missing model moves on to the next
  account, and gpt models fall back between vivgrid and Codex OAuth accounts
  (free before paid where the model allows it)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.support :as s]))

(def ^:private hello {"role" "user" "content" "hello"})

(defn- chat [app payload] (s/post-json app "/v1/chat/completions" payload))

(defn- observe!
  "Record the bearer token of `request` in `observed`, when it has one."
  [observed request]
  (when-let [token (s/bearer-token request)] (swap! observed conj token)))

(defn- first-message-content [response]
  (get-in (:json response) ["choices" 0 "message" "content"]))

(defn- rate-limited []
  (s/json-response 429 {"retry-after" "60"} {"error" {"message" "rate limit"}}))

(defn- unauthorized [message]
  (s/json-response 401 {"error" {"message" message}}))

(defn- header [response name] (get-in response [:headers name]))

;; ---------------------------------------------------------------------------
;; glm and model-not-found
;; ---------------------------------------------------------------------------

(deftest ^:async prefers-zai-over-vivgrid-for-glm-shared-models-when-both-are-available
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers" {"vivgrid" ["vivgrid-failing-key"] "zai" ["zai-working-key"]}}
        :config-overrides {:upstreamProviderId "vivgrid"}
        :upstream-handler
        (fn [request _body]
          (when (= "POST" (.-method ^js request)) (observe! observed request))
          (if (= "Bearer vivgrid-failing-key" (s/header request "authorization"))
            (unauthorized "unauthorized")
            (s/json-response 200 {"id" "chatcmpl-provider-fallback-1" "object" "chat.completion" "model" "glm-5"
                                  "choices" [{"index" 0
                                              "message" {"role" "assistant" "content" "provider-fallback-ok"}
                                              "finish_reason" "stop"}]})))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "glm-5" "messages" [hello] "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "zai" (header response "x-open-hax-upstream-provider")))
           (is (= ["zai-working-key"] @observed))
           (is (vector? (get (:json response) "choices")))
           (is (= "provider-fallback-ok" (first-message-content response)))))))))

(deftest ^:async continues-trying-accounts-after-model-not-found-response
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers" {"requesty" ["requesty-missing-a" "requesty-missing-b"]
                                             "vivgrid" ["vivgrid-working-key"]}}
        :config-overrides {:upstreamProviderId "requesty"}
        :upstream-handler
        (fn [request body]
          (when (= "POST" (.-method ^js request)) (observe! observed request))
          (if (contains? #{"Bearer requesty-missing-a" "Bearer requesty-missing-b"}
                         (s/header request "authorization"))
            (s/json-response 404 {"error" {"message" "model \"glm-5\" not found"}})
            (do
              (is (= "glm-5" (get (s/parse-json body) "model")))
              (s/json-response 200 {"id" "chatcmpl-model-found-fallback" "object" "chat.completion"
                                    "created" 1772516816 "model" "glm-5"
                                    "choices" [{"index" 0
                                                "message" {"role" "assistant" "content" "fallback-after-missing-model"}
                                                "finish_reason" "stop"}]
                                    "usage" {"prompt_tokens" 5 "completion_tokens" 5 "total_tokens" 10}}))))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "glm-5" "messages" [hello] "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "vivgrid" (header response "x-open-hax-upstream-provider")))
           (is (= 2 (count (filter #{"requesty-missing-a" "requesty-missing-b"} @observed))))
           (is (= "vivgrid-working-key" (last @observed)))
           (is (vector? (get (:json response) "choices")))
           (is (= "fallback-after-missing-model" (first-message-content response)))))))))

(deftest ^:async glm-provider-ordering-uses-zai-before-vivgrid-candidate-keys
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers" {"vivgrid" ["vivgrid-bad-a" "vivgrid-bad-b" "vivgrid-bad-c"]
                                             "zai" ["zai-good"]}}
        :config-overrides {:upstreamProviderId "vivgrid"}
        :upstream-handler
        (fn [request _body]
          (cond
            (not= "POST" (.-method ^js request)) (s/json-response 404 {"error" {"message" "not_found"}})
            :else
            (do (observe! observed request)
                (if (= "Bearer zai-good" (s/header request "authorization"))
                  (s/json-response 200 {"id" "chatcmpl-provider-interleave-ok" "object" "chat.completion" "choices" []})
                  (unauthorized "invalid key")))))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "glm-5" "messages" [hello] "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "zai" (header response "x-open-hax-upstream-provider")))
           (is (= ["zai-good"] @observed))))))))

;; ---------------------------------------------------------------------------
;; gpt models: vivgrid and Codex OAuth accounts
;; ---------------------------------------------------------------------------

(defn- responses-answer [opts]
  (s/json-response 200 (s/response-output opts)))

(deftest ^:async falls-back-from-openai-prefixed-codex-route-to-standard-fallback-providers
  (let [paths (atom [])
        observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers" {"openai" [{"id" "oa-a" "access_token" "openai-rate-limited"
                                                        "chatgpt_account_id" "cgpt-a"}]
                                             "vivgrid" ["vivgrid-working-key"]}}
        :config-overrides {:upstreamProviderId "vivgrid"}
        :upstream-handler
        (fn [request body]
          (if (s/embed-request? request)
            (s/embed-response)
            (do
              (observe! observed request)
              (swap! paths conj (or (.-url ^js request) ""))
              (if (= "Bearer openai-rate-limited" (s/header request "authorization"))
                (rate-limited)
                (do (is (= "gpt-5.4" (get (s/parse-json body) "model")))
                    (responses-answer {:id "resp-openai-fallback-standard-provider"
                                       :message-id "msg-openai-fallback-standard-provider"
                                       :model "gpt-5.4" :created-at 1772916800
                                       :text "standard-provider-fallback-ok"}))))))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "openai/gpt-5.4" "messages" [hello] "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "vivgrid" (header response "x-open-hax-upstream-provider")))
           (is (= "responses" (header response "x-open-hax-upstream-mode")))
           (is (= ["/v1/responses" "/v1/responses"] @paths))
           (is (= ["openai-rate-limited" "vivgrid-working-key"] @observed))
           (is (= "chat.completion" (get (:json response) "object")))
           (is (vector? (get (:json response) "choices")))
           (is (= "standard-provider-fallback-ok" (first-message-content response)))))))))

(deftest ^:async falls-back-from-vivgrid-to-codex-oauth-accounts-for-gpt-routing
  (let [paths (atom [])
        observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers" {"vivgrid" ["vivgrid-rate-limited"]
                                             "openai" [{"id" "oa-fallback" "access_token" "openai-codex-working"
                                                        "chatgpt_account_id" "cgpt-fallback"}]}}
        :config-overrides {:upstreamProviderId "vivgrid"}
        :upstream-handler
        (fn [request body]
          (if (s/embed-request? request)
            (s/embed-response)
            (do
              (observe! observed request)
              (swap! paths conj (or (.-url ^js request) ""))
              (if (= "Bearer vivgrid-rate-limited" (s/header request "authorization"))
                (rate-limited)
                (let [model (get (s/parse-json body) "model")]
                  (if (= "nomic-embed-text:latest" model)
                    (s/embed-response)
                    (do (is (= "gpt-5.4" model))
                        (is (= "cgpt-fallback" (s/header request "chatgpt-account-id")))
                        (responses-answer {:id "resp-standard-openai-fallback"
                                           :message-id "msg-standard-openai-fallback"
                                           :model "gpt-5.4" :created-at 1772916801
                                           :text "codex-oauth-fallback-ok"})))))))) }
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "gpt-5.4" "messages" [hello] "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "openai" (header response "x-open-hax-upstream-provider")))
           (is (= "openai_responses" (header response "x-open-hax-upstream-mode")))
           (is (= ["/v1/responses" "/v1/responses"] @paths))
           (is (= ["vivgrid-rate-limited" "openai-codex-working"] @observed))
           (is (= "chat.completion" (get (:json response) "object")))
           (is (vector? (get (:json response) "choices")))
           (is (= "codex-oauth-fallback-ok" (first-message-content response)))))))))

(deftest ^:async falls-back-from-vivgrid-through-free-codex-oauth-to-paid-accounts-for-gpt-5-4
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers"
                                {"vivgrid" ["vivgrid-failing-key"]
                                 "openai" {"auth" "oauth_bearer"
                                           "accounts" [{"id" "oa-free" "access_token" "openai-free-unsupported"
                                                        "chatgpt_account_id" "cgpt-free" "plan_type" "free"}
                                                       {"id" "oa-plus" "access_token" "openai-plus-working"
                                                        "chatgpt_account_id" "cgpt-plus" "plan_type" "plus"}]}}}
        :config-overrides {:upstreamProviderId "vivgrid"}
        :upstream-handler
        (fn [request body]
          (if (s/embed-request? request)
            (s/embed-response)
            (do
              (observe! observed request)
              (let [auth (s/header request "authorization")]
                (cond
                  (= auth "Bearer vivgrid-failing-key") (unauthorized "unauthorized")

                  (= auth "Bearer openai-free-unsupported")
                  (s/json-response 400 {"detail" "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."})

                  :else
                  (let [model (get (s/parse-json body) "model")]
                    (if (not= "gpt-5.4" model)
                      (s/embed-response)
                      (do (is (= "cgpt-plus" (s/header request "chatgpt-account-id")))
                          (responses-answer {:id "resp-paid-openai-fallback"
                                             :message-id "msg-paid-openai-fallback"
                                             :model "gpt-5.4" :created-at 1772916802
                                             :text "paid-codex-account-ok"}))))))))) }
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "gpt-5.4" "messages" [hello]
                                          "max_completion_tokens" 8 "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "openai" (header response "x-open-hax-upstream-provider")))
           (is (= "openai_responses" (header response "x-open-hax-upstream-mode")))
           (is (= ["vivgrid-failing-key" "openai-free-unsupported" "openai-plus-working"] @observed))
           (is (= "chat.completion" (get (:json response) "object")))
           (is (vector? (get (:json response) "choices")))
           (is (= "paid-codex-account-ok" (first-message-content response)))))))))

(deftest ^:async prefers-free-codex-oauth-accounts-for-gpt-5-4-mini-before-paid-accounts
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers"
                                {"openai" {"auth" "oauth_bearer"
                                           "accounts" [{"id" "oa-plus" "access_token" "openai-plus-second"
                                                        "chatgpt_account_id" "cgpt-plus" "plan_type" "plus"}
                                                       {"id" "oa-free" "access_token" "openai-free-first"
                                                        "chatgpt_account_id" "cgpt-free" "plan_type" "free"}]}}}
        :config-overrides {:upstreamProviderId "openai"}
        :upstream-handler
        (fn [request body]
          (observe! observed request)
          (is (= "gpt-5.4-mini" (get (s/parse-json body) "model")))
          (is (= "cgpt-free" (s/header request "chatgpt-account-id")))
          (responses-answer {:id "resp-free-openai-priority" :message-id "msg-free-openai-priority"
                             :model "gpt-5.4-mini" :created-at 1772916804 :text "free-first-ok"
                             :usage {"input_tokens" 9 "output_tokens" 4 "total_tokens" 13}}))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app {"model" "gpt-5.4-mini" "messages" [hello] "stream" false}))]
           (is (= 200 (:status response)))
           (is (= "openai" (header response "x-open-hax-upstream-provider")))
           (is (= "openai_responses" (header response "x-open-hax-upstream-mode")))
           (is (= ["openai-free-first"] @observed))
           (is (= "chat.completion" (get (:json response) "object")))
           (is (= "gpt-5.4-mini" (get (:json response) "model")))
           (is (vector? (get (:json response) "choices")))
           (is (= "free-first-ok" (first-message-content response)))))))))
