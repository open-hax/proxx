(ns proxx.proxy.openai-codex-routing-test
  "OpenAI OAuth (codex) routing through the real application: Responses conversion,
  prompt_cache_key account affinity, and the codex-specific request rewrites."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json]]))

(def ^:private openai-overrides {:upstreamProviderId "openai"})

(defn- response-body
  "A Responses-API reply with one assistant message."
  [{:keys [id model text message-id usage]
    :or {usage {:input_tokens 11 :output_tokens 5 :total_tokens 16}}}]
  {:id id :object "response" :created_at 1772516810 :model model
   :output [{:id message-id :type "message" :role "assistant"
             :content [{:type "output_text" :text text}]}]
   :usage usage})

(defn- terminal-sse
  "response.created then response.completed carrying one `OK` message, as codex streams."
  [id model]
  (fx/sse-reply
   (fx/sse-frame "response.created" {:type "response.created" :response {:id id :status "in_progress" :model model :output []}})
   (fx/sse-frame "response.completed" {:type "response.completed"
                                       :response {:id id :status "completed" :model model
                                                  :output [{:type "message" :role "assistant" :content [{:type "output_text" :text "OK"}]}]
                                                  :usage {:input_tokens 5 :output_tokens 2 :total_tokens 7}}})))

(defn- chat-gpt [model content & [extra]]
  (merge {:model model :messages [{:role "user" :content content}] :stream false} extra))

(deftest ^:async routes-gpt-5-4-through-responses-for-openai-oauth-accounts
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload fx/oauth-openai-keys
        :config-overrides openai-overrides
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req)
                                          :body (fx/parse-json body)
                                          :authorization (fx/req-header req "authorization")
                                          :account-id (fx/req-header req "chatgpt-account-id")})
                            (fx/json-reply (response-body {:id "resp_gpt54_openai" :model "gpt-5.4" :text "OK" :message-id "msg_gpt54_openai"})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions" (chat-gpt "gpt-5.4" "Reply with exactly: OK")))
               {:keys [path body authorization account-id]} @seen
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "openai_responses" (get-in response [:headers "x-open-hax-upstream-mode"])))
           (is (= "/v1/responses" path))
           (is (= "Bearer oa-token-a" authorization))
           (is (= "chatgpt-a" account-id))
           (is (map? body))
           (is (= "gpt-5.4" (get body "model")))
           (is (vector? (get body "input")))
           (is (map? payload))
           (is (= "chat.completion" (get payload "object")))
           (is (= "gpt-5.4" (get payload "model")))
           (is (vector? (get payload "choices")))
           (is (= "OK" (get-in payload ["choices" 0 "message" "content"])))))))))

(deftest ^:async buffers-openai-responses-sse-deltas-into-chat-content-when-the-terminal-response-is-empty
  (await
   (with-proxy-app
     {:keys []
      :keys-payload fx/oauth-openai-keys
      :config-overrides openai-overrides
      :upstream-handler (fn [_ _]
                          (fx/sse-reply
                           (fx/sse-frame "response.created" {:type "response.created" :response {:id "resp_empty_terminal" :status "in_progress" :model "gpt-5.4-mini" :output []}})
                           (fx/sse-frame "response.output_text.delta" {:type "response.output_text.delta" :delta "OK"})
                           (fx/sse-frame "response.completed" {:type "response.completed"
                                                               :response {:id "resp_empty_terminal" :status "completed" :model "gpt-5.4-mini"
                                                                          :output [{:type "message" :role "assistant" :content []}]
                                                                          :usage {:input_tokens 5 :output_tokens 2 :total_tokens 7}}})))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions" (chat-gpt "gpt-5.4-mini" "Reply with exactly: OK")))
             payload (:json response)]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (vector? (get payload "choices")))
         (is (= "OK" (get-in payload ["choices" 0 "message" "content"]))))))))

