(ns proxx.compat.responses-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.compat.responses :as r]))

(defn- thrown-message [f] (try (f) nil (catch :default e (ex-message e))))
(def ^:private now 1700000123456)

;; ---------------------------------------------------------------------------
;; text helpers
;; ---------------------------------------------------------------------------

(deftest content-text
  (is (= "ab" (r/content->text ["a" {"type" "output_text" "text" "b"} {"type" "reasoning" "text" "no"}
                                {"type" "image"} nil 5])))
  (is (= "r" (r/content->text [{"type" "refusal" "refusal" "r"}])))
  (is (= "" (r/content->text nil)))
  (is (= "{\"a\":1}" (r/content->text {"a" 1})))
  (is (= "5" (r/content->text 5)))
  (testing "a part with no type but text counts as text"
    (is (= "t" (r/content->text [{"text" "t"}])))))

(deftest reasoning-text
  (is (= "rtxy" (r/reasoning-text {"reasoning" "r" "text" "t" "summary" [{"text" "x"} nil {"summary" "y"}]})))
  (is (= "plain" (r/reasoning-text {"summary" "plain"})))
  (is (= "" (r/reasoning-text {}))))

(deftest tool-call-arguments
  (is (= "{}" (r/tool-call-arguments nil)))
  (is (= "raw" (r/tool-call-arguments "raw")))
  (is (= "{\"k\":1}" (r/tool-call-arguments {"k" 1})))
  (is (= "5" (r/tool-call-arguments 5))))

(deftest upstream-prefixes
  (is (r/should-use-responses-upstream? "GPT-5.1" ["gpt-5"]))
  (is (not (r/should-use-responses-upstream? "claude" ["gpt-5"])))
  (is (not (r/should-use-responses-upstream? nil ["gpt-5"]))))

;; ---------------------------------------------------------------------------
;; chat -> responses request
;; ---------------------------------------------------------------------------

(defn- ->responses [body] (r/chat-request->responses-request body))

(deftest chat->responses-instructions-and-input
  (let [out (->responses {"model" "gpt-5"
                          "messages" [{"role" "system" "content" "a"}
                                      {"role" "developer" "content" [{"type" "text" "text" "b"}]}
                                      {"role" "user" "content" "hi"}]})]
    (is (= "a\nb" (get out "instructions")))
    (is (= "gpt-5" (get out "model")))
    (is (= [{"role" "system" "content" "a"}
            {"role" "developer" "content" [{"type" "input_text" "text" "b"}]}
            {"role" "user" "content" "hi"}]
           (get out "input"))
        "system/developer turns stay in input as well as instructions"))
  (is (= {"instructions" "" "input" []} (->responses {})) "no model key is invented"))

