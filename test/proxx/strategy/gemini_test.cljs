(ns proxx.strategy.gemini-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.json :as json]
            [proxx.runtime.strategy :as edge]
            [proxx.strategy.gemini :as g]))

(def ^:private now-ms 1700000123456)

(deftest reasoning-effort-aliases
  (doseq [[in out] [["none" "none"] ["Disable" "none"] [" OFF " "none"] ["minimal" "minimal"] ["low" "low"]
                    ["medium" "medium"] ["normal" "medium"] ["auto" "medium"] ["high" "high"]
                    ["xhigh" "xhigh"] ["very_high" "xhigh"] ["MAX" "xhigh"]]]
    (is (= out (g/normalize-reasoning-effort in)) in))
  (doseq [bad [nil "" "  " "bogus" 5 {} []]]
    (is (nil? (g/normalize-reasoning-effort bad)) (pr-str bad))))

(deftest thinking-config-by-model-family
  (testing "nothing requested -> nothing sent"
    (is (nil? (g/thinking-config {} "gemini-2.5-pro"))))
  (testing "2.5 budgets are a clamped fraction of the family maximum"
    (is (= {"thinkingBudget" 24576 "includeThoughts" true} (g/thinking-config {"reasoning_effort" "xhigh"} "gemini-2.5-flash"))
        "any effort that is not off also asks for the trace")
    (is (= {"thinkingBudget" 0} (g/thinking-config {"reasoning_effort" "none"} "gemini-2.5-flash-lite")))
    (is (= {"thinkingBudget" 128} (g/thinking-config {"reasoning_effort" "none"} "gemini-2.5-pro"))
        "pro cannot switch thinking off")
    (is (= {"thinkingBudget" 6144 "includeThoughts" true} (g/thinking-config {"reasoning" {"effort" "low"}} "gemini-2.5-flash")))
    (is (= {"thinkingBudget" 24576 "includeThoughts" true} (g/thinking-config {"reasoning_effort" "xhigh"} "GEMINI-2.5-FLASH"))))
  (testing "a trace request without an effort asks for dynamic thinking"
    (is (= {"thinkingBudget" -1 "includeThoughts" true}
           (g/thinking-config {"include" ["reasoning.encrypted_content"]} "gemini-2.5-pro"))))
  (testing "gemini 3 uses levels, flash differing from pro"
    (is (= {"thinkingLevel" "MEDIUM" "includeThoughts" true} (g/thinking-config {"reasoning_effort" "auto"} "gemini-3-flash")))
    (is (= {"thinkingLevel" "MINIMAL"} (g/thinking-config {"reasoning_effort" "none"} "gemini-3-flash")))
    (is (= {"thinkingLevel" "LOW" "includeThoughts" true} (g/thinking-config {"reasoning_effort" "medium"} "gemini-3.1-pro")))
    (is (= {"thinkingLevel" "HIGH" "includeThoughts" true} (g/thinking-config {"reasoning_effort" "xhigh"} "gemini-3.1-pro"))))
  (testing "unknown families get no thinking controls even when a trace is requested"
    (is (nil? (g/thinking-config {"reasoning_effort" "high"} "gemma-4-31b-it")))))

