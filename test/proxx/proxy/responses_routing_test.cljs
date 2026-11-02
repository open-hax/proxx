(ns proxx.proxy.responses-routing-test
  "Port of the chat-to-responses / chat-completions routing and reasoning-trace failover tests of
  src/tests/proxy.test.ts (end to end through the application)."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(defn- responses-reply [id model text usage]
  (h/json-reply 200 (cond-> {:id id :object "response" :created_at 1772516800 :model model
                             :output [{:id (str "msg_" id) :type "message" :role "assistant"
                                       :content [{:type "output_text" :text text}]}]}
                      usage (assoc :usage usage))))

(deftest ^:async routes-gpt-chat-requests-to-responses-endpoint-and-maps-response
  (let [observed-path (atom "")
        observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [request body]
          (reset! observed-path (or (.-url request) ""))
          (reset! observed-body (h/parse-json body))
          (h/json-reply 200 {:id "resp_abc" :object "response" :created_at 1772516800 :model "gpt-5.3-codex"
                             :output [{:id "msg_abc" :type "message" :role "assistant"
                                       :content [{:type "output_text" :text "responses-route-ok"}]}]
                             :usage {:input_tokens 9 :output_tokens 4 :total_tokens 13}}))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app {:model "gpt-5.3-codex"
                                            :messages [{:role "user" :content "hello"}]
                                            :stream false
                                            :max_tokens 256
                                            :reasoningEffort "high"
                                            :reasoningSummary "auto"
                                            :textVerbosity "low"
                                            :include ["reasoning.encrypted_content"]
                                            :tools [{:type "function"
                                                     :function {:name "bash" :description "Run shell command"
                                                                :parameters {:type "object"
                                                                             :properties {:command {:type "string"}}
                                                                             :required ["command"]
                                                                             :additionalProperties false}}}]
                                            :tool_choice {:type "function" :function {:name "bash"}}}))
               observed @observed-body]
           (is (= 200 (:status response)))
           (is (= "/v1/responses" @observed-path))
           (is (map? observed))
           (is (contains? #{false nil} (:stream observed)))
           (is (= 256 (:max_output_tokens observed)))
           (is (vector? (:input observed)))
           (is (vector? (:tools observed)))
           (is (map? (first (:tools observed))))
           (is (= "bash" (:name (first (:tools observed)))))
           (is (= "function" (:type (first (:tools observed)))))
           (is (map? (:tool_choice observed)))
           (is (= "function" (get-in observed [:tool_choice :type])))
           (is (= "bash" (get-in observed [:tool_choice :name])))
           (is (map? (:reasoning observed)))
           (is (= "high" (get-in observed [:reasoning :effort])))
           (is (= "auto" (get-in observed [:reasoning :summary])))
           (is (map? (:text observed)))
           (is (= "low" (get-in observed [:text :verbosity])))
           (is (vector? (:include observed)))
           (is (= "reasoning.encrypted_content" (first (:include observed))))
           (is (or (nil? (:prompt_cache_key observed)) (string? (:prompt_cache_key observed))))
           (let [payload (:json response)]
             (is (map? payload))
             (is (= "chat.completion" (:object payload)))
             (is (= "gpt-5.3-codex" (:model payload)))
             (is (vector? (:choices payload)))
             (is (map? (get-in payload [:choices 0 :message])))
             (is (= "responses-route-ok" (get-in payload [:choices 0 :message :content])))
             (is (map? (:usage payload)))
             (is (= 13 (get-in payload [:usage :total_tokens]))))))))))

(deftest ^:async falls-back-to-top-level-output-text-when-responses-output-message-text-is-empty
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler
      (fn [_ _]
        (h/json-reply 200 {:id "resp_top_level_output_text" :object "response" :created_at 1772516800
                           :model "gpt-5.4-mini" :output_text "top-level-output-text-ok"
                           :output [{:id "msg_top_level_output_text" :type "message" :role "assistant" :content []}]
                           :usage {:input_tokens 9 :output_tokens 4 :total_tokens 13}}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "gpt-5.4-mini")))
             payload (:json response)]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (vector? (:choices payload)))
         (is (map? (get-in payload [:choices 0 :message])))
         (is (= "top-level-output-text-ok" (get-in payload [:choices 0 :message :content]))))))))

(deftest ^:async preserves-xhigh-reasoning-effort-for-gpt-chat-requests-routed-to-responses
  (let [observed-body (atom {})]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [_ body]
          (reset! observed-body (h/parse-json body))
          (responses-reply "resp_reasoning_xhigh" "gpt-5.4-mini" "xhigh-ok"
                           {:input_tokens 9 :output_tokens 4 :total_tokens 13}))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "gpt-5.4-mini" {:messages [{:role "user" :content "hello"}]
                                                                     :reasoning_effort "xhigh"})))]
           (is (= 200 (:status response)))
           (is (map? (:reasoning @observed-body)))
           (is (= "xhigh" (get-in @observed-body [:reasoning :effort])))))))))

(deftest ^:async routes-glm-chat-requests-to-chat-completions-upstream
  (let [observed-path (atom "")
        observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [request body]
          (reset! observed-path (or (.-url request) ""))
          (reset! observed-body (h/parse-json body))
          (h/json-reply 200 {:id "chatcmpl_glm" :object "chat.completion" :created 1772516801 :model "glm-5"
                             :choices [{:index 0 :message {:role "assistant" :content "glm-chat-completions-route-ok"}
                                        :finish_reason "stop"}]}))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "glm-5")))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "chat_completions" (get-in response [:headers "x-open-hax-upstream-mode"])))
           (is (= "/v1/chat/completions" @observed-path))
           (is (map? @observed-body))
           (is (= "glm-5" (:model @observed-body)))
           (is (vector? (:messages @observed-body)))
           (is (map? payload))
           (is (= "chat.completion" (:object payload)))
           (is (= "glm-5" (:model payload)))
           (is (vector? (:choices payload)))
           (is (map? (get-in payload [:choices 0 :message])))
           (is (= "glm-chat-completions-route-ok" (get-in payload [:choices 0 :message :content])))))))))

