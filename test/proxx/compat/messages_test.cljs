(ns proxx.compat.messages-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.compat.messages :as m]
            [proxx.runtime :as rt]))

(defn- req [body] (m/chat-request->messages-request body))
(defn- thrown-message [f] (try (f) nil (catch :default e (ex-message e))))

(deftest minimal-request
  (is (= {"model" "claude-x" "stream" false
          "messages" [{"role" "user" "content" "hi"}]}
         (req {"model" "claude-x" "messages" [{"role" "user" "content" "hi"}]})))
  (is (= {"messages" [] "stream" false} (req {})) "no model key stays absent")
  (is (= {"messages" [] "stream" false "model" nil "temperature" nil}
         (req {"model" nil "temperature" nil}))
      "explicit nulls are preserved, absent keys are not invented"))

(deftest system-messages-fold-into-one-field
  (is (= "a\nb" (get (req {"messages" [{"role" "system" "content" "a"}
                                       {"role" "user" "content" "u"}
                                       {"role" "system" "content" [{"type" "text" "text" "b"}]}]})
                     "system")))
  (is (not (contains? (req {"messages" [{"role" "system" "content" "  "}]}) "system"))
      "whitespace-only system prompt is dropped"))

(deftest consecutive-tool-results-share-one-user-message
  (is (= [{"role" "user" "content" [{"type" "tool_result" "tool_use_id" "a" "content" "1"}
                                    {"type" "tool_result" "tool_use_id" "b" "content" "2" "is_error" true}]}
          {"role" "user" "content" "next"}]
         (get (req {"messages" [{"role" "tool" "tool_call_id" "a" "content" "1"}
                                {"role" "tool" "tool_call_id" "b" "content" "2" "is_error" true}
                                {"role" "user" "content" "next"}
                                {"role" "tool" "tool_call_id" ""  "content" "dropped"}]})
              "messages"))
      "tool results without an id are dropped; pending ones flush at the next turn and at the end")
  (is (= 1 (count (get (req {"messages" [{"role" "tool" "tool_call_id" "a" "content" "1"}]}) "messages")))))

(deftest assistant-messages
  (testing "plain text collapses to a string"
    (is (= [{"role" "assistant" "content" "hello"}]
           (get (req {"messages" [{"role" "assistant" "content" "hello"}]}) "messages"))))
  (testing "empty assistant turns vanish"
    (is (= [] (get (req {"messages" [{"role" "assistant" "content" ""}
                                     {"role" "assistant" "tool_calls" []}]}) "messages"))))
  (testing "tool calls become tool_use parts after text, ids default by array position"
    (is (= [{"role" "assistant"
             "content" [{"type" "text" "text" "t"}
                        {"type" "tool_use" "id" "c1" "name" "f" "input" {"a" 1}}
                        {"type" "tool_use" "id" "toolu_2" "name" "g" "input" {}}]}]
           (get (req {"messages" [{"role" "assistant" "content" "t"
                                   "tool_calls" [{"id" "c1" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}
                                                 {"type" "other" "function" {"name" "skipped"}}
                                                 {"function" {"name" "g"}}]}]}) "messages"))))
  (testing "non-object arguments are wrapped, never lost, never passed as a non-object"
    (let [input (fn [args] (-> (req {"messages" [{"role" "assistant" "tool_calls" [{"function" {"name" "f" "arguments" args}}]}]})
                               (get-in ["messages" 0 "content" 0 "input"])))]
      (is (= {"value" "nope"} (input "nope")))
      (is (= {"value" 5} (input "5")))
      (is (= {} (input "null")))
      (is (= {"value" [1 2]} (input "[1,2]")) "intentional: Anthropic requires an object")
      (is (= {"k" 1} (input {"k" 1}))))))