(deftest tool-calls-round-trip
  (testing "regression: assistant tool_calls survive even when content is null"
    (let [[user model] (g/openai-messages->gemini-contents
                        [{"role" "user" "content" "List the files"}
                         {"role" "assistant" "content" nil
                          "tool_calls" [{"id" "call_0" "type" "function"
                                         "function" {"name" "run_bash" "arguments" "{\"command\":\"ls -F\"}"}}]}])]
      (is (= {"role" "user" "parts" [{"text" "List the files"}]} user))
      (is (= {"role" "model"
              "parts" [{"functionCall" {"name" "run_bash" "args" {"command" "ls -F"}}}]}
             model))))
  (testing "regression: tool results take their name from the requesting tool_call"
    (let [contents (g/openai-messages->gemini-contents
                    [{"role" "assistant" "tool_calls" [{"id" "call_0" "function" {"name" "run_bash" "arguments" "{}"}}]}
                     {"role" "tool" "tool_call_id" "call_0" "content" "file_a\nfile_b"}])]
      (is (= {"role" "user"
              "parts" [{"functionResponse" {"name" "run_bash" "response" {"result" "file_a\nfile_b"}}}]}
             (second contents)))))
  (testing "assistant text is kept alongside its calls"
    (let [[model] (g/openai-messages->gemini-contents
                   [{"role" "assistant" "content" "Let me check."
                     "tool_calls" [{"id" "c1" "function" {"name" "f" "arguments" "{\"x\":1}"}}]}])]
      (is (= [{"text" "Let me check."} {"functionCall" {"name" "f" "args" {"x" 1}}}] (get model "parts")))))
  (testing "JSON object results pass through; other JSON is wrapped"
    (let [response (fn [content]
                     (get-in (first (g/openai-messages->gemini-contents [{"role" "tool" "name" "t" "content" content}]))
                             ["parts" 0 "functionResponse" "response"]))]
      (is (= {"a" 1} (response "{\"a\":1}")))
      (is (= {"result" 5} (response "5")))
      (is (= {"result" nil} (response "null")))
      (is (= {"result" ""} (response "")))
      (is (= {"result" "not json"} (response "not json")))))
  (testing "unnamed tool result with an unknown id is labelled `tool`"
    (is (= "tool" (get-in (first (g/openai-messages->gemini-contents [{"role" "tool" "tool_call_id" "zz" "content" "x"}]))
                          ["parts" 0 "functionResponse" "name"])))))

(deftest intentional-divergences-from-javascript-accidents
  (testing "an empty tool message name no longer shadows the tool_call_id lookup (JS `??` stopped at \"\")"
    (is (= "run_bash"
           (get-in (second (g/openai-messages->gemini-contents
                            [{"role" "assistant" "tool_calls" [{"id" "c" "function" {"name" "run_bash"}}]}
                             {"role" "tool" "tool_call_id" "c" "name" "" "content" "x"}]))
                   ["parts" 0 "functionResponse" "name"]))))
  (testing "array arguments are wrapped like every other non-object (JS isRecord([]) is true)"
    (is (= {"value" [1 2]}
           (get-in (first (g/openai-messages->gemini-contents
                           [{"role" "assistant" "tool_calls" [{"function" {"name" "f" "arguments" "[1,2]"}}]}]))
                   ["parts" 0 "functionCall" "args"]))))
  (testing "array tool results are wrapped as {result ...}"
    (is (= {"result" [1]}
           (get-in (first (g/openai-messages->gemini-contents [{"role" "tool" "name" "t" "content" "[1]"}]))
                   ["parts" 0 "functionResponse" "response"]))))
  (testing "array tool parameters are not an object schema: dropped, not forwarded"
    (is (= {"contents" [{"role" "user" "parts" [{"text" "x"}]}] "tools" [{"functionDeclarations" [{"name" "b"}]}]}
           (g/build-payload {"messages" [{"role" "user" "content" "x"}]
                             "tools" [{"type" "function" "function" {"name" "b" "parameters" []}}]} "gemini-2.5-pro"))))
  (testing "SDK request: a null temperature and an array toolConfig are not forwarded"
    (is (= {} (get (g/payload->sdk-request "m" {"contents" [] "generationConfig" {"temperature" nil} "toolConfig" []}) "config"))))
  (testing "malformed contents entries are dropped by the SDK request builder instead of throwing"
    (is (= [{"role" "user" "parts" []}]
           (get (g/payload->sdk-request "gemini-2.5-pro" {"contents" [nil {"role" "user"} "x"]}) "contents")))))

