(ns proxx.runtime.sse-edge-test
  "Ported from src/tests/sse-usage.test.ts (12 tests) and
  src/tests/reasoning-stream-check.test.ts (12 tests). The TS shims forwarded to
  the strategy and runtime edges, which are driven directly. JSON is written with
  single quotes and widened by `j` (no payload contains an apostrophe)."
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.runtime :as runtime]
            [proxx.runtime.strategy :as s]))

(defn- j [text] (str/replace text "'" "\""))
(defn- lines [& ls] (str/join "" (map j ls)))

(defn- usage [stream mode model]
  (let [^js r (s/extract-usage-counts-from-sse-text-js stream mode model)]
    {:prompt (.-promptTokens r) :completion (.-completionTokens r) :total (.-totalTokens r) :cached (.-cachedPromptTokens r)}))

;; ---- sse-usage ------------------------------------------------------------

(deftest usage-from-openai-chat-completions-sse
  (let [stream (lines "data: {'id':'chatcmpl-abc','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[{'index':0,'delta':{'role':'assistant','content':'Hi'},'finish_reason':null}]}\n\n"
                      "data: {'id':'chatcmpl-abc','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}\n\n"
                      "data: [DONE]\n\n")
        r (usage stream "chat_completions" "gpt-4")]
    (is (= 10 (:prompt r)))
    (is (= 5 (:completion r)))
    (is (= 15 (:total r)))))

(deftest cached-prompt-tokens-from-openai-chat-completions-sse
  (let [stream (lines "data: {'id':'chatcmpl-abc','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[{'index':0,'delta':{'content':'Hi'},'finish_reason':null}]}\n\n"
                      "data: {'id':'chatcmpl-abc','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15,'prompt_tokens_details':{'cached_tokens':8}}}\n\n"
                      "data: [DONE]\n\n")
        r (usage stream "chat_completions" "gpt-4")]
    (is (= 10 (:prompt r)))
    (is (= 8 (:cached r)))))

(deftest usage-from-anthropic-messages-sse
  (let [stream (lines "event: message_start\ndata: {'type':'message_start','message':{'id':'msg_01','type':'message','role':'assistant','content':[],'model':'claude-3-opus-20240229','usage':{'input_tokens':25,'output_tokens':1}}}\n\n"
                      "event: content_block_start\ndata: {'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}\n\n"
                      "event: content_block_delta\ndata: {'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'Hello'}}\n\n"
                      "event: content_block_stop\ndata: {'type':'content_block_stop','index':0}\n\n"
                      "event: message_delta\ndata: {'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':12}}\n\n"
                      "event: message_stop\ndata: {'type':'message_stop'}\n\n")
        r (usage stream "messages" "claude-3-opus-20240229")]
    (is (= 25 (:prompt r)))
    (is (= 12 (:completion r)))
    (is (= 37 (:total r)))))

(deftest usage-from-openai-responses-sse
  (let [stream (lines "event: response.output_text.delta\ndata: {'type':'response.output_text.delta','delta':'Hi'}\n\n"
                      "event: response.completed\ndata: {'type':'response.completed','response':{'id':'resp_01','status':'completed','usage':{'input_tokens':20,'output_tokens':8,'total_tokens':28}}}\n\n")
        r (usage stream "responses" "gpt-4")]
    (is (= 20 (:prompt r)))
    (is (= 8 (:completion r)))
    (is (= 28 (:total r)))))

(deftest usage-from-openai-responses-sse-openai-responses-mode
  (let [stream (lines "event: response.output_text.delta\ndata: {'type':'response.output_text.delta','delta':'Hi'}\n\n"
                      "event: response.completed\ndata: {'type':'response.completed','response':{'id':'resp_01','status':'completed','usage':{'input_tokens':15,'output_tokens':3,'total_tokens':18}}}\n\n")
        r (usage stream "openai_responses" "gpt-4")]
    (is (= 15 (:prompt r)))
    (is (= 3 (:completion r)))
    (is (= 18 (:total r)))))

(deftest usage-from-ollama-streaming-response
  (let [stream (lines "{'model':'llama3.2','created_at':'2026-03-03T00:00:00.000Z','message':{'role':'assistant','content':'Hello'},'done':false}\n"
                      "{'model':'llama3.2','created_at':'2026-03-03T00:00:00.000Z','message':{'role':'assistant','content':'!'},'done':false}\n"
                      "{'model':'llama3.2','created_at':'2026-03-03T00:00:00.000Z','message':{'role':'assistant','content':''},'done':true,'done_reason':'stop','prompt_eval_count':12,'eval_count':6}\n")
        r (usage stream "ollama_chat" "llama3.2")]
    (is (= 12 (:prompt r)))
    (is (= 6 (:completion r)))
    (is (= 18 (:total r)))))

(deftest usage-from-local-ollama-streaming-response
  (let [stream (lines "{'model':'llama3.2','created_at':'2026-03-03T00:00:00.000Z','message':{'role':'assistant','content':'Hi'},'done':false}\n"
                      "{'model':'llama3.2','created_at':'2026-03-03T00:00:00.000Z','message':{'role':'assistant','content':''},'done':true,'done_reason':'stop','prompt_eval_count':8,'eval_count':4}\n")
        r (usage stream "local_ollama_chat" "llama3.2")]
    (is (= 8 (:prompt r)))
    (is (= 4 (:completion r)))
    (is (= 12 (:total r)))))

