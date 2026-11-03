(ns proxx.proxy.claude-messages-test
  "Claude models behind /v1/chat/completions: the request is translated to the messages
   endpoint (thinking, tools, transcript) and the answer back to chat completions.
   Ported from src/tests/proxy.test.ts."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.harness-d :as h :refer [with-proxy-app includes? bearer-key]]))

(def ^:private model-id "claude-opus-4-5-20251101")

(defn- message-reply
  "A messages-API reply as a handler result."
  [id content usage]
  {:status 200 :headers {"content-type" "application/json"}
   :body (h/json-str {"id" id "model" model-id "role" "assistant" "type" "message" "content" content
                      "stop_reason" (if (some #(= "tool_use" (get % "type")) content) "tool_use" "end_turn")
                      "usage" usage})})

(defn- text [t] {"type" "text" "text" t})
(defn- thinking [t] {"type" "thinking" "thinking" t})
(defn- usage [i o] {"input_tokens" i "output_tokens" o})

(defn- chat-message [r] (get-in (:json r) ["choices" 0 "message"]))

(defn- beta-header [request]
  (let [v (aget (.-headers request) "anthropic-beta")]
    (cond (array? v) (str/join "," v) (nil? v) "" :else v)))

(deftest ^:async fails-over-claude-accounts-when-requested-reasoning-trace-is-missing
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-no-thinking" "key-with-thinking"]
        :upstream-handler
        (fn [request _]
          (when-let [k (bearer-key request)] (swap! observed-keys conj k))
          (if (= "key-no-thinking" (bearer-key request))
            (message-reply "msg_claude_no_reasoning" [(text "no-thinking")] (usage 10 4))
            (message-reply "msg_claude_with_reasoning"
                           [(thinking "fallback-thinking-ok") (text "with-thinking")] (usage 10 4))))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]
                                    "reasoning_effort" "medium" "include" ["reasoning.encrypted_content"]
                                    "stream" false}))]
          (is (= 200 (:status r)))
          (is (= ["key-no-thinking" "key-with-thinking"] @observed-keys))
          (is (vector? (get (:json r) "choices")))
          (is (= "with-thinking" (get (chat-message r) "content")))
          (is (= "fallback-thinking-ok" (get (chat-message r) "reasoning_content")))))))))

(deftest ^:async routes-claude-chat-requests-to-messages-endpoint-and-maps-response
  (let [observed-path (atom "") observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [request body]
                            (reset! observed-path (or (.-url request) ""))
                            (reset! observed-body (h/parse-json body))
                            (message-reply "msg_claude_1" [(text "claude-mapped-ok")] (usage 11 7)))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "claude-opus-4-5"
                                    "messages" [{"role" "system" "content" "You are terse"}
                                                {"role" "user" "content" "hello" "cache_control" {"type" "ephemeral"}}]
                                    "stream" false}))
              body @observed-body]
          (is (= 200 (:status r)))
          (is (= "/v1/messages" @observed-path))
          (is (map? body))
          (is (= "claude-opus-4-5" (get body "model")))
          (is (= "You are terse" (get body "system")))
          (is (vector? (get body "messages")))
          (is (= 1 (count (get body "messages"))))
          (is (= "user" (get-in body ["messages" 0 "role"])))
          (is (not (contains? (get-in body ["messages" 0]) "cache_control")))
          (is (= "chat.completion" (get (:json r) "object")))
          (is (= model-id (get (:json r) "model")))
          (is (= "claude-mapped-ok" (get (chat-message r) "content")))
          (is (= 11 (get-in (:json r) ["usage" "prompt_tokens"])))
          (is (= 7 (get-in (:json r) ["usage" "completion_tokens"])))
          (is (= 18 (get-in (:json r) ["usage" "total_tokens"])))))))))

(deftest ^:async maps-reasoning-effort-to-messages-thinking-payload-and-beta-header
  (let [observed-body (atom nil) observed-beta (atom "")]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [request body]
                            (reset! observed-body (h/parse-json body))
                            (reset! observed-beta (beta-header request))
                            (message-reply "msg_claude_reasoning_cfg"
                                           [(thinking "configured-thinking-ok") (text "configured-text-ok")]
                                           (usage 18 10)))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]
                                    "include" ["reasoning.encrypted_content"] "reasoning_effort" "high"
                                    "stream" false}))]
          (is (= 200 (:status r)))
          (is (map? (get @observed-body "thinking")))
          (is (= "enabled" (get-in @observed-body ["thinking" "type"])))
          (is (= 24576 (get-in @observed-body ["thinking" "budget_tokens"])))
          (is (re-find #"interleaved-thinking-2025-05-14" @observed-beta))
          (is (= "configured-text-ok" (get (chat-message r) "content")))
          (is (= "configured-thinking-ok" (get (chat-message r) "reasoning_content")))))))))

(deftest ^:async maps-disabled-reasoning-effort-to-messages-thinking-disabled
  (let [observed-body (atom nil) observed-beta (atom "")]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [request body]
                            (reset! observed-body (h/parse-json body))
                            (reset! observed-beta (beta-header request))
                            (message-reply "msg_claude_reasoning_disabled" [(text "disabled-thinking-ok")] (usage 8 6)))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]
                                    "reasoning_effort" "none" "stream" false}))]
          (is (= 200 (:status r)))
          (is (map? (get @observed-body "thinking")))
          (is (= "disabled" (get-in @observed-body ["thinking" "type"])))
          (is (= "" @observed-beta))))))))

