(ns proxx.runtime.gemini-edge-test
  "Ported from src/tests/gemini-strategy.test.ts (29 tests). The TS module was a
  shim over proxx.runtime.strategy (translation) and the registry's strategy
  objects (proxx.runtime.strategies); both are driven here with JS values, as the
  shim passed them, and results are read back as data."
  (:require [cljs.test :refer [deftest is testing]]
            [clojure.string :as str]
            [proxx.runtime.strategies :as strategies]
            [proxx.runtime.strategy :as s]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- ->data [x] (js->clj x))
(defn- contents-of [messages] (->data (s/open-ai-messages-to-gemini-contents-js (clj->js messages))))
(defn- completion-of [response model] (->data (s/gemini-response-to-chat-completion-js (clj->js response) model)))
(defn- choice-of [c] (first (get c "choices")))
(defn- message-of [c] (let [m (get (choice-of c) "message")] (if (map? m) m {})))
(defn- usage-of [c] (let [u (get c "usage")] (when (map? u) u)))

;; ---- request transformation -------------------------------------------------

(deftest converts-openai-messages-to-gemini-contents
  (let [contents (contents-of [{"role" "system" "content" "You are a helpful assistant"}
                               {"role" "user" "content" "Hello"}
                               {"role" "assistant" "content" "Hi there"}])]
    (is (= 2 (count contents)))
    (is (= "user" (get-in contents [0 "role"])))
    (is (= "Hello" (get-in contents [0 "parts" 0 "text"])))
    (is (= "model" (get-in contents [1 "role"])))
    (is (= "Hi there" (get-in contents [1 "parts" 0 "text"])))))

(deftest extracts-system-instructions-separately
  (let [instructions (->data (s/extract-system-instructions-js
                              (clj->js [{"role" "system" "content" "System prompt 1"}
                                        {"role" "system" "content" "System prompt 2"}
                                        {"role" "user" "content" "Hello"}])))]
    (is (= 2 (count instructions)))
    (is (= "System prompt 1" (nth instructions 0)))
    (is (= "System prompt 2" (nth instructions 1)))))

(deftest handles-array-content-parts
  (let [contents (contents-of [{"role" "user" "content" [{"type" "text" "text" "Part 1"} {"type" "text" "text" "Part 2"}]}])]
    (is (= 1 (count contents)))
    (is (= "Part 1Part 2" (get-in contents [0 "parts" 0 "text"])))))

(deftest skips-empty-messages
  (let [contents (contents-of [{"role" "user" "content" ""}
                               {"role" "user" "content" "   "}
                               {"role" "assistant" "content" "Valid"}])]
    (is (= 1 (count contents)))
    (is (= "Valid" (get-in contents [0 "parts" 0 "text"])))))

(deftest round-trips-assistant-tool-calls-into-gemini-function-call-parts
  (let [contents (contents-of [{"role" "user" "content" "List the files"}
                               {"role" "assistant" "content" nil
                                "tool_calls" [{"id" "call_0" "type" "function"
                                               "function" {"name" "run_bash" "arguments" "{\"command\":\"ls -F\"}"}}]}])
        fn-call (get-in contents [1 "parts" 0 "functionCall"])]
    (is (= 2 (count contents)))
    (is (= "model" (get-in contents [1 "role"])) "the content:null assistant message must NOT be dropped, it carries the tool call")
    (is (some? fn-call) "expected a functionCall part")
    (is (= "run_bash" (get fn-call "name")))
    (is (= {"command" "ls -F"} (get fn-call "args")))))

(deftest round-trips-tool-result-messages-into-gemini-function-response-parts
  (let [contents (contents-of [{"role" "user" "content" "List the files"}
                               {"role" "assistant" "content" nil
                                "tool_calls" [{"id" "call_0" "type" "function" "function" {"name" "run_bash" "arguments" "{}"}}]}
                               ;; OpenAI tool result, name omitted: resolved from tool_call_id
                               {"role" "tool" "tool_call_id" "call_0" "content" "file_a\nfile_b"}])
        fn-resp (get-in contents [2 "parts" 0 "functionResponse"])]
    (is (= 3 (count contents)))
    (is (= "user" (get-in contents [2 "role"])) "Gemini has no tool role: responses go back under user")
    (is (some? fn-resp) "expected a functionResponse part")
    (is (= "run_bash" (get fn-resp "name")))
    (is (= {"result" "file_a\nfile_b"} (get fn-resp "response")))))

(deftest keeps-assistant-text-alongside-tool-calls
  (let [contents (contents-of [{"role" "assistant" "content" "Let me check."
                                "tool_calls" [{"id" "c1" "type" "function" "function" {"name" "f" "arguments" "{\"x\":1}"}}]}])]
    (is (= 1 (count contents)))
    (is (= "model" (get-in contents [0 "role"])))
    (is (= "Let me check." (get-in contents [0 "parts" 0 "text"])))
    (is (= "f" (get-in contents [0 "parts" 1 "functionCall" "name"])))))

;; ---- tool request transformation --------------------------------------------

(defn- gemini-context [request-body]
  (clj->js {"routeProviderId" "gemini"
            "config" {"cljsPolicyManifestPath" manifest}
            "clientHeaders" {}
            "requestBody" request-body
            "requestedModelInput" "gemini-2.5-pro" "routingModelInput" "gemini-2.5-pro" "routedModel" "gemini-2.5-pro"
            "explicitOllama" false "openAiPrefixed" false "factoryPrefixed" false "localOllama" false
            "clientWantsStream" false "needsReasoningTrace" false "upstreamAttemptTimeoutMs" 30000
            "responsesPassthrough" false "imagesPassthrough" false}))

(defn- build-payload [request-body]
  (let [^js strategy (strategies/strategy-for-id-js "gemini-chat")]
    (->data (.-upstreamPayload ^js (.buildPayload strategy (gemini-context request-body))))))

(def ^:private weather-tool
  {"type" "function" "function" {"name" "get_weather" "description" "Get weather"}})

(deftest transforms-openai-tools-to-gemini-function-declarations
  (let [payload (build-payload
                 {"model" "gemini-2.5-pro"
                  "messages" [{"role" "user" "content" "What's the weather?"}]
                  "tools" [{"type" "function"
                            "function" {"name" "get_weather" "description" "Get the current weather"
                                        "parameters" {"type" "object"
                                                      "properties" {"location" {"type" "string" "description" "City name"}
                                                                    "unit" {"type" "string" "enum" ["celsius" "fahrenheit"]}}
                                                      "required" ["location"]}}}]
                  "tool_choice" "auto"})
        tools (get payload "tools")
        declarations (get (first tools) "functionDeclarations")
        declaration (first declarations)]
    (is (vector? tools) "tools should be an array")
    (is (= 1 (count tools)))
    (is (vector? declarations) "functionDeclarations should be an array")
    (is (= 1 (count declarations)))
    (is (= "get_weather" (get declaration "name")))
    (is (= "Get the current weather" (get declaration "description")))
    (is (map? (get declaration "parameters")))
    (is (= "object" (get-in declaration ["parameters" "type"])))
    (is (map? (get payload "toolConfig")))
    (is (= "AUTO" (get-in payload ["toolConfig" "functionCallingConfig" "mode"])))))

(deftest preserves-gemini-tool-declarations-and-tool-config-for-sdk-direct-execution
  (let [payload {"contents" [{"role" "user" "parts" [{"text" "Send it."}]}]
                 "tools" [{"functionDeclarations" [{"name" "discord_send"}]}]
                 "toolConfig" {"functionCallingConfig" {"mode" "AUTO"}}
                 "generationConfig" {"maxOutputTokens" 128}
                 "systemInstruction" {"parts" [{"text" "Use tools when asked."}]}}
        request (->data (s/gemini-payload-to-sdk-request-js "gemma-4-31b-it" (clj->js payload)))]
    (is (= (get payload "contents") (get request "contents")))
    (is (map? (get request "config")))
    (is (= (get payload "tools") (get-in request ["config" "tools"])))
    (is (= (get payload "toolConfig") (get-in request ["config" "toolConfig"])))
    (is (= 128 (get-in request ["config" "maxOutputTokens"])))
    (is (= "Use tools when asked." (get-in request ["config" "systemInstruction"])))))

(deftest preserves-function-call-and-function-response-parts-for-sdk-direct-execution
  (let [payload {"contents" [{"role" "user" "parts" [{"text" "List files"}]}
                             {"role" "model" "parts" [{"functionCall" {"name" "run_bash" "args" {"command" "ls"}}}]}
                             {"role" "user" "parts" [{"functionResponse" {"name" "run_bash" "response" {"result" "a\nb"}}}]}]}
        request (->data (s/gemini-payload-to-sdk-request-js "gemma-4-31b-it" (clj->js payload)))
        contents (get request "contents")]
    (is (= 3 (count contents)) "the part shapes must survive, not be flattened to { text: undefined }")
    (is (= "run_bash" (get-in contents [1 "parts" 0 "functionCall" "name"])))
    (is (= {"command" "ls"} (get-in contents [1 "parts" 0 "functionCall" "args"])))
    (is (= "run_bash" (get-in contents [2 "parts" 0 "functionResponse" "name"])))))

(deftest transforms-openai-tool-choice-none-to-gemini-none-mode
  (let [payload (build-payload {"model" "gemini-2.5-pro" "messages" [{"role" "user" "content" "Hello"}]
                                "tools" [weather-tool] "tool_choice" "none"})]
    (is (map? (get payload "toolConfig")))
    (is (= "NONE" (get-in payload ["toolConfig" "functionCallingConfig" "mode"])))))

(deftest transforms-openai-specific-tool-choice-to-gemini-any-mode-with-allowed-function-names
  (let [payload (build-payload {"model" "gemini-2.5-pro" "messages" [{"role" "user" "content" "Hello"}]
                                "tools" [weather-tool]
                                "tool_choice" {"type" "function" "function" {"name" "get_weather"}}})
        config (get-in payload ["toolConfig" "functionCallingConfig"])]
    (is (map? (get payload "toolConfig")))
    (is (= "ANY" (get config "mode")))
    (is (vector? (get config "allowedFunctionNames")))
    (is (= ["get_weather"] (get config "allowedFunctionNames")))))

;; ---- response transformation ------------------------------------------------

(deftest transforms-basic-gemini-response-to-openai-chat-completion
  (let [c (completion-of {"candidates" [{"content" {"role" "model" "parts" [{"text" "Hello, how can I help?"}]}
                                         "finishReason" "STOP"}]
                          "usageMetadata" {"promptTokenCount" 10 "candidatesTokenCount" 7 "totalTokenCount" 17}}
                         "gemini-2.5-pro")
        message (message-of c)
        usage (usage-of c)]
    (is (map? c))
    (is (= "chat.completion" (get c "object")))
    (is (= "gemini-2.5-pro" (get c "model")))
    (is (= 1 (count (get c "choices"))))
    (is (= "assistant" (get message "role")))
    (is (= "Hello, how can I help?" (get message "content")))
    (is (= "stop" (get (choice-of c) "finish_reason")))
    (is (some? usage))
    (is (= 10 (get usage "prompt_tokens")))
    (is (= 7 (get usage "completion_tokens")))
    (is (= 17 (get usage "total_tokens")))))

(deftest handles-reasoning-thinking-content-separately
  (let [c (completion-of {"candidates" [{"content" {"role" "model" "parts" [{"text" "Let me think..." "thought" true}
                                                                            {"text" "The answer is 42"}]}
                                         "finishReason" "STOP"}]
                          "usageMetadata" {"promptTokenCount" 5 "candidatesTokenCount" 10 "totalTokenCount" 15}}
                         "gemini-2.5-flash")
        message (message-of c)]
    (is (map? c))
    (is (= "The answer is 42" (get message "content")))
    (is (= "Let me think..." (get message "reasoning_content")))))

(deftest handles-max-tokens-finish-reason
  (let [c (completion-of {"candidates" [{"content" {"role" "model" "parts" [{"text" "Partial response..."}]}
                                         "finishReason" "MAX_TOKENS"}]}
                         "gemini-3.1-pro")]
    (is (= "length" (get (choice-of c) "finish_reason")))))

(deftest handles-empty-response-gracefully
  (let [c (completion-of {} "gemini-2.5-pro")]
    (is (map? c))
    (is (= "" (get (message-of c) "content")))
    (is (= "stop" (get (choice-of c) "finish_reason")))))

(deftest handles-null-undefined-response-gracefully
  (is (= "" (get (message-of (->data (s/gemini-response-to-chat-completion-js nil "gemini-2.5-pro"))) "content")))
  (let [c (->data (s/gemini-response-to-chat-completion-js js/undefined "gemini-2.5-pro"))]
    (is (map? c))
    (is (= "" (get (message-of c) "content")))))

(deftest handles-response-without-usage-metadata
  (let [c (completion-of {"candidates" [{"content" {"parts" [{"text" "No usage data"}]} "finishReason" "STOP"}]}
                         "gemini-2.5-pro")]
    (is (map? c))
    (is (= "No usage data" (get (message-of c) "content")))
    (is (not (usage-of c)))))

(deftest handles-multiple-text-parts-joined-with-newlines
  (let [c (completion-of {"candidates" [{"content" {"parts" [{"text" "First paragraph"} {"text" "Second paragraph"}]}
                                         "finishReason" "STOP"}]}
                         "gemini-2.5-pro")]
    (is (= "First paragraph\nSecond paragraph" (get (message-of c) "content")))))

(deftest transforms-gemini-function-call-to-openai-tool-calls-shape
  (let [c (completion-of {"candidates" [{"content" {"parts" [{"functionCall" {"name" "get_weather"
                                                                              "args" {"location" "San Francisco" "unit" "celsius"}}}]}
                                         "finishReason" "STOP"}]}
                         "gemini-2.5-pro")
        message (message-of c)
        tool-calls (get message "tool_calls")
        tool-call (first tool-calls)]
    (is (map? c))
    (is (contains? message "content"))
    (is (nil? (get message "content")) "OpenAI expects content: null when there are tool_calls")
    (is (vector? tool-calls) "tool_calls should be an array")
    (is (= 1 (count tool-calls)))
    (is (string? (get tool-call "id")) "tool_call id should be a string")
    (is (str/starts-with? (get tool-call "id") "call_gemini_") "id should have gemini prefix")
    (is (= "function" (get tool-call "type")))
    (is (= "get_weather" (get-in tool-call ["function" "name"])))
    (is (= "{\"location\":\"San Francisco\",\"unit\":\"celsius\"}" (get-in tool-call ["function" "arguments"])))))

(deftest transforms-multiple-gemini-function-calls-to-openai-tool-calls
  (let [c (completion-of {"candidates" [{"content" {"parts" [{"functionCall" {"name" "get_weather" "args" {"location" "San Francisco"}}}
                                                             {"functionCall" {"name" "get_time" "args" {"timezone" "PST"}}}]}
                                         "finishReason" "STOP"}]}
                         "gemini-2.5-pro")
        tool-calls (get (message-of c) "tool_calls")]
    (is (= 2 (count tool-calls)))
    (is (= "get_weather" (get-in tool-calls [0 "function" "name"])))
    (is (= "get_time" (get-in tool-calls [1 "function" "name"])))
    (is (not= (get-in tool-calls [0 "id"]) (get-in tool-calls [1 "id"])) "each tool call should have a unique id")))

(deftest handles-mixed-text-and-function-call-in-response
  (let [c (completion-of {"candidates" [{"content" {"parts" [{"text" "I'll check that for you"}
                                                             {"functionCall" {"name" "get_weather" "args" {"location" "San Francisco"}}}]}
                                         "finishReason" "STOP"}]}
                         "gemini-2.5-pro")
        message (message-of c)]
    (is (= "I'll check that for you" (get message "content")))
    (is (vector? (get message "tool_calls")))
    (is (= 1 (count (get message "tool_calls"))))))

(deftest content-is-always-a-string-when-no-tool-calls
  (let [message (message-of (completion-of {"candidates" [{"content" {"parts" []} "finishReason" "STOP"}]} "gemini-2.5-pro"))]
    (is (contains? message "content"))
    (is (= "" (get message "content")))
    (is (some? (get message "content")))))

(deftest content-is-null-when-there-are-tool-calls-but-no-text
  (let [message (message-of (completion-of {"candidates" [{"content" {"parts" [{"functionCall" {"name" "get_weather" "args" {"location" "SF"}}}]}
                                                           "finishReason" "STOP"}]}
                                           "gemini-2.5-pro"))]
    (is (contains? message "content"))
    (is (nil? (get message "content")))
    (is (vector? (get message "tool_calls")))))

;; ---- reasoning effort normalization -----------------------------------------

(deftest normalizes-various-effort-levels
  (doseq [[in out] [["none" "none"] ["disabled" "none"] ["off" "none"] ["minimal" "minimal"] ["low" "low"]
                    ["medium" "medium"] ["normal" "medium"] ["auto" "medium"] ["high" "high"]
                    ["xhigh" "xhigh"] ["max" "xhigh"] ["very_high" "xhigh"]]]
    (is (= out (s/normalize-gemini-reasoning-effort-js in)) in)))

(deftest returns-undefined-for-unknown-effort-values
  (is (undefined? (s/normalize-gemini-reasoning-effort-js "unknown")))
  (is (undefined? (s/normalize-gemini-reasoning-effort-js "")))
  (is (undefined? (s/normalize-gemini-reasoning-effort-js nil))))

;; ---- end to end -------------------------------------------------------------

(deftest strategy-builds-correct-payload
  (let [payload (build-payload {"model" "gemini-2.5-pro"
                                "messages" [{"role" "system" "content" "Be helpful"} {"role" "user" "content" "Hello"}]
                                "temperature" 0.7 "max_tokens" 100})]
    (is (map? payload))
    (is (vector? (get payload "contents")))
    (is (= 1 (count (get payload "contents"))))
    (is (= "user" (get-in payload ["contents" 0 "role"])))
    (is (= "Hello" (get-in payload ["contents" 0 "parts" 0 "text"])))
    (is (map? (get payload "systemInstruction")))
    (is (= "Be helpful" (get-in payload ["systemInstruction" "parts" 0 "text"])))
    (is (map? (get payload "generationConfig")))
    (is (= 0.7 (get-in payload ["generationConfig" "temperature"])))
    (is (= 100 (get-in payload ["generationConfig" "maxOutputTokens"])))))

(deftest strategy-matches-gemini-provider
  (let [^js strategy (strategies/strategy-for-id-js "gemini-chat")]
    (is (true? (.matches strategy #js {"routeProviderId" "gemini" "responsesPassthrough" false "imagesPassthrough" false})))
    (is (false? (.matches strategy #js {"routeProviderId" "openai" "responsesPassthrough" false "imagesPassthrough" false})))))

(deftest response-transformation-produces-valid-downstream-shape
  ;; the critical test: the output is exactly what an OpenAI client expects
  (let [c (completion-of {"candidates" [{"content" {"parts" [{"text" "The answer is 42"}]} "finishReason" "STOP"}]
                          "usageMetadata" {"promptTokenCount" 10 "candidatesTokenCount" 5 "totalTokenCount" 15}}
                         "gemma4:31b")
        choice (choice-of c)
        message (message-of c)
        usage (usage-of c)]
    (is (get c "id") "Missing id")
    (is (= "chat.completion" (get c "object")))
    (is (number? (get c "created")) "created should be a number")
    (is (= "gemma4:31b" (get c "model")))
    (is (= 1 (count (get c "choices"))))
    (is (= 0 (get choice "index")))
    (is (map? (get choice "message")) "message should be an object")
    (is (= "assistant" (get message "role")))
    (is (string? (get message "content")) "content should be a string")
    (is (= "The answer is 42" (get message "content")))
    (is (not (get message "reasoning_content")) "should not have reasoning_content when no reasoning")
    (is (= "stop" (get choice "finish_reason")))
    (is (some? usage) "usage should be an object")
    (is (= 10 (get usage "prompt_tokens")))
    (is (= 5 (get usage "completion_tokens")))
    (is (= 15 (get usage "total_tokens")))))
