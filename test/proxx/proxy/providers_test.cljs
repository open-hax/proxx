(ns proxx.proxy.providers-test
  "Provider-specific upstream routing through the whole application: OpenRouter,
  Requesty, OB1, Gemini, z.ai and Mistral."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.support :as s]))

(def ^:private no-other-gateways
  {"OPENROUTER_API_KEY" nil "REQUESTY_API_TOKEN" nil "REQUESTY_API_KEY" nil
   "OPENROUTER_PROVIDER_ID" nil "REQUESTY_PROVIDER_ID" nil})

(def ^:private hello-claude
  {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]})

(defn- upstream
  "An upstream handler answering the proxy's embedding probes itself and everything else with `f`."
  [f]
  (fn [request body]
    (if (s/embed-request? request) (s/embed-response) (f request body))))

;; ---------------------------------------------------------------------------
;; Claude models through chat completions
;; ---------------------------------------------------------------------------

(deftest ^:async routes-claude-models-through-chat-completions-for-the-openrouter-provider
  (await
   (s/with-env-proxy-app
     (assoc no-other-gateways "OPENROUTER_API_KEY" "or-token-1") ; pragma: allowlist secret
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "openrouter"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (= "/v1/chat/completions" (.-url request)))
                  (is (re-find #"claude-opus-4-5" body))
                  (s/json-response 200 (s/chat-completion "cmpl-openrouter" "claude-opus-4-5" "ok"))))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions" hello-claude s/local-auth))]
         (is (= 200 (:status response))))))))

(deftest ^:async routes-claude-models-through-chat-completions-for-the-requesty-provider
  (await
   (s/with-env-proxy-app
     (assoc no-other-gateways "REQUESTY_API_TOKEN" "req-token-1")
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "requesty"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (= "/v1/chat/completions" (.-url request)))
                  (is (re-find #"claude-opus-4-5" body))
                  (s/json-response 200 (s/chat-completion "cmpl-requesty" "claude-opus-4-5" "ok"))))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions" hello-claude s/local-auth))]
         (is (= 200 (:status response))))))))

(deftest ^:async routes-claude-models-through-chat-completions-for-the-ob1-provider
  (await
   (s/with-proxy-app
     {:keys [] :keys-payload {"providers" {"ob1" {"auth" "api_key" "accounts" ["ob1-key-1"]}}}
      :config-overrides {:upstreamProviderId "ob1"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (= "/v1/chat/completions" (.-url request)))
                  (is (re-find #"claude-opus-4-5" body))
                  (is (= "Bearer ob1-key-1" (s/header request "authorization")))
                  (s/json-response 200 (s/chat-completion "cmpl-ob1" "claude-opus-4-5" "ok"))))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions" hello-claude s/local-auth))]
         (is (= 200 (:status response))))))))

;; ---------------------------------------------------------------------------
;; Requesty: responses and images
;; ---------------------------------------------------------------------------

(deftest ^:async routes-v1-responses-through-requesty-when-requesty-api-key-is-configured
  (await
   (s/with-env-proxy-app
     (assoc no-other-gateways "REQUESTY_API_KEY" "req-token-1" "GEMINI_API_KEY" nil "GEMINI_PROVIDER_ID" nil) ; pragma: allowlist secret
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "requesty"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (= "/v1/responses" (.-url request)))
                  (is (= "openai/gpt-image-1" (get (s/parse-json body) "model")))
                  (s/json-response 200 {"id" "resp-requesty" "object" "response"})))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/inject app {:method "POST" :url "/v1/responses"
                                            :payload {"model" "gpt-image-1" "input" "draw a cat" "stream" false}
                                            :headers s/local-auth}))]
         (is (= 200 (:status response)))
         (is (map? (:json response)))
         (is (= "resp-requesty" (get (:json response) "id"))))))))