(deftest system-and-plain-messages
  (is (= ["S1" "S2"] (g/system-instructions [{"role" "system" "content" "S1"} {"role" "SYSTEM " "content" " S2 "}
                                              {"role" "user" "content" "u"} {"role" "system" "content" "  "}])))
  (is (= [{"role" "user" "parts" [{"text" "Part 1Part 2"}]}]
         (g/openai-messages->gemini-contents [{"role" "user" "content" [{"type" "text" "text" "Part 1"} {"type" "text" "text" "Part 2"}]}])))
  (is (= [{"role" "model" "parts" [{"text" "Valid"}]}]
         (g/openai-messages->gemini-contents [{"role" "user" "content" ""} {"role" "user" "content" "   "}
                                               {"role" "assistant" "content" "Valid"} {"role" "system" "content" "s"}
                                               "junk" nil]))))

(deftest build-payload-tools-and-choice
  (let [body {"model" "gemini-2.5-pro"
              "messages" [{"role" "system" "content" "be brief"} {"role" "user" "content" "weather?"}]
              "temperature" 0.2 "max_tokens" 50
              "tools" [{"type" "function"
                        "function" {"name" "get_weather" "description" "Get the current weather"
                                    "parameters" {"type" "object"}}}
                       {"type" "retrieval"} {"type" "function" "function" {"name" ""}} nil]
              "tool_choice" "auto"}
        payload (g/build-payload body "gemini-2.5-pro")]
    (is (= [{"functionDeclarations" [{"name" "get_weather" "description" "Get the current weather"
                                      "parameters" {"type" "object"}}]}]
           (get payload "tools")))
    (is (= {"functionCallingConfig" {"mode" "AUTO"}} (get payload "toolConfig")))
    (is (= {"parts" [{"text" "be brief"}]} (get payload "systemInstruction")))
    (is (= {"temperature" 0.2 "maxOutputTokens" 50} (get payload "generationConfig"))))
  (doseq [[choice expected] [["none" {"functionCallingConfig" {"mode" "NONE"}}]
                             ["required" {"functionCallingConfig" {"mode" "ANY"}}]
                             ["other" {"functionCallingConfig" {"mode" "AUTO"}}]
                             [{"type" "function" "function" {"name" "get_weather"}}
                              {"functionCallingConfig" {"mode" "ANY" "allowedFunctionNames" ["get_weather"]}}]
                             [{"type" "function"} nil]
                             [{"type" "auto"} nil]]]
    (is (= expected (get (g/build-payload {"messages" [] "tool_choice" choice} "gemini-2.5-pro") "toolConfig")) (pr-str choice)))
  (testing "output-token limit spellings, first finite number wins"
    (is (= {"maxOutputTokens" 7} (get (g/build-payload {"max_output_tokens" 7 "max_tokens" 9} "m") "generationConfig")))
    (is (= {"maxOutputTokens" 9} (get (g/build-payload {"max_output_tokens" "x" "max_tokens" 9} "m") "generationConfig")))
    (is (= {"maxOutputTokens" 3} (get (g/build-payload {"maxTokens" 3} "m") "generationConfig"))))
  (testing "an empty request is just empty contents"
    (is (= {"contents" []} (g/build-payload {} "gemini-2.5-pro")))))