(deftest ^:async reuses-the-same-openai-oauth-codex-account-for-repeated-gpt-prompt-cache-key-requests
  (let [auth (atom []) account-ids (atom []) cache-keys (atom [])]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload (fx/oauth-openai-keys-2)
        :config-overrides openai-overrides
        :upstream-handler (fn [req body]
                            (let [parsed (fx/parse-json body)]
                              (when-let [a (fx/bearer req)] (swap! auth conj a))
                              (when-let [a (fx/req-header req "chatgpt-account-id")] (swap! account-ids conj a))
                              (when-let [k (let [k (get parsed "prompt_cache_key")] (when (string? k) k))] (swap! cache-keys conj k))
                              (fx/json-reply (response-body {:id (js/crypto.randomUUID) :model "gpt-5.4" :text "OK" :message-id (js/crypto.randomUUID)}))))}
       (^:async fn [{:keys [app]}]
         (dotimes [_ 3]
           (let [response (await (post-json app "/v1/chat/completions"
                                            (chat-gpt "gpt-5.4" "Reply with exactly: OK" {:prompt_cache_key "sticky-gpt-oauth-1"})))]
             (is (= 200 (:status response)))))
         (is (= ["oa-token-a" "oa-token-a" "oa-token-a"] @auth))
         (is (= ["chatgpt-a" "chatgpt-a" "chatgpt-a"] @account-ids))
         (is (= ["sticky-gpt-oauth-1" "sticky-gpt-oauth-1" "sticky-gpt-oauth-1"] @cache-keys)))))))

(deftest ^:async reassigns-openai-oauth-codex-prompt-cache-key-affinity-when-the-pinned-gpt-account-becomes-rate-limited
  (let [auth (atom []) account-ids (atom []) a-attempts (atom 0)]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload (fx/oauth-openai-keys-2)
        :config-overrides openai-overrides
        :upstream-handler (fn [req _]
                            (let [a (fx/bearer req)]
                              (when a (swap! auth conj a))
                              (when-let [id (fx/req-header req "chatgpt-account-id")] (swap! account-ids conj id))
                              (if (and (= a "oa-token-a") (>= (swap! a-attempts inc) 2))
                                {:status 429
                                 :headers {"content-type" "application/json" "retry-after" "60"}
                                 :body (fx/json-str {:error {:message "rate limit"}})}
                                (fx/json-reply (response-body {:id (js/crypto.randomUUID) :model "gpt-5.4" :text "OK" :message-id (js/crypto.randomUUID)})))))}
       (^:async fn [{:keys [app]}]
         (let [payload (chat-gpt "gpt-5.4" "Reply with exactly: OK" {:prompt_cache_key "sticky-gpt-oauth-2"})]
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (is (= ["oa-token-a" "oa-token-a" "oa-token-b" "oa-token-b"] @auth))
           (is (= ["chatgpt-a" "chatgpt-a" "chatgpt-b" "chatgpt-b"] @account-ids))))))))

(deftest ^:async does-not-immediately-promote-fallback-affinity-after-one-successful-reassignment
  (let [auth (atom []) a-attempts (atom 0)]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload (fx/oauth-openai-keys-2)
        :config-overrides openai-overrides
        :upstream-handler (fn [req _]
                            (let [a (fx/bearer req)]
                              (when a (swap! auth conj a))
                              (if (and (= a "oa-token-a") (= 2 (swap! a-attempts inc)))
                                {:status 429
                                 :headers {"content-type" "application/json" "retry-after" "1"}
                                 :body (fx/json-str {:error {:message "daily quota exceeded"}})}
                                (fx/json-reply (response-body {:id (js/crypto.randomUUID) :model "gpt-5.4" :text "OK" :message-id (js/crypto.randomUUID)})))))}
       (^:async fn [{:keys [app]}]
         (let [payload (chat-gpt "gpt-5.4" "Reply with exactly: OK" {:prompt_cache_key "sticky-gpt-oauth-conservative-1"})]
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (await (js/Promise. (fn [resolve] (js/setTimeout resolve 1100))))
           (is (= 200 (:status (await (post-json app "/v1/chat/completions" payload)))))
           (is (= ["oa-token-a" "oa-token-a" "oa-token-b" "oa-token-a"] @auth))))))))

(deftest ^:async injects-instructions-for-gpt-5-4-mini-routed-through-openai-oauth
  ;; regression: codex instructions required
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload fx/oauth-openai-keys
        :config-overrides openai-overrides
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)})
                            (fx/json-reply (response-body {:id "resp_gpt52" :model "gpt-5.4-mini" :text "Hello" :message-id "msg_gpt52"
                                                           :usage {:input_tokens 10 :output_tokens 5 :total_tokens 15}})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions" (chat-gpt "gpt-5.4-mini" "hello")))
               {:keys [path body]} @seen
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "/v1/responses" path))
           (is (some? body))
           (is (vector? (get body "input")) "payload must use responses input format")
           (is (string? (get body "instructions")) "instructions must be a string")
           (is (= false (get body "store")))
           (is (= true (get body "stream")))
           (is (map? payload))
           (is (= "chat.completion" (get payload "object")))
           (is (= "gpt-5.4-mini" (get payload "model")))))))))