(deftest ^:async requesty-gpt-chat-requests-route-through-v1-responses-with-prefixed-model-and-normalized-reasoning-summary
  (let [observed-path (atom "")
        observed-body (atom nil)]
    (await
     (s/with-env-proxy-app
       (assoc no-other-gateways "REQUESTY_API_TOKEN" "req-token-1" "GEMINI_API_KEY" nil "GEMINI_PROVIDER_ID" nil)
       {:keys [] :keys-payload {"providers" {}}
        :config-overrides {:upstreamProviderId "requesty"}
        :upstream-handler
        (upstream (fn [request body]
                    (reset! observed-path (or (.-url request) ""))
                    (reset! observed-body (s/parse-json body))
                    (s/json-response
                     200
                     (s/response-output {:id "resp_requesty_gpt54_chat" :message-id "msg_requesty_gpt54_chat"
                                         :model "gpt-5.4" :created-at 1772516800 :text "requesty-gpt-chat-ok"
                                         :usage {"input_tokens" 7 "output_tokens" 4 "total_tokens" 11}}))))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (s/post-json app "/v1/chat/completions"
                                            {"model" "gpt-5.4" "messages" [{"role" "user" "content" "hello"}]
                                             "stream" false "reasoningSummary" "auto"}
                                            s/local-auth))
               headers (:headers response)
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "requesty" (get headers "x-open-hax-upstream-provider")))
           (is (= "responses" (get headers "x-open-hax-upstream-mode")))
           (is (= "/v1/responses" @observed-path))
           (is (map? @observed-body))
           (is (= "openai/gpt-5.4" (get @observed-body "model")))
           (is (map? (get @observed-body "reasoning")))
           (is (= "auto" (get-in @observed-body ["reasoning" "summary"])))
           (is (not (contains? @observed-body "reasoning_summary")))
           (is (map? payload))
           (is (= "chat.completion" (get payload "object")))
           (is (vector? (get payload "choices")))
           (is (= "requesty-gpt-chat-ok" (get-in payload ["choices" 0 "message" "content"])))))))))

(deftest ^:async requesty-v1-responses-preserves-nested-reasoning-summary-for-gpt-models
  (let [observed-path (atom "")
        observed-body (atom nil)]
    (await
     (s/with-env-proxy-app
       (assoc no-other-gateways "REQUESTY_API_TOKEN" "req-token-1" "GEMINI_API_KEY" nil "GEMINI_PROVIDER_ID" nil)
       {:keys [] :keys-payload {"providers" {}}
        :config-overrides {:upstreamProviderId "requesty"}
        :upstream-handler
        (upstream (fn [request body]
                    (reset! observed-path (or (.-url request) ""))
                    (reset! observed-body (s/parse-json body))
                    (s/json-response
                     200
                     (s/response-output {:id "resp_requesty_nested_reasoning" :message-id "msg_requesty_nested_reasoning"
                                         :model "gpt-5.4" :created-at 1772516800 :text "requesty-nested-reasoning-ok"
                                         :usage {"input_tokens" 8 "output_tokens" 4 "total_tokens" 12}}))))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (s/post-json app "/v1/responses"
                                            {"model" "gpt-5.4" "input" "hello" "stream" false
                                             "reasoning" {"summary" "auto" "effort" "low"}}
                                            s/local-auth))
               headers (:headers response)]
           (is (= 200 (:status response)))
           (is (= "requesty" (get headers "x-open-hax-upstream-provider")))
           (is (= "responses_passthrough" (get headers "x-open-hax-upstream-mode")))
           (is (= "/v1/responses" @observed-path))
           (is (map? @observed-body))
           (is (= "openai/gpt-5.4" (get @observed-body "model")))
           (is (map? (get @observed-body "reasoning")))
           (is (= "auto" (get-in @observed-body ["reasoning" "summary"])))
           (is (= "low" (get-in @observed-body ["reasoning" "effort"])))
           (is (not (contains? @observed-body "reasoning_summary")))
           (is (map? (:json response)))
           (is (= "resp_requesty_nested_reasoning" (get (:json response) "id")))))))))

(deftest ^:async routes-v1-images-generations-through-requesty
  (await
   (s/with-env-proxy-app
     (assoc no-other-gateways "REQUESTY_API_TOKEN" "req-token-1" "GEMINI_API_KEY" nil "GEMINI_PROVIDER_ID" nil)
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "requesty"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (= "/v1/images/generations" (.-url request)))
                  (is (= "openai/gpt-image-1" (get (s/parse-json body) "model")))
                  (s/json-response 200 {"created" 1 "data" [{"b64_json" "AAAA"}]})))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/images/generations"
                                          {"model" "gpt-image-1" "prompt" "a red square" "response_format" "b64_json"}
                                          s/local-auth))]
         (is (= 200 (:status response)))
         (is (map? (:json response)))
         (is (= [{"b64_json" "AAAA"}] (get (:json response) "data"))))))))

;; ---------------------------------------------------------------------------
;; Gemini (native generateContent)
;; ---------------------------------------------------------------------------

(def ^:private gemini-env
  (assoc no-other-gateways "GEMINI_API_KEY" "gem-key-1" "GEMINI_PROVIDER_ID" nil)) ; pragma: allowlist secret