(deftest user-content-normalization
  (is (= [{"role" "user" "content" [{"type" "text" "text" "t"}
                                    {"type" "image" "source" {"type" "url" "url" "https://x/y.png"}}
                                    {"type" "image" "source" {"type" "base64" "media_type" "image/png" "data" "AAAA"}}
                                    {"type" "image" "source" {"type" "base64" "media_type" "application/octet-stream" "data" "QQ"}}
                                    {"type" "weird"}]}]
         (get (req {"messages" [{"role" "user"
                                 "content" [{"type" "input_text" "text" "t"}
                                            {"type" "image_url" "image_url" {"url" "https://x/y.png"}}
                                            {"type" "image_url" "image_url" "data:image/png;base64,AAAA"}
                                            {"type" "input_image" "image_url" "data:;base64,QQ"}
                                            {"type" "weird"}]}]}) "messages")))
  (testing "every image shape clients send"
    (let [img (fn [part] (get-in (req {"messages" [{"role" "user" "content" [part]}]}) ["messages" 0 "content" 0]))]
      (is (= {"type" "image" "source" {"type" "url" "url" "https://z"}} (img {"type" "image" "source" {"type" "url" "url" "https://z"}})))
      (is (= {"type" "image" "source" {"type" "base64" "media_type" "image/jpeg" "data" "ZZ"}}
             (img {"type" "image" "source" {"type" "base64" "data" "ZZ" "media_type" "image/jpeg"}})))
      (is (= {"type" "image" "source" {"type" "url" "url" "https://u"}} (img {"type" "image" "url" "https://u"})))
      (is (= {"type" "image" "source" {"type" "base64" "media_type" "image/webp" "data" "DD"}}
             (img {"type" "image" "data" "DD" "mimeType" "image/webp"})))
      (is (= {"type" "image"} (img {"type" "image"})) "an image with no payload passes through untouched")
      (is (= {"type" "image" "source" {"type" "url" "url" "data:image/png,notb64"}}
             (img {"type" "image_url" "image_url" "data:image/png,notb64"}))
          "only base64 data URLs are decoded"))))

(deftest tools-and-tool-choice
  (is (= [{"name" "f" "description" "d" "input_schema" {"type" "object"}}
          {"name" "n" "input_schema" {"a" 1}}
          {"name" "q" "input_schema" {"z" 2}}]
         (get (req {"tools" [{"type" "function" "function" {"name" "f" "description" "d" "parameters" {"type" "object"}}}
                             {"name" "n" "input_schema" {"a" 1}}
                             {"type" "retrieval" "name" "bad"}
                             nil
                             {"function" {"name" ""}}
                             {"function" {"name" "q" "parameters" nil} "input_schema" {"z" 2}}]}) "tools")))
  (is (= "x" (get (req {"tools" "x"}) "tools")) "non-array tools pass through")
  (doseq [[in out] [["required" {"type" "any"}] ["auto" {"type" "any"}] ["none" {"type" "none"}] ["foo" "foo"]
                    [{"type" "function" "function" {"name" "f"}} {"type" "tool" "name" "f"}]
                    [{"type" "function" "name" "g"} {"type" "tool" "name" "g"}]
                    [{"type" "function"} {"type" "any"}]
                    [{"type" "required"} {"type" "any"}]
                    [{"type" "none"} {"type" "none"}]
                    [{"type" "zzz"} {"type" "zzz"}]
                    [5 5]]]
    (is (= out (get (req {"tool_choice" in}) "tool_choice")) (pr-str in))))

(deftest sampling-and-token-limits
  (is (= {"max_tokens" 5000 "temperature" 0.2 "top_p" 0.9}
         (select-keys (req {"max_completion_tokens" 5000 "max_tokens" 10 "temperature" 0.2 "top_p" 0.9})
                      ["max_tokens" "temperature" "top_p"])))
  (is (not (contains? (req {"max_tokens" "x"}) "max_tokens"))))