(deftest response-translation
  (let [conv #(g/response->chat-completion % "gemini-2.5-pro" now-ms)]
    (testing "basic text and usage"
      (is (= {"id" "chatcmpl-gemini-1700000123" "object" "chat.completion" "created" 1700000123
              "model" "gemini-2.5-pro"
              "choices" [{"index" 0 "message" {"role" "assistant" "content" "Hello"} "finish_reason" "stop"}]
              "usage" {"prompt_tokens" 10 "completion_tokens" 7 "total_tokens" 17}}
             (conv {"candidates" [{"content" {"parts" [{"text" "Hello"}]} "finishReason" "STOP"}]
                    "usageMetadata" {"promptTokenCount" 10 "candidatesTokenCount" 7 "totalTokenCount" 17}}))))
    (testing "total is derived only when both halves are present"
      (is (= {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3}
             (get (conv {"usageMetadata" {"promptTokenCount" 1 "candidatesTokenCount" 2}}) "usage")))
      (is (= {"prompt_tokens" 1} (get (conv {"usageMetadata" {"promptTokenCount" 1}}) "usage")))
      (is (nil? (get (conv {"usageMetadata" {}}) "usage"))))
    (testing "thought parts become reasoning_content; text parts join with newlines"
      (let [message (get-in (conv {"candidates" [{"content" {"parts" [{"text" "Let me think..." "thought" true}
                                                                      {"text" "A"} {"text" ""} {"text" " B "}]}}]})
                            ["choices" 0 "message"])]
        (is (= "A\nB" (get message "content")))
        (is (= "Let me think..." (get message "reasoning_content")))))
    (testing "finish reasons"
      (is (= "length" (get-in (conv {"candidates" [{"finishReason" "MAX_TOKENS" "content" {"parts" []}}]}) ["choices" 0 "finish_reason"])))
      (is (= "stop" (get-in (conv {"candidates" [{"finishReason" "SAFETY"}]}) ["choices" 0 "finish_reason"])))
      (is (= "length" (get-in (conv {"candidates" [{"finish_reason" "max_tokens"}]}) ["choices" 0 "finish_reason"]))))
    (testing "regression: functionCall parts become OpenAI tool_calls with numbered ids"
      (let [message (get-in (conv {"candidates" [{"content" {"parts" [{"functionCall" {"name" "f" "args" {"a" 1}}}
                                                                     {"functionCall" {"name" "" "args" {}}}
                                                                     {"functionCall" {"name" "g"}}
                                                                     {"functionCall" {"name" "h" "args" "{\"raw\":1}"}}]}}]})
                            ["choices" 0 "message"])]
        (is (nil? (get message "content")) "content is null when only tools were produced")
        (is (= [{"id" "call_gemini_0" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}
                {"id" "call_gemini_1" "type" "function" "function" {"name" "g" "arguments" "{}"}}
                {"id" "call_gemini_2" "type" "function" "function" {"name" "h" "arguments" "{\"raw\":1}"}}]
               (get message "tool_calls")))))
    (testing "text beside tool calls is kept"
      (is (= "ok" (get-in (conv {"candidates" [{"content" {"parts" [{"text" "ok"} {"functionCall" {"name" "f"}}]}}]})
                          ["choices" 0 "message" "content"]))))
    (testing "degenerate responses yield an empty assistant message"
      (doseq [bad [nil "x" 5 [] {} {"candidates" "no"} {"candidates" [nil]} {"candidates" [{"content" "x"}]}]]
        (is (= "" (get-in (conv bad) ["choices" 0 "message" "content"])) (pr-str bad))
        (is (nil? (get (conv bad) "usage")))))))

(deftest sdk-request-preserves-part-shapes
  (testing "regression: tool declarations, toolConfig and system text reach the SDK"
    (let [payload {"contents" [{"role" "user" "parts" [{"text" "Send it."}]}]
                   "tools" [{"functionDeclarations" [{"name" "discord_send"}]}]
                   "toolConfig" {"functionCallingConfig" {"mode" "AUTO"}}
                   "generationConfig" {"maxOutputTokens" 128 "temperature" 0}
                   "systemInstruction" {"parts" [{"text" "Use tools"} nil {"text" "when asked."}]}}
          request (g/payload->sdk-request "gemma-4-31b-it" payload)]
      (is (= (get payload "contents") (get request "contents")))
      (is (= {"tools" (get payload "tools") "toolConfig" (get payload "toolConfig")
              "maxOutputTokens" 128 "temperature" 0 "systemInstruction" "Use tools\n\nwhen asked."}
             (get request "config")))))
  (testing "regression: functionCall/functionResponse parts are not flattened to {text}"
    (let [contents [{"role" "user" "parts" [{"text" "List files"}]}
                    {"role" "model" "parts" [{"functionCall" {"name" "run_bash" "args" {"command" "ls"}}}]}
                    {"role" "user" "parts" [{"functionResponse" {"name" "run_bash" "response" {"result" "a\nb"}}}]}]]
      (is (= contents (get (g/payload->sdk-request "m" {"contents" contents}) "contents"))))))

(deftest stream-accumulation
  (let [fold (fn [chunks] (reduce g/stream-step g/initial-stream chunks))
        completion (fn [chunks] (g/stream->completion (fold chunks) "gemini-2.5-pro" now-ms))]
    (testing "text and thoughts concatenate across chunks; function calls are retained whole"
      (let [message (get-in (completion [{"candidates" [{"content" {"parts" [{"text" "Hel"} {"text" "th" "thought" true}]}}]}
                                         {"candidates" [{"content" {"parts" [{"text" "lo"} {"text" "ink" "thought" true}
                                                                            {"functionCall" {"name" "f" "args" {"x" 1}}}]}}]}
                                         "junk" {"candidates" []} nil])
                            ["choices" 0 "message"])]
        (is (= "Hello" (get message "content")))
        (is (= "think" (get message "reasoning_content")))
        (is (= "f" (get-in message ["tool_calls" 0 "function" "name"])))))
    (testing "an empty stream still produces an assistant message"
      (is (= "" (get-in (completion []) ["choices" 0 "message" "content"]))))))

(deftest sdk-error-classification
  (is (= {:rate-limit true} (g/classify-sdk-error "429 RATE_LIMIT exceeded")))
  (is (= {:rate-limit true} (g/classify-sdk-error "hit the rate limit")))
  (is (= {:model-not-found true} (g/classify-sdk-error "MODEL_NOT_FOUND")))
  (is (= {:model-not-supported-for-account true :request-error true} (g/classify-sdk-error "model not supported")))
  (is (= {:request-error true :upstream-invalid-request true} (g/classify-sdk-error "INVALID_ARGUMENT: bad")))
  (is (= {:request-error true} (g/classify-sdk-error "boom")))
  (is (= {:rate-limit true} (g/classify-sdk-error "rate limit and model not found")) "first match wins"))

(deftest edge-predicates
  (is (g/local-base-url? "http://127.0.0.1:8080/v1"))
  (is (g/local-base-url? "https://localhost"))
  (is (not (g/local-base-url? "https://generativelanguage.googleapis.com/v1beta")))
  (is (not (g/local-base-url? "http://localhost.evil.com")))
  (is (g/sdk-eligible-model? "gemini-2.5-pro"))
  (is (g/sdk-eligible-model? "models/gemini-pro"))
  (is (g/sdk-eligible-model? "gemma-4-31b-it"))
  (is (not (g/sdk-eligible-model? "gpt-5")))
  (is (= "/models/gemini-2.5-pro:generateContent" (g/upstream-path nil "gemini-2.5-pro")))
  (is (= "/models/alias%2Fx:generateContent" (g/upstream-path "alias/x" "gemini-2.5-pro"))))

(deftest js-edge
  (testing "SDK responses are class instances: their own data properties must still be read"
    (let [Response (fn [] (this-as this (aset this "candidates" #js [#js {"content" #js {"parts" #js [#js {"text" "hi"}]}}]) this))
          sdk (js/Reflect.construct Response #js [])
          completion (edge/gemini-response-to-chat-completion-js sdk "gemini-2.5-pro")]
      (is (= "hi" (.. completion -choices (at 0) -message -content)))))
  (testing "outcome flags use the camelCase names the attempt executor reads"
    (let [o (edge/classify-gemini-sdk-error-js "not supported")]
      (is (= "continue" (.-kind o)))
      (is (true? (.-modelNotSupportedForAccount o)))
      (is (true? (.-requestError o)))))
  (testing "stream accumulator"
    (let [acc (edge/create-gemini-stream-accumulator-js)]
      (.push acc #js {"candidates" #js [#js {"content" #js {"parts" #js [#js {"text" "a"}]}}]})
      (.push acc #js {"candidates" #js [#js {"content" #js {"parts" #js [#js {"text" "b"}]}}]})
      (is (= "ab" (.. (.completion acc "m") -choices (at 0) -message -content)))))
  (testing "undefined alias is no alias"
    (is (= "/models/m:generateContent" (edge/gemini-upstream-path-js js/undefined "m")))
    (is (nil? (edge/normalize-gemini-reasoning-effort-js "x")) "undefined is nil in cljs")))