(deftest ^:async routes-chat-completions-through-native-gemini-generate-content-when-gemini-api-key-is-configured
  (await
   (s/with-env-proxy-app
     gemini-env
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "gemini"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (re-find #"/models/gemini-2\.5-pro:generateContent$" (or (.-url request) "")))
                  (is (= "gem-key-1" (s/header request "x-goog-api-key")))
                  (is (nil? (s/header request "authorization")))
                  (is (vector? (get (s/parse-json body) "contents")))
                  (s/json-response
                   200
                   {"candidates" [{"content" {"role" "model" "parts" [{"text" "hi"}]} "finishReason" "STOP"}]
                    "usageMetadata" {"promptTokenCount" 1 "candidatesTokenCount" 2 "totalTokenCount" 3}})))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions"
                                          {"model" "gemini-2.5-pro" "messages" [{"role" "user" "content" "hello"}] "stream" false}
                                          s/local-auth))
             payload (:json response)]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (= "chat.completion" (get payload "object")))
         (is (= "hi" (get-in payload ["choices" 0 "message" "content"])))
         (is (= 3 (get-in payload ["usage" "total_tokens"]))))))))

(deftest ^:async maps-gemini-2-5-flash-reasoning-effort-to-thinking-budget-and-reasoning-content
  (await
   (s/with-env-proxy-app
     gemini-env
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "gemini"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (re-find #"/models/gemini-2\.5-flash:generateContent$" (or (.-url request) "")))
                  (let [thinking (get-in (s/parse-json body) ["generationConfig" "thinkingConfig"])]
                    (is (map? (get (s/parse-json body) "generationConfig")))
                    (is (map? thinking))
                    (is (= 24576 (get thinking "thinkingBudget")))
                    (is (true? (get thinking "includeThoughts"))))
                  (s/json-response
                   200
                   {"candidates" [{"content" {"role" "model"
                                              "parts" [{"text" "gemini-thought" "thought" true}
                                                       {"text" "gemini-answer"}]}
                                   "finishReason" "STOP"}]
                    "usageMetadata" {"promptTokenCount" 1 "candidatesTokenCount" 2 "totalTokenCount" 3}})))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/inject app {:method "POST" :url "/v1/chat/completions"
                                            :payload {"model" "gemini-2.5-flash"
                                                      "messages" [{"role" "user" "content" "hello"}]
                                                      "reasoning_effort" "xhigh"
                                                      "include" ["reasoning.encrypted_content"]
                                                      "stream" false}}))
             payload (:json response)]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (= "gemini-answer" (get-in payload ["choices" 0 "message" "content"])))
         (is (= "gemini-thought" (get-in payload ["choices" 0 "message" "reasoning_content"]))))))))

(deftest ^:async maps-gemini-3-1-pro-reasoning-effort-to-thinking-level
  (await
   (s/with-env-proxy-app
     gemini-env
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "gemini"}
      :upstream-handler
      (upstream (fn [request body]
                  (is (re-find #"/models/gemini-3\.1-pro-preview:generateContent$" (or (.-url request) "")))
                  (let [config (get (s/parse-json body) "generationConfig")]
                    (is (map? config))
                    (is (map? (get config "thinkingConfig")))
                    (is (= "HIGH" (get-in config ["thinkingConfig" "thinkingLevel"]))))
                  (s/json-response
                   200
                   {"candidates" [{"content" {"role" "model" "parts" [{"text" "hi"}]} "finishReason" "STOP"}]
                    "usageMetadata" {"promptTokenCount" 1 "candidatesTokenCount" 2 "totalTokenCount" 3}})))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/inject app {:method "POST" :url "/v1/chat/completions"
                                            :payload {"model" "gemini-3.1-pro-preview"
                                                      "messages" [{"role" "user" "content" "hello"}]
                                                      "reasoning_effort" "xhigh" "stream" false}}))]
         (is (= 200 (:status response))))))))

;; ---------------------------------------------------------------------------
;; z.ai
;; ---------------------------------------------------------------------------