(deftest ^:async openai-passthrough-coerces-null-instructions-to-empty-string
  ;; regression: codex instructions required
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload fx/oauth-openai-keys
        :config-overrides openai-overrides
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (terminal-sse "resp_pt" "gpt-5.4-mini"))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/responses"
                                          {:model "gpt-5.4-mini"
                                           :input [{:role "user" :content [{:type "input_text" :text "hello"}]}]
                                           :instructions nil
                                           :stream true}))]
           (is (= 200 (:status response)))
           (is (some? @seen))
           (is (= "" (get @seen "instructions")) "null instructions must be coerced to empty string")
           (is (= false (get @seen "store")))
           (is (= true (get @seen "stream")))))))))

(deftest ^:async openai-passthrough-still-reaches-codex-when-provider-catalog-lookup-is-unavailable
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload fx/oauth-openai-keys
        :config-overrides openai-overrides
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)})
                            (terminal-sse "resp_gpt54" "gpt-5.4"))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/responses"
                                          {:model "gpt-5.4"
                                           :input [{:role "user" :content [{:type "input_text" :text "hello"}]}]
                                           :instructions ""
                                           :stream true}))]
           (is (= 200 (:status response)))
           (is (= "/v1/responses" (:path @seen)))
           (is (some? (:body @seen)))
           (is (= "gpt-5.4" (get (:body @seen) "model")))))))))

(deftest ^:async openai-passthrough-strips-codex-unsupported-response-parameters
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload fx/oauth-openai-keys
        :config-overrides openai-overrides
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (terminal-sse "resp_mot" "gpt-5.4-mini"))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/responses"
                                          {:model "gpt-5.4-mini"
                                           :input [{:role "user" :content [{:type "input_text" :text "hello"}]}]
                                           :instructions ""
                                           :max_output_tokens 32000
                                           :prompt_cache_retention "24h"
                                           :stream true}))]
           (is (= 200 (:status response)))
           (is (some? @seen))
           (is (not (contains? @seen "max_output_tokens")) "max_output_tokens must be stripped for codex path")
           (is (not (contains? @seen "prompt_cache_retention")) "prompt_cache_retention must be stripped for codex path")))))))

(deftest ^:async openai-responses-passthrough-closes-stalled-streaming-bodies
  (await
   (with-proxy-app
     {:keys []
      :keys-payload fx/oauth-openai-keys
      :config-overrides {:upstreamProviderId "openai" :requestTimeoutMs 25 :streamBootstrapTimeoutMs 25}
      :upstream-handler (fn [_ _]
                          {:status 200
                           :headers {"content-type" "text/event-stream; charset=utf-8"}
                           :stream-body (^:async fn [^js response]
                                         (.write response (fx/sse-frame "response.created"
                                                                        {:type "response.created"
                                                                         :response {:id "resp_stalled" :status "in_progress" :model "gpt-5.5" :output []}}))
                                         (await (.once (js/require "node:events") response "close")))})}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/responses"
                                        {:model "gpt-5.5"
                                         :input [{:role "user" :content [{:type "input_text" :text "hello"}]}]
                                         :instructions ""
                                         :stream true}))]
         (is (= 200 (:status response)))
         (is (re-find #"response\.created" (:body response))))))))

(deftest ^:async openai-chat-completions-strategy-converts-gpt-requests-to-responses-format-for-codex-path
  ;; regression
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload fx/oauth-openai-keys
        :models ["gpt-5.4"]
        :config-overrides {:upstreamProviderId "openai" :responsesModelPrefixes ["gpt-"]}
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)})
                            (fx/json-reply (response-body {:id "resp_gpt54" :model "gpt-5.4" :text "GPT response" :message-id "msg_gpt54"
                                                           :usage {:input_tokens 8 :output_tokens 3 :total_tokens 11}})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions" (chat-gpt "gpt-5.4" "hello")))
               {:keys [path body]} @seen]
           (is (= 200 (:status response)))
           (is (= "/v1/responses" path))
           (is (some? body))
           (is (vector? (get body "input")) "payload must use responses input format")
           (is (string? (get body "instructions")) "instructions must be a string")
           (is (= false (get body "store")))
           (is (= true (get body "stream")))
           (is (not (contains? body "messages")) "messages must not be sent to codex path")
           (is (map? (:json response)))
           (is (= "chat.completion" (get (:json response) "object")))))))))
