(ns proxx.proxy.chat-to-responses-test
  "Chat completions served by a Responses upstream: content-part typing, history
  sanitising, role validation, tool-call and reasoning mapping, and the synthetic SSE
  for streaming clients, through the real application."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json]]))

(defn- responses-reply
  "A Responses-API answer with `output` items."
  [id created-at output]
  (fx/json-reply {:id id :object "response" :created_at created-at :model "gpt-5.3-codex" :output output}))

(defn- text-message [id text]
  {:id id :type "message" :role "assistant" :content [{:type "output_text" :text text}]})

(defn- codex-chat [messages & [extra]]
  (merge {:model "gpt-5.3-codex" :messages messages :stream false} extra))

(deftest ^:async normalizes-chat-content-part-type-text-to-responses-input-text-output-text
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (responses-reply "resp_norm" 1772516803 [(text-message "msg_norm" "ok")]))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          (codex-chat [{:role "system" :content [{:type "text" :text "system text"}]}
                                                       {:role "assistant" :content [{:type "text" :text "assistant text"}]}
                                                       {:role "user" :content [{:type "text" :text "user text"}]}])))
               input (get @seen "input")]
           (is (= 200 (:status response)))
           (is (map? @seen))
           (is (vector? input))
           (is (= 3 (count input)))
           (doseq [[i expected] [[0 "input_text"] [1 "output_text"] [2 "input_text"]]]
             (is (map? (get input i)))
             (is (vector? (get-in input [i "content"])))
             (is (map? (get-in input [i "content" 0])))
             (is (= expected (get-in input [i "content" 0 "type"]))))))))))

(deftest ^:async sanitizes-interleaved-reasoning-fields-from-chat-history-before-responses-forwarding
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (responses-reply "resp_sanitized" 1772516804 [(text-message "msg_sanitized" "ok")]))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          (codex-chat
                                           [{:role "assistant"
                                             :reasoning_content "should-strip"
                                             :reasoning_details [{:text "strip-me"}]
                                             :function_call {:name "old_call"}
                                             :content [{:type "reasoning" :text "drop this"}
                                                       {:type "text" :text "keep this"}]
                                             :tool_calls [{:id "call_1" :type "function" :function {:name "bash" :arguments "{}"}}]}
                                            {:role "tool" :tool_call_id "call_1"
                                             :content [{:type "reasoning_details" :text "drop tool reasoning"}
                                                       {:type "text" :text "tool output"}]}]
                                           {:reasoning {:effort "high" :summary "auto"}})))
               input (get @seen "input")]
           (is (= 200 (:status response)))
           (is (map? @seen))
           (is (= {"effort" "high" "summary" "auto"} (get @seen "reasoning")))
           (is (vector? input))
           (is (= 3 (count input)))
           (is (map? (get input 0)))
           (is (vector? (get-in input [0 "content"])))
           (is (= 1 (count (get-in input [0 "content"]))))
           (is (map? (get-in input [0 "content" 0])))
           (is (= "output_text" (get-in input [0 "content" 0 "type"])))
           (is (= "keep this" (get-in input [0 "content" 0 "text"])))
           (is (not (contains? (get input 0) "reasoning_content")))
           (is (not (contains? (get input 0) "reasoning_details")))
           (is (not (contains? (get input 0) "function_call")))
           (is (map? (get input 1)))
           (is (= "function_call" (get-in input [1 "type"])))
           (is (map? (get input 2)))
           (is (= "function_call_output" (get-in input [2 "type"])))
           (is (= "tool output" (get-in input [2 "output"])))))))))

(deftest ^:async rejects-unsupported-chat-message-roles-for-responses-compatibility
  (await
   (with-proxy-app
     {:keys ["key-a"] :upstream-handler (fn [_ _] (fx/json-reply {}))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions" (codex-chat [{:role "critic" :content "nope"}])))
             payload (:json response)]
         (is (= 400 (:status response)))
         (is (map? payload))
         (is (map? (get payload "error")))
         (is (= "invalid_provider_options" (get-in payload ["error" "code"])))
         (is (re-find #"(?i)unsupported messages role" (str (get-in payload ["error" "message"])))))))))

(deftest ^:async maps-responses-function-call-output-to-chat-tool-calls
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _]
                          (responses-reply "resp_tool_call" 1772516801
                                           [{:id "fc_1" :type "function_call" :call_id "call_1" :name "bash"
                                             :arguments "{\"command\":\"pwd\"}"}]))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions" (codex-chat [{:role "user" :content "run pwd"}])))
             payload (:json response)
             choice (get-in payload ["choices" 0])]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (vector? (get payload "choices")))
         (is (map? choice))
         (is (= "tool_calls" (get choice "finish_reason")))
         (is (map? (get choice "message")))
         (is (contains? (get choice "message") "content"))
         (is (nil? (get-in choice ["message" "content"])))
         (is (vector? (get-in choice ["message" "tool_calls"])))
         (is (map? (get-in choice ["message" "tool_calls" 0 "function"])))
         (is (= "bash" (get-in choice ["message" "tool_calls" 0 "function" "name"]))))))))

(deftest ^:async returns-synthetic-chat-completion-sse-for-gpt-stream-requests
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _]
                          (responses-reply "resp_stream" 1772516802 [(text-message "msg_stream" "stream-via-responses")]))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions"
                                        (codex-chat [{:role "user" :content "hello"}] {:stream true})))
             body (:body response)]
         (is (= 200 (:status response)))
         (is (= "text/event-stream; charset=utf-8" (get-in response [:headers "content-type"])))
         (is (.includes body "chat.completion.chunk"))
         (is (.includes body "stream-via-responses"))
         (is (.includes body "data: [DONE]")))))))