(defn- no-usage? [r] (and (undefined? (:prompt r)) (undefined? (:completion r)) (undefined? (:total r))))

(deftest empty-result-for-sse-stream-without-usage-data
  (is (no-usage? (usage (lines "data: {'id':'chatcmpl-abc','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[{'index':0,'delta':{'content':'Hi'},'finish_reason':null}]}\n\n"
                                "data: {'id':'chatcmpl-abc','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[{'index':0,'delta':{},'finish_reason':'stop'}]}\n\n"
                                "data: [DONE]\n\n")
                        "chat_completions" "gpt-4"))))

(deftest empty-result-for-empty-stream-text
  (is (no-usage? (usage "" "chat_completions" "gpt-4"))))

(deftest empty-result-for-malformed-sse-data
  (is (no-usage? (usage "not valid sse at all\ngarbage data\n\n" "chat_completions" "gpt-4"))))

(deftest anthropic-stream-with-only-message-start-usage
  (let [stream (lines "event: message_start\ndata: {'type':'message_start','message':{'id':'msg_01','type':'message','role':'assistant','content':[],'model':'claude-3','usage':{'input_tokens':10,'output_tokens':0}}}\n\n"
                      "event: message_stop\ndata: {'type':'message_stop'}\n\n")
        r (usage stream "messages" "claude-3")]
    (is (= 10 (:prompt r)))
    (is (= 0 (:completion r)))
    (is (= 10 (:total r)))))

(deftest usage-from-openai-chat-completions-mode-sse
  (let [stream (lines "data: {'id':'chatcmpl-xyz','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[{'index':0,'delta':{'content':'Hello'},'finish_reason':null}]}\n\n"
                      "data: {'id':'chatcmpl-xyz','object':'chat.completion.chunk','created':1700000000,'model':'gpt-4','choices':[],'usage':{'prompt_tokens':7,'completion_tokens':3,'total_tokens':10}}\n\n"
                      "data: [DONE]\n\n")
        r (usage stream "openai_chat_completions" "gpt-4")]
    (is (= 7 (:prompt r)))
    (is (= 3 (:completion r)))
    (is (= 10 (:total r)))))

;; ---- reasoning-stream-check ----------------------------------------------

(defn- payload [& ls] (str/join "\n" (map j ls)))
(defn- reasoning? [p] (runtime/stream-payload-has-reasoning-trace-js p))

(deftest reasoning-trace-detects-chat-completions-reasoning-content
  (is (reasoning? (payload "data: {'choices':[{'delta':{'reasoning_content':'thinking...'}}]}" "data: [DONE]"))))

(deftest reasoning-trace-detects-chat-completions-reasoning-field
  (is (reasoning? (payload "data: {'choices':[{'delta':{'reasoning':'thinking...'}}]}" "data: [DONE]"))))

(deftest reasoning-trace-detects-response-reasoning-delta
  (is (reasoning? (payload "data: {'type':'response.reasoning.delta','delta':'some reasoning'}" "data: [DONE]"))))

(deftest reasoning-trace-detects-response-reasoning-text-delta
  (is (reasoning? (payload "data: {'type':'response.reasoning_text.delta','delta':{'text':'some reasoning'}}" "data: [DONE]"))))

(deftest reasoning-trace-detects-response-reasoning-summary-delta
  (is (reasoning? (payload "data: {'type':'response.reasoning_summary.delta','delta':'summary text'}" "data: [DONE]"))))

(deftest reasoning-trace-detects-response-reasoning-summary-text-delta
  (is (reasoning? (payload "data: {'type':'response.reasoning_summary_text.delta','delta':{'text':'summary text'}}" "data: [DONE]"))))

(deftest reasoning-trace-detects-response-reasoning-summary-part-delta
  (is (reasoning? (payload "data: {'type':'response.reasoning_summary_part.delta','delta':{'text':'part text'}}" "data: [DONE]"))))

(deftest reasoning-trace-detects-output-item-added-reasoning-item
  (is (reasoning? (payload "data: {'type':'response.output_item.added','item':{'type':'reasoning','text':'chain'}}" "data: [DONE]"))))

(deftest reasoning-trace-false-for-empty-reasoning-delta
  (is (not (reasoning? (payload "data: {'type':'response.reasoning.delta','delta':''}" "data: [DONE]")))))

(deftest reasoning-trace-false-for-non-reasoning-responses-stream
  (is (not (reasoning? (payload "data: {'type':'response.output_text.delta','delta':'hello'}" "data: [DONE]")))))

(deftest reasoning-trace-false-for-empty-stream
  (is (not (reasoning? "")))
  (is (not (reasoning? "data: [DONE]"))))

(deftest chat-completion-has-reasoning-content-checks-both-fields
  (letfn [(has? [m] (runtime/chat-completion-has-reasoning-content-js (clj->js m)))]
    (is (has? {"choices" [{"delta" {"reasoning_content" "thinking"}}]}))
    (is (has? {"choices" [{"delta" {"reasoning" "thinking"}}]}))
    (is (has? {"reasoning_content" "top-level reasoning"}))
    (is (has? {"reasoning" "top-level reasoning"}))
    (is (not (has? {"choices" [{"delta" {"content" "no reasoning here"}}]})))))