(deftest ^:async maps-claude-thinking-blocks-to-chat-reasoning-content
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _] (message-reply "msg_claude_thinking"
                                                 [(thinking "claude-thinking-ok") (text "claude-text-ok")]
                                                 (usage 14 9)))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]
                                  "stream" false}))]
        (is (= 200 (:status r)))
        (is (vector? (get (:json r) "choices")))
        (is (= "claude-text-ok" (get (chat-message r) "content")))
        (is (= "claude-thinking-ok" (get (chat-message r) "reasoning_content"))))))))

(def ^:private bash-call-args "{\"command\":\"pwd\"}")

(deftest ^:async maps-claude-tool-use-content-to-chat-tool-calls
  (let [observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [_ body]
                            (reset! observed-body (h/parse-json body))
                            (message-reply "msg_claude_2"
                                           [{"type" "tool_use" "id" "toolu_123" "name" "bash" "input" {"command" "pwd"}}]
                                           (usage 22 9)))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "run pwd"}]
                                    "tools" [{"type" "function"
                                              "function" {"name" "bash" "description" "run shell command"
                                                          "parameters" {"type" "object"
                                                                        "properties" {"command" {"type" "string"}}
                                                                        "required" ["command"]
                                                                        "additionalProperties" false}}}]
                                    "tool_choice" "required" "stream" false}))
              choice (get-in (:json r) ["choices" 0])
              message (get choice "message")]
          (is (= 200 (:status r)))
          (is (vector? (get @observed-body "tools")))
          (is (= "bash" (get-in @observed-body ["tools" 0 "name"])))
          (is (map? (get @observed-body "tool_choice")))
          (is (= "any" (get-in @observed-body ["tool_choice" "type"])))
          (is (= "tool_calls" (get choice "finish_reason")))
          (is (contains? message "content"))
          (is (nil? (get message "content")))
          (is (vector? (get message "tool_calls")))
          (is (= "toolu_123" (get-in message ["tool_calls" 0 "id"])))
          (is (map? (get-in message ["tool_calls" 0 "function"])))
          (is (= "bash" (get-in message ["tool_calls" 0 "function" "name"])))
          (is (= bash-call-args (get-in message ["tool_calls" 0 "function" "arguments"])))))))))

(deftest ^:async maps-claude-interleaved-thinking-with-tool-use
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _]
                          (message-reply "msg_claude_interleaved"
                                         [(thinking "thinking-before-tool ")
                                          (text "I will run a command.")
                                          {"type" "tool_use" "id" "toolu_interleaved" "name" "bash"
                                           "input" {"command" "pwd"}}
                                          (thinking "thinking-after-tool")]
                                         (usage 26 12)))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "run pwd"}]
                                  "stream" false}))
            choice (get-in (:json r) ["choices" 0])
            message (get choice "message")]
        (is (= 200 (:status r)))
        (is (= "tool_calls" (get choice "finish_reason")))
        (is (= "I will run a command." (get message "content")))
        (is (= "thinking-before-tool thinking-after-tool" (get message "reasoning_content")))
        (is (vector? (get message "tool_calls")))
        (is (= "toolu_interleaved" (get-in message ["tool_calls" 0 "id"])))
        (is (map? (get-in message ["tool_calls" 0 "function"])))
        (is (= "bash" (get-in message ["tool_calls" 0 "function" "name"])))
        (is (= bash-call-args (get-in message ["tool_calls" 0 "function" "arguments"]))))))))

(deftest ^:async maps-assistant-tool-calls-and-tool-result-transcript-to-messages-format
  (let [observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [_ body]
                            (reset! observed-body (h/parse-json body))
                            (message-reply "msg_claude_transcript" [(text "claude-transcript-ok")] (usage 40 8)))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "claude-opus-4-5"
                                    "messages" [{"role" "assistant" "content" ""
                                                 "tool_calls" [{"id" "call_1" "type" "function"
                                                                "function" {"name" "bash" "arguments" bash-call-args}}]}
                                                {"role" "tool" "tool_call_id" "call_1" "content" "/tmp"}
                                                {"role" "user" "content" "continue"}]
                                    "stream" false}))
              msgs (get @observed-body "messages")]
          (is (= 200 (:status r)))
          (is (vector? msgs))
          (is (= 3 (count msgs)))
          (is (= "assistant" (get-in msgs [0 "role"])))
          (is (vector? (get-in msgs [0 "content"])))
          (is (= "tool_use" (get-in msgs [0 "content" 0 "type"])))
          (is (= "call_1" (get-in msgs [0 "content" 0 "id"])))
          (is (= "bash" (get-in msgs [0 "content" 0 "name"])))
          (is (= "user" (get-in msgs [1 "role"])))
          (is (vector? (get-in msgs [1 "content"])))
          (is (= "tool_result" (get-in msgs [1 "content" 0 "type"])))
          (is (= "call_1" (get-in msgs [1 "content" 0 "tool_use_id"])))
          (is (= "/tmp" (get-in msgs [1 "content" 0 "content"])))
          (is (= "user" (get-in msgs [2 "role"])))
          (is (= "continue" (get-in msgs [2 "content"])))))))))

(deftest ^:async returns-synthetic-chat-completion-sse-for-claude-stream-requests
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _] (message-reply "msg_claude_stream"
                                                 [(thinking "claude-stream-thinking-ok") (text "claude-stream-chat-ok")]
                                                 (usage 12 8)))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]
                                  "stream" true}))]
        (is (= 200 (:status r)))
        (is (= "text/event-stream; charset=utf-8" (get (:headers r) "content-type")))
        (is (includes? (:body r) "chat.completion.chunk"))
        (is (includes? (:body r) "\"reasoning_content\":\"claude-stream-thinking-ok\""))
        (is (includes? (:body r) "claude-stream-chat-ok"))
        (is (includes? (:body r) "data: [DONE]")))))))