(deftest thinking-requests
  (let [thinking (fn [body] (get (req body) "thinking"))]
    (testing "explicit blocks win"
      (is (= {"type" "disabled"} (thinking {"thinking" {"type" "disabled"} "reasoning_effort" "high"})))
      (is (= {"type" "enabled" "budget_tokens" 12288} (thinking {"thinking" {"type" "enabled"}})))
      (is (= {"type" "enabled" "budget_tokens" 1024} (thinking {"thinking" {"type" "enabled" "budget_tokens" 500}})))
      (is (= {"type" "enabled" "budget_tokens" 1999} (thinking {"thinking" {"type" "enabled" "budget_tokens" 99999} "max_tokens" 2000}))
          "leaves one token for the answer")
      (is (= {"type" "enabled" "budget_tokens" 3000} (thinking {"thinking" {"type" "enabled" "budget_tokens" 3000.7} "max_tokens" 5000}))))
    (testing "effort vocabulary"
      (doseq [[effort out] [["none" {"type" "disabled"}] ["OFF" {"type" "disabled"}] ["minimal" 1024] ["low" 4096]
                            ["MEDIUM" 12288] ["normal" 12288] ["auto" 12288] ["high" 24576]
                            ["xhigh" 32768] ["very_high" 32768] [" max " 32768]]]
        (let [expected (if (map? out) out {"type" "enabled" "budget_tokens" out})]
          (is (= expected (thinking {"reasoning" {"effort" effort}})) effort)
          (is (= expected (thinking {"reasoning_effort" effort})) effort)
          (is (= expected (thinking {"reasoningEffort" effort})) effort)))
      (is (nil? (thinking {"reasoning_effort" "bogus"})))
      (is (nil? (thinking {"reasoning" {"effort" 5} "reasoning_effort" "high"}))
          "the first present effort value decides, even if unusable"))
    (testing "an encrypted reasoning trace implies default thinking"
      (is (= {"type" "enabled" "budget_tokens" 12288} (thinking {"include" ["reasoning.encrypted_content"]})))
      (is (nil? (thinking {"include" ["x"]}))))
    (testing "too small a cap is a hard error"
      (is (= "Extended thinking requires max_tokens greater than 1024 for messages-compatible models"
             (thrown-message #(req {"reasoning_effort" "high" "max_tokens" 1024}))))
      (is (= :thinking/max-tokens-too-small
             (try (req {"include" ["reasoning.encrypted_content"] "max_tokens" 900})
                  (catch :default e (:error/type (ex-data e)))))))))

(deftest normalize-thinking-budget
  (let [payload {"thinking" {"type" "enabled" "budget_tokens" 100000} "max_tokens" 5000}]
    (is (= 4999 (get-in (m/normalize-messages-thinking-budget payload) ["thinking" "budget_tokens"])))
    (is (= {"type" "enabled" "budget_tokens" 1024}
           (get (m/normalize-messages-thinking-budget {"thinking" {"type" "enabled" "budget_tokens" 100} "max_tokens" 5000}) "thinking"))))
  (let [ok {"thinking" {"type" "enabled" "budget_tokens" 2000}}]
    (is (identical? ok (m/normalize-messages-thinking-budget ok)) "unchanged payloads come back identical"))
  (let [off {"thinking" {"type" "disabled"}}]
    (is (identical? off (m/normalize-messages-thinking-budget off))))
  (is (some? (thrown-message #(m/normalize-messages-thinking-budget {"thinking" {"type" "enabled"} "max_tokens" 1024})))))

(deftest should-use-messages-upstream
  (is (m/should-use-messages-upstream? "Claude-3" ["claude"]))
  (is (m/should-use-messages-upstream? "claude-3" ["x" "CLAUDE-"]))
  (is (not (m/should-use-messages-upstream? "gpt-5" ["claude"])))
  (is (not (m/should-use-messages-upstream? nil ["claude"])))
  (is (not (m/should-use-messages-upstream? "claude" []))))

(def ^:private now 1700000123456)

(defn- completion [body] (m/messages->chat-completion body "fallback" now))

(deftest response-translation
  (testing "text, ids, clock and fallback model"
    (is (= {"id" "chatcmpl_1700000123456" "object" "chat.completion" "created" 1700000123
            "model" "fallback" "system_fingerprint" ""
            "choices" [{"index" 0 "finish_reason" "stop"
                        "message" {"role" "assistant" "content" "ab"}}]}
           (completion {"content" [{"type" "text" "text" "a"} {"type" "text" "text" "b"}]})))
    (is (= "msg_1" (get (completion {"id" "msg_1" "model" "claude-y"}) "id")))
    (is (= "claude-y" (get (completion {"id" "msg_1" "model" "claude-y"}) "model"))))
  (testing "reasoning from blocks, thought-text, or top-level fields"
    (is (= "th" (get-in (completion {"content" [{"type" "thinking" "thinking" "th"} {"type" "text" "text" "ans"}]})
                        ["choices" 0 "message" "reasoning_content"])))
    (is (= "ans" (get-in (completion {"content" [{"type" "thinking" "thinking" "th"} {"type" "text" "text" "ans"}]})
                         ["choices" 0 "message" "content"])))
    (is (= "rtrr" (get-in (completion {"content" [{"type" "reasoning" "text" "rt"} {"type" "reasoning" "reasoning" "rr"}]})
                          ["choices" 0 "message" "reasoning_content"])))
    (is (= "thought" (get-in (completion {"content" [{"type" "text" "text" "thought" "thought" true} {"type" "text" "text" "vis"}]})
                             ["choices" 0 "message" "reasoning_content"])))
    (is (= "rc" (get-in (completion {"reasoning_content" "rc" "content" []}) ["choices" 0 "message" "reasoning_content"])))
    (is (not (contains? (get-in (completion {"content" []}) ["choices" 0 "message"]) "reasoning_content"))))
  (testing "tool use: ids by position, string input verbatim, objects serialized, null content when silent"
    (let [c (completion {"content" [{"type" "text" "text" "pre"}
                                    {"type" "tool_use" "id" "t1" "name" "f" "input" {"a" 1}}
                                    {"type" "tool_use" "name" "g" "input" "{\"raw\":1}"}
                                    {"type" "tool_use" "name" "h"}
                                    {"type" "tool_use" "input" {}}]})
          choice (get-in c ["choices" 0])]
      (is (= "tool_calls" (get choice "finish_reason")))
      (is (= "pre" (get-in choice ["message" "content"])))
      (is (= [{"id" "t1" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}
              {"id" "call_2" "type" "function" "function" {"name" "g" "arguments" "{\"raw\":1}"}}
              {"id" "call_3" "type" "function" "function" {"name" "h" "arguments" "{}"}}]
             (get-in choice ["message" "tool_calls"])))
      (is (nil? (get-in (completion {"content" [{"type" "tool_use" "name" "f" "input" {}}]})
                        ["choices" 0 "message" "content"])))))
  (testing "usage needs both counts; cached tokens ride along"
    (is (= {"prompt_tokens" 10 "completion_tokens" 5 "total_tokens" 15}
           (get (completion {"usage" {"input_tokens" 10 "output_tokens" 5}}) "usage")))
    (is (= {"prompt_tokens" 10 "completion_tokens" 5 "total_tokens" 15 "prompt_tokens_details" {"cached_tokens" 3}}
           (get (completion {"usage" {"input_tokens" 10 "output_tokens" 5 "cache_read_input_tokens" 3}}) "usage")))
    (is (not (contains? (completion {"usage" {"input_tokens" 10}}) "usage")))
    (is (not (contains? (completion {"usage" 5}) "usage"))))
  (testing "degenerate provider values fall back instead of leaking empties"
    (let [c (completion {"id" "" "model" ""})]
      (is (= "chatcmpl_1700000123456" (get c "id")))
      (is (= "fallback" (get c "model")))))
  (testing "non-object bodies are rejected"
    (doseq [bad [nil "x" 5 []]]
      (is (= "Invalid /v1/messages response payload" (thrown-message #(completion bad))) (pr-str bad)))))

;; ---- ported from src/tests/messages-compat.test.ts (5 tests) -------------
;; The TS shim called the JS edge (js->clj in, clj->js out), so these drive it.

(defn- payload [overrides]
  (rt/chat-request-to-messages-request-js
   (clj->js (merge {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]} overrides))))

(defn- thinking [^js p] (js->clj (.-thinking p)))

(deftest ts-gpt-reasoning-brackets-map-to-claude-thinking-budgets
  (doseq [[effort budget] [["low" 4096] ["medium" 12288] ["high" 24576] ["xhigh" 32768]]]
    (is (= {"type" "enabled" "budget_tokens" budget} (thinking (payload {"reasoning_effort" effort}))) effort)))

(deftest ts-none-reasoning-effort-maps-to-disabled-thinking
  (is (= {"type" "disabled"} (thinking (payload {"reasoning_effort" "none"})))))

(deftest ts-enabled-thinking-budgets-clamp-below-max-tokens
  (is (= {"type" "enabled" "budget_tokens" 4095}
         (thinking (payload {"reasoning_effort" "high" "max_tokens" 4096}))))
  (is (= {"type" "enabled" "budget_tokens" 2047}
         (thinking (payload {"thinking" {"type" "enabled" "budget_tokens" 5000} "max_completion_tokens" 2048})))))

(deftest ts-enabled-thinking-rejected-when-max-tokens-too-small
  (is (thrown-with-msg? js/Error #"Extended thinking requires max_tokens greater than 1024"
                        (payload {"reasoning_effort" "low" "max_tokens" 1024}))))

(deftest ts-thinking-budgets-renormalize-when-max-tokens-changes-later
  (let [^js p (rt/normalize-messages-thinking-budget-js
               (clj->js {"model" "claude-opus-4-5" "messages" [{"role" "user" "content" "hello"}]
                         "max_tokens" 4096 "thinking" {"type" "enabled" "budget_tokens" 24576}}))]
    (is (= {"type" "enabled" "budget_tokens" 4095} (thinking p)))))

;; ---- ported from src/tests/anthropic-messages-compat.test.ts (19 tests) ---
;; The TS shim called the JS edge, so these drive proxx.runtime/messages-to-chat-completion-js.

(def ^:private sonnet "claude-3-5-sonnet-20241022")

(defn- complete [response fallback]
  (js->clj (rt/messages-to-chat-completion-js (clj->js response) fallback)))

(defn- choice [completion] (first (get completion "choices")))
(defn- message-of [completion] (let [m (get (choice completion) "message")] (if (map? m) m {})))
(defn- usage-of [completion] (let [u (get completion "usage")] (when (map? u) u)))

(defn- anthropic [id content stop usage & [extra]]
  (merge {"id" id "type" "message" "role" "assistant" "model" sonnet
          "content" content "stop_reason" stop}
         (when usage {"usage" usage})
         extra))

(deftest anthropic-basic-text-response
  (let [c (complete (anthropic "msg_01Example" [{"type" "text" "text" "Hello! How can I help you today?"}] "end_turn"
                               {"input_tokens" 15 "output_tokens" 9})
                    "claude-3-5-sonnet")
        message (message-of c)
        usage (usage-of c)]
    (is (= "chat.completion" (get c "object")))
    (is (= sonnet (get c "model")))
    (is (= 1 (count (get c "choices"))))
    (is (= "assistant" (get message "role")))
    (is (= "Hello! How can I help you today?" (get message "content")))
    (is (= "stop" (get (choice c) "finish_reason")))
    (is (not (get message "tool_calls")))
    (is (not (get message "reasoning_content")))
    (is (some? usage))
    (is (= 15 (get usage "prompt_tokens")))
    (is (= 9 (get usage "completion_tokens")))
    (is (= 24 (get usage "total_tokens")))))

(deftest anthropic-thinking-content-is-extracted
  (let [c (complete (anthropic "msg_02Example"
                               [{"type" "thinking" "thinking" "Let me analyze this step by step..."}
                                {"type" "text" "text" "The answer is 42."}]
                               "end_turn" {"input_tokens" 20 "output_tokens" 50}
                               {"model" "claude-opus-4-20251101"})
                    "claude-opus-4")
        message (message-of c)]
    (is (= "The answer is 42." (get message "content")))
    (is (= "Let me analyze this step by step..." (get message "reasoning_content")))))

(deftest anthropic-tool-use-produces-tool-calls-and-null-content
  (let [c (complete (anthropic "msg_03Example"
                               [{"type" "tool_use" "id" "tu_01ABC123" "name" "get_weather"
                                 "input" {"location" "San Francisco" "unit" "celsius"}}]
                               "tool_use" {"input_tokens" 30 "output_tokens" 25})
                    "claude-3-5-sonnet")
        message (message-of c)
        tool-calls (get message "tool_calls")
        tool-call (first tool-calls)]
    (is (contains? message "content"))
    (is (nil? (get message "content")))
    (is (= "tool_calls" (get (choice c) "finish_reason")))
    (is (vector? tool-calls))
    (is (= 1 (count tool-calls)))
    (is (= "tu_01ABC123" (get tool-call "id")))
    (is (= "function" (get tool-call "type")))
    (is (= "get_weather" (get-in tool-call ["function" "name"])))
    (is (= "{\"location\":\"San Francisco\",\"unit\":\"celsius\"}" (get-in tool-call ["function" "arguments"])))))

(deftest anthropic-mixed-text-and-tool-use
  (let [c (complete (anthropic "msg_04Example"
                               [{"type" "text" "text" "I'll check the weather for you."}
                                {"type" "tool_use" "id" "tu_02DEF456" "name" "get_weather" "input" {"location" "New York"}}]
                               "tool_use" {"input_tokens" 25 "output_tokens" 30})
                    "claude-3-5-sonnet")
        message (message-of c)
        tool-calls (get message "tool_calls")]
    (is (= "I'll check the weather for you." (get message "content")))
    (is (= "tool_calls" (get (choice c) "finish_reason")))
    (is (vector? tool-calls))
    (is (= 1 (count tool-calls)))
    (is (= "tu_02DEF456" (get (first tool-calls) "id")))))

(deftest anthropic-multiple-tool-uses
  (let [c (complete (anthropic "msg_05Example"
                               [{"type" "tool_use" "id" "tu_03GHI789" "name" "get_weather" "input" {"location" "SF"}}
                                {"type" "tool_use" "id" "tu_04JKL012" "name" "get_time" "input" {"timezone" "PST"}}]
                               "tool_use" {"input_tokens" 40 "output_tokens" 50})
                    "claude-3-5-sonnet")
        tool-calls (get (message-of c) "tool_calls")]
    (is (= 2 (count tool-calls)))
    (is (= "tu_03GHI789" (get (nth tool-calls 0) "id")))
    (is (= "tu_04JKL012" (get (nth tool-calls 1) "id")))
    (is (= "get_weather" (get-in (nth tool-calls 0) ["function" "name"])))
    (is (= "get_time" (get-in (nth tool-calls 1) ["function" "name"])))))

(deftest anthropic-empty-content-array
  (let [c (complete (anthropic "msg_06Example" [] "end_turn" {"input_tokens" 10 "output_tokens" 0}) "claude-3-5-sonnet")
        message (message-of c)]
    (is (= "" (get message "content")))
    (is (= "stop" (get (choice c) "finish_reason")))
    (is (not (get message "tool_calls")))))

(deftest anthropic-string-content-edge-case
  (let [c (complete (anthropic "msg_07Example" "Plain string response" "end_turn" {"input_tokens" 5 "output_tokens" 3})
                    "claude-3-5-sonnet")]
    (is (= "Plain string response" (get (message-of c) "content")))))

(deftest anthropic-cached-token-details
  (let [c (complete (anthropic "msg_08Example" [{"type" "text" "text" "Cached response"}] "end_turn"
                               {"input_tokens" 1000 "output_tokens" 50 "cache_read_input_tokens" 900})
                    "claude-3-5-sonnet")
        usage (usage-of c)
        details (get usage "prompt_tokens_details")]
    (is (some? usage))
    (is (= 1000 (get usage "prompt_tokens")))
    (is (= 50 (get usage "completion_tokens")))
    (is (= 1050 (get usage "total_tokens")))
    (is (some? details))
    (is (= 900 (get details "cached_tokens")))))

(deftest anthropic-model-field-fallback
  (let [c (complete {"id" "msg_09Example" "type" "message" "role" "assistant"
                     "content" [{"type" "text" "text" "test"}] "stop_reason" "end_turn"
                     "usage" {"input_tokens" 1 "output_tokens" 1}}
                    "claude-opus-4-6")]
    (is (= "claude-opus-4-6" (get c "model")))))

(deftest anthropic-reasoning-with-text-field-instead-of-thinking-field
  (let [c (complete (anthropic "msg_10Example"
                               [{"type" "reasoning" "text" "Analyzing..."} {"type" "text" "text" "Done!"}]
                               "end_turn" {"input_tokens" 10 "output_tokens" 20})
                    "claude-3-5-sonnet")]
    (is (= "Analyzing..." (get (message-of c) "reasoning_content")))))

(deftest anthropic-text-with-thought-flag
  (let [message (message-of (complete (anthropic "msg_11Example"
                                                 [{"type" "text" "text" "Internal thought" "thought" true}
                                                  {"type" "text" "text" "External response"}]
                                                 "end_turn" {"input_tokens" 10 "output_tokens" 15})
                                      "claude-3-5-sonnet"))]
    (is (= "Internal thought" (get message "reasoning_content")))
    (is (= "Internal thoughtExternal response" (get message "content"))
        "thought=true text appears in both reasoning_content and content")))

(deftest anthropic-tool-use-with-string-input
  (let [message (message-of (complete (anthropic "msg_12Example"
                                                 [{"type" "tool_use" "id" "tu_05MNO345" "name" "query_db"
                                                   "input" "SELECT * FROM users"}]
                                                 "tool_use" {"input_tokens" 10 "output_tokens" 10})
                                      "claude-3-5-sonnet"))]
    (is (= "SELECT * FROM users" (get-in (first (get message "tool_calls")) ["function" "arguments"])))))

(deftest anthropic-content-is-never-undefined-for-non-tool-responses
  (let [message (message-of (complete (anthropic "msg_13Example" [] "end_turn" {"input_tokens" 1 "output_tokens" 0})
                                      "claude-3-5-sonnet"))]
    (is (contains? message "content"))
    (is (= "" (get message "content")))
    (is (some? (get message "content")))))

(deftest anthropic-complex-multi-part-response
  (let [message (message-of (complete (anthropic "msg_14Example"
                                                 [{"type" "thinking" "thinking" "Step 1: understand the problem"}
                                                  {"type" "thinking" "thinking" "Step 2: formulate answer"}
                                                  {"type" "text" "text" "First part."}
                                                  {"type" "text" "text" "Second part."}]
                                                 "end_turn" {"input_tokens" 50 "output_tokens" 100})
                                      "claude-3-5-sonnet"))]
    (is (= "First part.Second part." (get message "content")))
    (is (= "Step 1: understand the problemStep 2: formulate answer" (get message "reasoning_content")))))

(deftest anthropic-throws-on-non-record-body
  (is (thrown-with-msg? js/Error #"Invalid /v1/messages response payload"
                        (rt/messages-to-chat-completion-js nil "claude-3-5-sonnet"))))

(deftest anthropic-handles-missing-usage-gracefully
  (is (not (usage-of (complete (anthropic "msg_15Example" [{"type" "text" "text" "No usage"}] "end_turn" nil)
                               "claude-3-5-sonnet")))))

(deftest anthropic-handles-partial-usage-only-input-tokens
  (is (not (usage-of (complete (anthropic "msg_16Example" [{"type" "text" "text" "Partial"}] "end_turn" {"input_tokens" 10})
                               "claude-3-5-sonnet")))
      "no usage unless both token counts are present"))

(deftest anthropic-preserves-system-fingerprint-field
  (let [c (complete (anthropic "msg_17Example" [{"type" "text" "text" "test"}] "end_turn" {"input_tokens" 1 "output_tokens" 1})
                    "claude-3-5-sonnet")]
    (is (= "" (get c "system_fingerprint")))))

(deftest anthropic-generates-id-when-missing
  (let [c (complete {"type" "message" "role" "assistant" "model" sonnet
                     "content" [{"type" "text" "text" "test"}] "stop_reason" "end_turn"
                     "usage" {"input_tokens" 1 "output_tokens" 1}}
                    "claude-3-5-sonnet")]
    (is (string? (get c "id")))
    (is (.startsWith (get c "id") "chatcmpl_"))))