(deftest ^:async fails-over-gpt-responses-accounts-when-requested-reasoning-trace-is-missing
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-no-reasoning" "key-with-reasoning"]
        :upstream-handler
        (fn [request body]
          (let [auth (h/req-header request "authorization")
                parsed (h/parse-json body)]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            (is (map? parsed))
            (is (map? (:reasoning parsed)))
            (if (= auth "Bearer key-no-reasoning")
              (h/json-reply 200 {:id "resp_no_reasoning" :object "response" :created_at 1772516810
                                 :model "gpt-5.3-codex"
                                 :output [{:id "msg_no_reasoning" :type "message" :role "assistant"
                                           :content [{:type "output_text" :text "gpt-no-reasoning"}]}]})
              (h/json-reply 200 {:id "resp_with_reasoning" :object "response" :created_at 1772516811
                                 :model "gpt-5.3-codex"
                                 :output [{:id "rs_glm" :type "reasoning"
                                           :summary [{:type "summary_text" :text "gpt-reasoning-ok"}]}
                                          {:id "msg_with_reasoning" :type "message" :role "assistant"
                                           :content [{:type "output_text" :text "gpt-with-reasoning"}]}]}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "gpt-5.3-codex" {:reasoning_effort "low"
                                                                      :include ["reasoning.encrypted_content"]})))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= ["key-no-reasoning" "key-with-reasoning"] @observed-keys))
           (is (map? payload))
           (is (vector? (:choices payload)))
           (is (map? (get-in payload [:choices 0 :message])))
           (is (= "gpt-with-reasoning" (get-in payload [:choices 0 :message :content])))
           (is (= "gpt-reasoning-ok" (get-in payload [:choices 0 :message :reasoning_content])))))))))

(deftest ^:async fails-over-chat-completions-accounts-when-requested-reasoning-trace-is-missing
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-kimi-no-reasoning" "key-kimi-with-reasoning"]
        :upstream-handler
        (fn [request _]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            (if (= auth "Bearer key-kimi-no-reasoning")
              (h/json-reply 200 {:id "chatcmpl_kimi_no_reasoning" :object "chat.completion" :created 1772516812
                                 :model "Kimi-K2.5"
                                 :choices [{:index 0 :message {:role "assistant" :content "kimi-no-reasoning"}
                                            :finish_reason "stop"}]})
              (h/json-reply 200 {:id "chatcmpl_kimi_with_reasoning" :object "chat.completion" :created 1772516813
                                 :model "Kimi-K2.5"
                                 :choices [{:index 0 :message {:role "assistant" :content "kimi-with-reasoning"
                                                               :reasoning_content "kimi-reasoning-ok"}
                                            :finish_reason "stop"}]}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "Kimi-K2.5" {:reasoning_effort "low"
                                                                  :include ["reasoning.encrypted_content"]})))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= ["key-kimi-no-reasoning" "key-kimi-with-reasoning"] @observed-keys))
           (is (map? payload))
           (is (vector? (:choices payload)))
           (is (map? (get-in payload [:choices 0 :message])))
           (is (= "kimi-with-reasoning" (get-in payload [:choices 0 :message :content])))
           (is (= "kimi-reasoning-ok" (get-in payload [:choices 0 :message :reasoning_content])))))))))

(defn- sse-chunk [id created delta finish-reason]
  (str "data: " (h/json-body {:id id :object "chat.completion.chunk" :created created :model "Kimi-K2.5"
                              :choices [{:index 0 :delta delta :finish_reason finish-reason}]})
       "\n\n"))

(deftest ^:async fails-over-streamed-chat-completions-accounts-when-requested-reasoning-trace-is-missing
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-kimi-stream-no-reasoning" "key-kimi-stream-with-reasoning"]
        :upstream-handler
        (fn [request _]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            {:status 200 :headers {"content-type" "text/event-stream"}
             :body (if (= auth "Bearer key-kimi-stream-no-reasoning")
                     (str (sse-chunk "chatcmpl_kimi_stream_no_reasoning" 1772516814
                                     {:role "assistant" :content "stream-no-reasoning"} nil)
                          (sse-chunk "chatcmpl_kimi_stream_no_reasoning" 1772516814 {} "stop")
                          "data: [DONE]\n\n")
                     (str (sse-chunk "chatcmpl_kimi_stream_with_reasoning" 1772516815
                                     {:role "assistant" :reasoning_content "stream-reasoning-ok"
                                      :content "stream-with-reasoning"} nil)
                          (sse-chunk "chatcmpl_kimi_stream_with_reasoning" 1772516815 {} "stop")
                          "data: [DONE]\n\n"))}))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "Kimi-K2.5" {:reasoning_effort "low"
                                                                  :include ["reasoning.encrypted_content"]
                                                                  :stream true})))
               content-type (get-in response [:headers "content-type"])]
           (is (= 200 (:status response)))
           (is (string? content-type))
           (is (re-find #"(?i)text/event-stream" (str content-type)))
           (is (= ["key-kimi-stream-no-reasoning" "key-kimi-stream-with-reasoning"] @observed-keys))
           (is (str/includes? (:text response) "stream-reasoning-ok"))
           (is (str/includes? (:text response) "data: [DONE]"))))))))