(deftest chat->responses-roles-are-validated
  (is (= "messages entries must include a string role" (thrown-message #(->responses {"messages" [{"content" "x"}]}))))
  (is (= "messages entries must include a string role" (thrown-message #(->responses {"messages" [{"role" ""}]}))))
  (is (= "unsupported messages role: narrator" (thrown-message #(->responses {"messages" [{"role" "narrator"}]}))))
  (is (= :responses/unsupported-role
         (try (->responses {"messages" [{"role" "narrator"}]}) (catch :default e (:error/type (ex-data e))))))
  (is (= [] (get (->responses {"messages" [nil "s" 5]}) "input")) "non-object entries are skipped"))

(deftest chat->responses-assistant-and-tools
  (is (= [{"role" "assistant" "content" [{"type" "output_text" "text" "t"}]}
          {"type" "function_call" "call_id" "c1" "name" "f" "arguments" "{\"a\":1}"}
          {"type" "function_call" "call_id" "call_0_2" "name" "g" "arguments" "{\"k\":1}"}
          {"type" "function_call_output" "call_id" "c1" "output" "res"}]
         (get (->responses {"messages" [{"role" "assistant" "content" [{"type" "text" "text" "t"}]
                                         "tool_calls" [{"id" "c1" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}
                                                       {"type" "other" "function" {"name" "skip"}}
                                                       {"function" {"name" "g" "arguments" {"k" 1}}}]}
                                        {"role" "tool" "tool_call_id" "c1" "content" "res"}
                                        {"role" "tool" "content" "dropped"}]})
              "input")))
  (testing "an assistant turn with neither content nor calls keeps an empty marker"
    (is (= [{"role" "assistant" "content" ""}] (get (->responses {"messages" [{"role" "assistant"}]}) "input")))
    (is (= [{"role" "assistant" "content" ""}] (get (->responses {"messages" [{"role" "assistant" "content" ""}]}) "input"))))
  (testing "calls alone need no empty marker; unusable calls still suppress it"
    (is (= [{"type" "function_call" "call_id" "x" "name" "f" "arguments" "{}"}]
           (get (->responses {"messages" [{"role" "assistant" "tool_calls" [{"id" "x" "function" {"name" "f"}}]}]}) "input")))
    (is (= [] (get (->responses {"messages" [{"role" "assistant" "tool_calls" [{"function" {}}]}]}) "input")))))

(deftest chat->responses-content-parts
  (let [content (fn [role parts] (get-in (->responses {"messages" [{"role" role "content" parts}]}) ["input" 0 "content"]))]
    (is (= [{"type" "output_text" "text" "s"} {"type" "output_text" "text" "t"}]
           (content "assistant" ["s" {"type" "input_text" "text" "t"} {"type" "reasoning" "text" "x"} nil])))
    (is (= [{"type" "input_text" "text" ""}] (content "user" [{"type" "text"}])))
    (is (= [{"type" "x" "keep" 1}]
           (content "user" [{"type" "x" "keep" 1 "tool_calls" [1] "reasoning_content" "r" "function_call" {} "reasoning_details" 2}]))
        "interleaved reasoning keys are stripped from unknown parts")
    (is (= [5 true] (content "user" [5 true])) "scalar parts pass through")))

(deftest chat->responses-images
  (let [img (fn [part] (get-in (->responses {"messages" [{"role" "user" "content" [part]}]}) ["input" 0 "content" 0]))]
    (is (= {"type" "input_image" "image_url" "https://x" "detail" "high"}
           (img {"type" "image_url" "image_url" {"url" "https://x" "detail" "high"}})))
    (is (= {"type" "input_image" "image_url" "u" "file_id" "f" "detail" "low"}
           (img {"type" "input_image" "image_url" "u" "file_id" "f" "detail" "low"})))
    (is (= {"type" "input_image" "file_id" "f2"} (img {"type" "image" "file_id" "f2"})))
    (is (= {"type" "input_image" "image_url" "https://z"} (img {"type" "image" "source" {"type" "url" "url" "https://z"}})))
    (is (= {"type" "input_image" "image_url" "data:image/jpeg;base64,ZZ"}
           (img {"type" "image" "source" {"type" "base64" "data" "ZZ" "media_type" "image/jpeg"}})))
    (is (= {"type" "input_image" "image_url" "data:application/octet-stream;base64,ZZ"}
           (img {"type" "image" "source" {"type" "base64" "data" "ZZ"}})))
    (is (= {"type" "input_image" "image_url" "https://u"} (img {"type" "image" "url" "https://u"})))
    (is (= {"type" "input_image" "image_url" "data:image/webp;base64,DD"} (img {"type" "image" "data" "DD" "mimeType" "image/webp"})))
    (is (= {"type" "image"} (img {"type" "image"})) "an image with nothing usable passes through")))

(deftest chat->responses-parameters
  (let [out (->responses {"max_tokens" 10 "max_completion_tokens" 20 "temperature" nil "metadata" {"a" 1} "stray" 1})]
    (is (= 10 (get out "max_output_tokens")) "max_tokens wins over max_completion_tokens")
    (is (contains? out "temperature") "explicit null is forwarded")
    (is (= {"a" 1} (get out "metadata")))
    (is (not (contains? out "stray"))))
  (is (= 20 (get (->responses {"max_completion_tokens" 20 "max_tokens" "x"}) "max_output_tokens")))
  (testing "reasoning knobs fold into one object without overriding explicit values"
    (is (= {"effort" "xhigh"} (get (->responses {"reasoning_effort" "max"}) "reasoning")))
    (is (= {"effort" "high"} (get (->responses {"reasoning" {"effort" "high"} "reasoning_effort" "low"}) "reasoning")))
    (is (= {"effort" "high" "summary" "auto"}
           (get (->responses {"reasoningEffort" "high" "reasoning_summary" "auto"}) "reasoning")))
    (is (= "x" (get (->responses {"reasoning" "x"}) "reasoning")) "a non-object reasoning passes when no knobs"))
  (testing "verbosity folds into text with a default format"
    (is (= {"format" {"type" "text"} "verbosity" "low"} (get (->responses {"text_verbosity" "low"}) "text")))
    (is (= {"format" {"type" "json_object"} "verbosity" "low"}
           (get (->responses {"text" {"format" {"type" "json_object"}} "textVerbosity" "low"}) "text")))
    (is (= {"verbosity" "low" "format" {"type" "text"}}
           (get (->responses {"text" {"verbosity" "low"} "text_verbosity" "high"}) "text")))))

(deftest chat->responses-tools
  (is (= [{"type" "function" "name" "f" "description" "d" "parameters" {"type" "object"} "strict" true}
          {"type" "function" "name" "n" "parameters" {}}
          {"type" "web_search"}
          {"name" "top"}
          {"type" "" "name" "e"}]
         (get (->responses {"tools" [{"type" "function" "function" {"name" "f" "description" "d" "parameters" {"type" "object"} "strict" true}}
                                     {"type" "function" "name" "n" "parameters" {}}
                                     {"type" "web_search"}
                                     nil
                                     {"function" {"name" ""}}
                                     {"name" "top"}
                                     {"type" "" "name" "e"}]})
              "tools")))
  (is (= "x" (get (->responses {"tools" "x"}) "tools")))
  (doseq [[in out] [[{"type" "function" "function" {"name" "f"}} {"type" "function" "name" "f"}]
                    [{"type" "function" "name" "g"} {"type" "function" "name" "g"}]
                    [{"type" "function"} {"type" "function"}]
                    [{"type" "function" "function" {}} {"type" "function" "function" {}}]
                    ["auto" "auto"]
                    [{"type" "allowed_tools"} {"type" "allowed_tools"}]]]
    (is (= out (get (->responses {"tool_choice" in}) "tool_choice")) (pr-str in))))

;; ---------------------------------------------------------------------------
;; responses -> chat request
;; ---------------------------------------------------------------------------

(defn- ->chat [body] (r/responses-request->chat-request body))

(deftest responses->chat-messages
  (is (= [{"role" "system" "content" "sys"} {"role" "user" "content" "hello"}]
         (get (->chat {"instructions" "  sys " "input" "hello"}) "messages")))
  (is (= [] (get (->chat {"input" 5}) "messages")))
  (is (= [{"role" "user" "content" "hello"}] (get (->chat {"input" "hello" "instructions" "  "}) "messages")))
  (testing "when instructions exist, input system/developer turns are redundant"
    (is (= [{"role" "system" "content" "I"} {"role" "user" "content" "u"}]
           (get (->chat {"instructions" "I" "input" [{"role" "system" "content" "dup"} {"role" "developer" "content" "dup"} {"role" "user" "content" "u"}]})
                "messages")))
    (is (= [{"role" "developer" "content" "d"}]
           (get (->chat {"input" [{"role" "developer" "content" "d"}]}) "messages"))))
  (testing "unknown roles and non-objects are skipped; content defaults to empty string"
    (is (= [{"role" "user" "content" ""}] (get (->chat {"input" [nil 5 "s" {"role" "bogus" "content" "x"} {"role" "user"}]}) "messages")))))

(deftest responses->chat-parts
  (is (= [{"role" "user" "content" [{"type" "text" "text" "a"} {"type" "text" "text" "r"}
                                    {"type" "image_url" "image_url" {"url" "https://i" "detail" "low"}}
                                    {"type" "input_image"} "s" {"type" "x"}]}]
         (get (->chat {"input" [{"role" "user" "content" [{"type" "input_text" "text" "a"} {"type" "refusal" "refusal" "r"}
                                                          {"type" "input_image" "image_url" "https://i" "detail" "low"}
                                                          {"type" "input_image"} "s" nil {"type" "x"}]}]})
              "messages"))))

(deftest responses->chat-function-calls-ride-on-the-previous-assistant
  (testing "calls attach to a preceding assistant message"
    (is (= [{"role" "assistant" "content" "t"
             "tool_calls" [{"id" "c1" "type" "function" "function" {"name" "f" "arguments" "{}"}}
                           {"id" "i2" "type" "function" "function" {"name" "g" "arguments" "{\"a\":1}"}}]}
            {"role" "tool" "tool_call_id" "c1" "content" "res"}]
           (get (->chat {"input" [{"role" "assistant" "content" "t"}
                                  {"type" "function_call" "call_id" "c1" "name" "f" "arguments" "{}"}
                                  {"type" "function_call" "id" "i2" "name" "g" "arguments" {"a" 1}}
                                  {"type" "function_call_output" "call_id" "c1" "output" "res"}]})
                "messages"))))
  (testing "otherwise a synthetic empty assistant carries them, with positional ids"
    (is (= [{"role" "user" "content" "u"}
            {"role" "assistant" "content" ""
             "tool_calls" [{"id" "call_1" "type" "function" "function" {"name" "f" "arguments" "{}"}}]}]
           (get (->chat {"input" [{"role" "user" "content" "u"} {"type" "function_call" "name" "f"}]}) "messages"))))
  (testing "nameless calls and id-less outputs are dropped"
    (is (= [] (get (->chat {"input" [{"type" "function_call" "name" ""} {"type" "function_call_output" "output" "x"}]}) "messages")))))

(deftest responses->chat-parameters
  (let [out (->chat {"model" "m" "input" "hi" "stream" true "max_output_tokens" 99 "temperature" 1
                     "text" {"verbosity" "low"} "open_hax" {"a" 1} "stray" 1
                     "reasoning" {"effort" "high" "summary" "auto"}})]
    (is (= true (get out "stream")))
    (is (= 99 (get out "max_completion_tokens")))
    (is (= "high" (get out "reasoning_effort")))
    (is (= "auto" (get out "reasoning_summary")))
    (is (= {"a" 1} (get out "open_hax")))
    (is (not (contains? out "stray"))))
  (is (= false (get (->chat {"stream" "true"}) "stream")) "only literal true streams")
  (let [out (->chat {"reasoning" {"effort" 5 "summary" nil}})]
    (is (not (contains? out "reasoning_effort")))
    (is (not (contains? out "reasoning_summary"))))
  (is (= "x" (get (->chat {"reasoning" "x"}) "reasoning")))
  (is (contains? (->chat {"reasoning" nil}) "reasoning"))
  (is (= [{"type" "function" "function" {"name" "f" "description" "d" "parameters" {"a" 1} "strict" false}}
          {"type" "function" "function" {"name" "already"}}
          {"type" "web_search"}]
         (get (->chat {"tools" [{"type" "function" "name" "f" "description" "d" "parameters" {"a" 1} "strict" false}
                                {"type" "function" "function" {"name" "already"}}
                                {"type" "web_search"} nil {"type" "function"}]})
              "tools")))
  (is (= {"type" "function" "function" {"name" "f"}} (get (->chat {"tool_choice" {"type" "function" "name" "f"}}) "tool_choice")))
  (is (= {"type" "function"} (get (->chat {"tool_choice" {"type" "function"}}) "tool_choice"))))

;; ---------------------------------------------------------------------------
;; usage and completed responses
;; ---------------------------------------------------------------------------

(deftest usage-mapping
  (is (= {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3
          "input_tokens_details" {"cached_tokens" 4} "output_tokens_details" {"reasoning_tokens" 0}}
         (r/chat-usage->responses-usage {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3
                                         "prompt_tokens_details" {"cached_tokens" 4} "completion_tokens_details" {}})))
  (is (= {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3}
         (r/responses-usage->chat-usage {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3})))
  (is (= {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3
          "prompt_tokens_details" {"cached_tokens" 0} "completion_tokens_details" {"reasoning_tokens" 5}}
         (r/responses-usage->chat-usage {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3
                                         "input_tokens_details" {} "output_tokens_details" {"reasoning_tokens" 5}})))
  (doseq [bad [nil 5 {} {"prompt_tokens" 1 "completion_tokens" "2" "total_tokens" 3}]]
    (is (nil? (r/chat-usage->responses-usage bad)) (pr-str bad))))

(deftest chat-completion->response
  (let [out (r/chat-completion->responses-response
             {"id" "cmpl_1" "created" 1700000000 "model" "gpt-x"
              "choices" [{"message" {"content" "hi" "reasoning_content" "think"
                                     "tool_calls" [{"id" "c1" "function" {"name" "f" "arguments" {"k" 1}}}
                                                   nil {"function" {"name" ""}} {"function" {"name" "g"}}]}}]
              "usage" {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3}}
             now)]
    (is (= {"id" "cmpl_1" "object" "response" "created_at" 1700000000 "model" "gpt-x" "status" "completed"
            "usage" {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3}
            "output" [{"id" "rs_cmpl_1" "type" "reasoning" "summary" [{"type" "summary_text" "text" "think"}]}
                      {"id" "msg_cmpl_1" "type" "message" "role" "assistant" "status" "completed"
                       "content" [{"type" "output_text" "text" "hi"}]}
                      {"id" "fc_cmpl_1_0" "type" "function_call" "call_id" "c1" "name" "f" "arguments" "{\"k\":1}" "status" "completed"}
                      {"id" "fc_cmpl_1_3" "type" "function_call" "call_id" "call_3" "name" "g" "arguments" "{}" "status" "completed"}]}
           out)))
  (testing "clock-derived defaults"
    (let [out (r/chat-completion->responses-response {} now)]
      (is (= {"id" "resp_1700000123456" "object" "response" "created_at" 1700000123 "model" "" "status" "completed" "output" []}
             out))))
  (is (= "Invalid upstream chat completion payload" (thrown-message #(r/chat-completion->responses-response nil now)))))

(deftest response->chat-completion
  (let [out (r/responses->chat-completion
             {"id" "resp_1" "created_at" 5 "model" "m1"
              "output" [{"type" "reasoning" "summary" [{"text" "s1"}]}
                        {"type" "message" "role" "assistant" "reasoning" "mr"
                         "content" [{"type" "output_text" "text" "a"} {"type" "output_text" "text" "b"}
                                    {"type" "thinking" "reasoning" "tr"} {"type" "refusal" "refusal" "x"}]}
                        {"type" "message" "role" "user" "content" [{"type" "output_text" "text" "no"}]}]
              "usage" {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3}}
             "fb" now)]
    (is (= {"id" "resp_1" "object" "chat.completion" "created" 5 "model" "m1" "system_fingerprint" ""
            "usage" {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3}
            "choices" [{"index" 0 "finish_reason" "stop"
                        "message" {"role" "assistant" "content" "ab" "reasoning_content" "s1mrtr"}}]}
           out)))
  (testing "tool calls null the content and flip the finish reason"
    (let [out (r/responses->chat-completion
               {"output" [{"type" "function_call" "call_id" "c1" "name" "f" "arguments" {"a" 1}}
                          {"type" "function_call" "name" "g"} {"type" "function_call" "name" ""}]}
               "fb" now)]
      (is (= "tool_calls" (get-in out ["choices" 0 "finish_reason"])))
      (is (nil? (get-in out ["choices" 0 "message" "content"])))
      (is (= [{"id" "c1" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}
              {"id" "call_1" "type" "function" "function" {"name" "g" "arguments" "{}"}}]
             (get-in out ["choices" 0 "message" "tool_calls"])))
      (is (= "fb" (get out "model")))))
  (testing "top-level output_text only fills an empty answer"
    (is (= "top" (get-in (r/responses->chat-completion {"output" [] "output_text" "top"} "fb" now) ["choices" 0 "message" "content"])))
    (is (= "a" (get-in (r/responses->chat-completion {"output" [{"type" "message" "role" "assistant" "content" [{"type" "output_text" "text" "a"}]}]
                                                      "output_text" "top"} "fb" now)
                       ["choices" 0 "message" "content"])))
    (is (= "" (get-in (r/responses->chat-completion {"output" "no"} "fb" now) ["choices" 0 "message" "content"]))))
  (is (= "Invalid upstream responses payload" (thrown-message #(r/responses->chat-completion "x" "fb" now)))))

(deftest output-has-reasoning
  (is (r/output-has-reasoning? {"output" [nil {"type" "message"} {"type" "reasoning"}]}))
  (is (not (r/output-has-reasoning? {"output" [{"type" "message"}]})))
  (is (not (r/output-has-reasoning? {"output" "x"})))
  (is (not (r/output-has-reasoning? nil))))

;; ---------------------------------------------------------------------------
;; Intentional divergences from responses-compat.ts on degenerate input
;; ---------------------------------------------------------------------------

(deftest divergence-empty-strings-never-win-over-fallbacks
  (testing "an empty provider id/model falls back instead of leaking an empty value"
    (let [c (r/chat-completion->responses-response {"id" "" "choices" [nil]} now)]
      (is (= "resp_1700000123456" (get c "id"))))
    (let [c (r/responses->chat-completion {"model" ""} "fb" now)]
      (is (= "fb" (get c "model")))))
  (testing "an empty tool-call id gets a generated id (an empty id cannot be answered)"
    (is (= "call_0" (get-in (r/responses->chat-completion {"output" [{"type" "function_call" "call_id" "" "name" "i"}]} "fb" now)
                            ["choices" 0 "message" "tool_calls" 0 "id"])))))

(deftest divergence-empty-reasoning-content-does-not-mask-reasoning
  (is (= "r3" (get-in (r/chat-completion->responses-response
                       {"choices" [{"message" {"reasoning_content" "" "reasoning" "r3"}}]} now)
                      ["output" 0 "summary" 0 "text"]))))

(deftest divergence-arrays-are-not-objects
  (testing "an array body is rejected rather than treated as an empty record"
    (is (some? (thrown-message #(r/chat-completion->responses-response [] now))))
    (is (some? (thrown-message #(r/responses->chat-completion [] "fb" now)))))
  (testing "an array content part is passed through, not spread into an empty object"
    (is (= [[]] (get-in (r/chat-request->responses-request {"messages" [{"role" "user" "content" [[]]}]})
                        ["input" 0 "content"])))))