(deftest ^:async routes-glm-chat-requests-through-z-ai-custom-chat-completions-path-when-zai-api-key-is-configured
  (await
   (s/with-zai-proxy-app
     (fn [request body]
       ;; The proxy also asks z.ai for its model catalog; only the chat request is under test.
       ;; (The TypeScript handler's assertions threw on that call, which the proxy absorbed as a 500.)
       (if (= "/api/paas/v4/models" (.-url request))
         (s/json-response 500 {"error" {"message" "catalog request is not under test"}})
         (do
           (is (= "/api/paas/v4/chat/completions" (.-url request)))
           (is (= "Bearer zai-key-1" (s/header request "authorization")))
           (let [parsed (s/parse-json body)]
             (is (= "glm-5" (get parsed "model")))
             (is (vector? (get parsed "messages"))))
           (s/json-response 200 (assoc (s/chat-completion "chatcmpl_zai" "glm-5" "zai-glm-ok") "created" 1772516801)))))
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions"
                                          {"model" "glm-5" "messages" [{"role" "user" "content" "hello"}] "stream" false}))]
         (is (= 200 (:status response)))
         (is (= "zai" (get-in response [:headers "x-open-hax-upstream-provider"])))
         (is (map? (:json response)))
         (is (= "zai-glm-ok" (get-in (:json response) ["choices" 0 "message" "content"]))))))))

(deftest ^:async lists-z-ai-models-through-the-custom-models-path-when-zai-api-key-is-configured
  (await
   (s/with-zai-proxy-app
     (fn [request _body]
       (is (= "/api/paas/v4/models" (.-url request)))
       (s/json-response 200 {"object" "list" "data" [{"id" "glm-5"} {"id" "glm-4.7-flash"}]}))
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/inject app {:method "GET" :url "/v1/models"}))
             payload (:json response)
             ids (set (map #(when (map? %) (get % "id")) (get payload "data")))]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (= "list" (get payload "object")))
         (is (vector? (get payload "data")))
         (is (contains? ids "glm-5"))
         (is (contains? ids "glm-4.7-flash")))))))

(deftest ^:async records-z-ai-chat-completions-usage-in-request-logs
  (await
   (s/with-zai-proxy-app
     (fn [_request _body]
       (s/json-response
        200
        (assoc (s/chat-completion "chatcmpl_zai_usage" "glm-5-turbo" "zai-usage-ok")
               "created" 1772516801
               "usage" {"prompt_tokens" 11 "completion_tokens" 7 "total_tokens" 18
                        "prompt_tokens_details" {"cached_tokens" 3}
                        "completion_tokens_details" {"reasoning_tokens" 5}})))
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions"
                                          {"model" "glm-5-turbo" "messages" [{"role" "user" "content" "hello"}] "stream" false}))
             logs (await (s/inject app {:method "GET" :url "/api/v1/request-logs?providerId=zai&limit=1"}))
             payload (:json logs)
             entry (get-in payload ["entries" 0])]
         (is (= 200 (:status response)))
         (is (= 200 (:status logs)))
         (is (map? payload))
         (is (vector? (get payload "entries")))
         (is (map? entry))
         (is (= "zai" (get entry "providerId")))
         (is (= 11 (get entry "promptTokens")))
         (is (= 7 (get entry "completionTokens")))
         (is (= 18 (get entry "totalTokens")))
         (is (= 3 (get entry "cachedPromptTokens")))
         (is (true? (get entry "cacheHit"))))))))

;; ---------------------------------------------------------------------------
;; Mistral
;; ---------------------------------------------------------------------------

(deftest ^:async routes-mistral-chat-requests-through-env-backed-mistral-provider
  (await
   (s/with-env-proxy-app
     {"MISTRAL_API_KEY" "mistral-key-1" ; pragma: allowlist secret
      "MISTRAL_PROVIDER_ID" nil "GEMINI_API_KEY" nil "OPENROUTER_API_KEY" nil
      "REQUESTY_API_TOKEN" nil "REQUESTY_API_KEY" nil}
     {:keys [] :keys-payload {"providers" {}}
      :config-overrides {:upstreamProviderId "mistral" :localOllamaEnabled false}
      :upstream-handler
      (fn [request body]
        (is (= "/v1/chat/completions" (.-url request)))
        (is (= "Bearer mistral-key-1" (s/header request "authorization")))
        (let [parsed (s/parse-json body)]
          (is (= "mistral-small-latest" (get parsed "model")))
          (is (vector? (get parsed "messages"))))
        (s/json-response 200 (assoc (s/chat-completion "chatcmpl_mistral" "mistral-small-latest" "mistral-ok")
                                    "created" 1772516801)))}
     (fn ^:async run [{:keys [app]}]
       (let [response (await (s/post-json app "/v1/chat/completions"
                                          {"model" "mistral-small-latest" "messages" [{"role" "user" "content" "hello"}] "stream" false}))]
         (is (= 200 (:status response)))
         (is (= "mistral" (get-in response [:headers "x-open-hax-upstream-provider"])))
         (is (map? (:json response)))
         (is (= "mistral-ok" (get-in (:json response) ["choices" 0 "message" "content"]))))))))
