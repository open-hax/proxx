(ns proxx.compat.responses-stream-test
  (:require [cljs.test :refer [deftest is testing]]
            [clojure.string :as str]
            [proxx.compat.responses.stream :as s]
            [proxx.json :as json]))

(def ^:private now 1700000123456)
(defn- thrown-message [f] (try (f) nil (catch :default e (ex-message e))))
(defn- ev [o] (str "data: " (if (string? o) o (json/write o)) "\n\n"))
(defn- evs [& os] (apply str (map ev os)))
(defn- sse-payloads [text] (s/payloads text))

;; ---------------------------------------------------------------------------
;; blocks and payloads
;; ---------------------------------------------------------------------------

(deftest block-parsing
  (is (= {"a" 1} (s/block->payload "event: x\ndata: {\"a\":1}")))
  (is (= {"a" 1} (s/block->payload "data: {\"a\":\ndata: 1}")) "data lines of one block join with newlines")
  (is (= {"a" 1} (s/block->payload "  data:{\"a\":1}  ")) "lines are trimmed")
  (is (nil? (s/block->payload "data: [DONE]")))
  (is (nil? (s/block->payload "data: not json")))
  (is (nil? (s/block->payload "data: [1]")))
  (is (nil? (s/block->payload ": comment")))
  (is (= [{"a" 1} {"b" 2}] (s/payloads (str "data: {\"a\":1}\r\n\r\ndata: nope\n\n" "data: {\"b\":2}")))
      "CRLF separators, malformed blocks skipped, trailing block without separator kept")
  (is (= [["a" "b"] "c"] (let [[blocks tail] (s/split-blocks "a\n\nb\r\n\r\nc")] [(vec blocks) tail])))
  (is (= [[] "partial"] (let [[blocks tail] (s/split-blocks "partial")] [(vec blocks) tail]))))

(deftest reasoning-delta-text
  (is (= "d" (s/reasoning-delta-text {"delta" "d"})))
  (is (= "t" (s/reasoning-delta-text {"delta" {"text" "t" "reasoning" "r"}})))
  (is (= "s" (s/reasoning-delta-text {"delta" {"summary" "s"}})))
  (is (= "" (s/reasoning-delta-text {"delta" {}})))
  (is (= "x" (s/reasoning-delta-text {"text" "x"})))
  (is (= "r" (s/reasoning-delta-text {"reasoning" "r"})))
  (is (= "" (s/reasoning-delta-text {}))))

(deftest error-and-terminal-extraction
  (is (= {"message" "boom"} (s/event-stream->error-payload (evs {"type" "error" "error" {"message" "boom"}}))))
  (is (= {"message" "f"} (s/event-stream->error-payload (evs {"type" "response.failed" "response" {"error" {"message" "f"}}}))))
  (is (nil? (s/event-stream->error-payload (evs {"type" "error" "error" "str"} {"type" "response.failed" "response" {}}))))
  (is (= {"message" "second"}
         (s/event-stream->error-payload (evs {"type" "error" "error" "str"} {"type" "error" "error" {"message" "second"}}))))
  (is (= {"id" "b"} (s/extract-terminal-response
                     (evs {"type" "response.completed" "response" {"id" "a"}}
                          {"type" "response.incomplete" "response" {"id" "b"}}
                          {"type" "response.completed"}))))
  (is (nil? (s/extract-terminal-response (evs {"type" "response.created" "response" {"id" "a"}})))))

;; ---------------------------------------------------------------------------
;; responses stream -> chat completion
;; ---------------------------------------------------------------------------

(defn- completion [text] (s/event-stream->chat-completion text "fb" now))

(deftest responses-stream->chat-completion
  (testing "a terminal response wins; deltas only fill gaps"
    (let [c (completion (evs {"type" "response.output_text.delta" "delta" "Hel"}
                             {"type" "response.output_text.delta" "delta" "lo"}
                             {"type" "response.reasoning.delta" "delta" "th"}
                             {"type" "response.completed" "response" {"id" "r1" "output" []}}))]
      (is (= "Hello" (get-in c ["choices" 0 "message" "content"])))
      (is (= "th" (get-in c ["choices" 0 "message" "reasoning_content"])))
      (is (= "r1" (get c "id"))))
    (let [c (completion (evs {"type" "response.output_text.delta" "delta" "ignored"}
                             {"type" "response.completed"
                              "response" {"output" [{"type" "message" "role" "assistant"
                                                     "content" [{"type" "output_text" "text" "FULL"}]}]}}))]
      (is (= "FULL" (get-in c ["choices" 0 "message" "content"])))))
  (testing "tool calls leave content null, so streamed text still fills it"
    (let [c (completion (evs {"type" "response.output_text.delta" "delta" "pre"}
                             {"type" "response.incomplete"
                              "response" {"output" [{"type" "function_call" "call_id" "c" "name" "f" "arguments" "{}"}]}}))]
      (is (= "pre" (get-in c ["choices" 0 "message" "content"])))
      (is (= "tool_calls" (get-in c ["choices" 0 "finish_reason"])))))
  (testing "without a terminal response, deltas synthesize one under the latest response metadata"
    (let [c (completion (evs {"type" "response.created" "response" {"id" "r9" "model" "mm" "created_at" 7}}
                             {"type" "response.reasoning_text.delta" "delta" {"text" "in"}}
                             {"type" "response.output_text.delta" "delta" "out"}))]
      (is (= {"id" "r9" "model" "mm" "created" 7} (select-keys c ["id" "model" "created"])))
      (is (= {"role" "assistant" "content" "out" "reasoning_content" "in"} (get-in c ["choices" 0 "message"])))))
  (testing "nothing usable is an error"
    (doseq [bad ["" (evs {"type" "response.created" "response" {}}) "data: [DONE]\n\n"]]
      (is (= "Invalid upstream responses event-stream payload" (thrown-message #(completion bad))) bad))))

;; ---------------------------------------------------------------------------
;; chat chunks -> completion / responses
;; ---------------------------------------------------------------------------

(def ^:private chunks
  (evs {"id" "c1" "created" 5 "model" "mm" "choices" [{"delta" {"role" "assistant"}}]}
       {"choices" [{"delta" {"content" "Hel"}}]}
       {"choices" [{"delta" {"content" "lo" "reasoning_content" "th"}}]}
       {"choices" [{"delta" {"tool_calls" [{"index" 1 "id" "tc1" "function" {"name" "g"}}]}}]}
       {"choices" [{"delta" {"tool_calls" [{"index" 0 "id" "tc0" "function" {"name" "fn" "arguments" "{\"a\""}}]}}]}
       {"choices" [{"delta" {"tool_calls" [{"index" 0 "id" "ignored" "function" {"arguments" ":1}"}}]}}]}
       {"choices" [{"delta" {} "finish_reason" "tool_calls"}] "usage" {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3}}))

(deftest chunks->completion
  (is (= {"id" "c1" "object" "chat.completion" "created" 5 "model" "mm"
          "usage" {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3}
          "choices" [{"index" 0 "finish_reason" "tool_calls"
                      "message" {"role" "assistant" "content" "Hello" "reasoning_content" "th"
                                 "tool_calls" [{"id" "tc0" "type" "function" "function" {"name" "fn" "arguments" "{\"a\":1}"}}
                                               {"id" "tc1" "type" "function" "function" {"name" "g" "arguments" ""}}]}}]}
         (s/chunks->chat-completion (sse-payloads chunks) "fb" now))
      "fragments concatenate per index, slots sort by index, the first id sticks")
  (let [c (s/chunks->chat-completion [{"choices" [{"delta" {"tool_calls" [{"function" {"name" "a"}} nil {"function" {"name" "b"}}]}}]}] "fb" now)]
    (is (= ["call_0" "call_2"] (map #(get % "id") (get-in c ["choices" 0 "message" "tool_calls"])))
        "slots without an index use their position")
    (is (nil? (get-in c ["choices" 0 "message" "content"]))))
  (is (= {"id" "chatcmpl_1700000123456" "object" "chat.completion" "created" 1700000123 "model" "fb"
          "choices" [{"index" 0 "message" {"role" "assistant" "content" ""} "finish_reason" "stop"}]}
         (s/chunks->chat-completion [{"choices" []}] "fb" now))))

(deftest chat-stream->responses-response
  (is (= "Invalid upstream chat completion event-stream payload"
         (thrown-message #(s/chat-event-stream->responses-response "data: [DONE]\n\n" "fb" now))))
  (let [r (s/chat-event-stream->responses-response chunks "fb" now)]
    (is (= ["reasoning" "message" "function_call" "function_call"] (map #(get % "type") (get r "output"))))
    (is (= "c1" (get r "id")))))

(deftest chat-stream->responses-event-stream
  (let [text (s/chat-event-stream->responses-event-stream chunks "fb" now)
        events (->> (str/split text #"\n\n") (remove str/blank?)
                    (mapv (fn [block] (let [[e d] (str/split block #"\n" 2)]
                                        [(subs e 7) (json/parse (subs d 6))]))))
        types (mapv first events)]
    (is (= "response.created" (first types)))
    (is (= "response.completed" (peek types)))
    (is (every? (fn [[t body]] (= t (get body "type"))) events) "every event names itself in event: and data.type")
    (is (= ["response.created"
            "response.output_item.added" "response.output_text.delta"
            "response.output_item.added" "response.reasoning.delta" "response.output_text.delta"]
           (subvec types 0 6))
        "created; each item is announced once, just before its first delta; reasoning precedes text within a chunk")
    (is (some #{"response.function_call_arguments.delta"} types))
    (let [added (filter #(= "response.output_item.added" (first %)) events)
          ids (map #(get-in % [1 "item" "id"]) added)]
      (is (= ["msg_c1" "rs_c1" "fc_c1_1" "fc_c1_0"] ids)
          "each item is announced exactly once, in first-use order; function items reuse their response ids"))
    (is (= "in_progress" (get-in (second (first events)) ["response" "status"])))
    (is (= "completed" (get-in (second (peek events)) ["response" "status"]))))
  (is (some? (thrown-message #(s/chat-event-stream->responses-event-stream "" "fb" now)))))

;; ---------------------------------------------------------------------------
;; chat completion -> sse
;; ---------------------------------------------------------------------------

(defn- data-chunks [text] (->> (str/split text #"\n\n") (remove str/blank?) (remove #{"data: [DONE]"})
                               (mapv #(json/parse (subs % 6)))))

(deftest completion->sse
  (let [text (s/chat-completion->sse {"id" "c" "created" 9 "model" "m"
                                      "choices" [{"message" {"content" "hi" "reasoning" "r"
                                                             "tool_calls" [{"id" "t" "function" {"name" "f"}} nil {"function" {"name" ""}}]}
                                                  "finish_reason" "tool_calls"}]} now)
        [first-chunk last-chunk] (data-chunks text)]
    (is (str/ends-with? text "data: [DONE]\n\n"))
    (is (= {"role" "assistant" "reasoning_content" "r" "content" "hi"
            "tool_calls" [{"index" 0 "id" "t" "type" "function" "function" {"name" "f" "arguments" "{}"}}]}
           (get-in first-chunk ["choices" 0 "delta"])))
    (is (nil? (get-in first-chunk ["choices" 0 "finish_reason"])))
    (is (= {} (get-in last-chunk ["choices" 0 "delta"])))
    (is (= "tool_calls" (get-in last-chunk ["choices" 0 "finish_reason"]))))
  (testing "content shapes"
    (let [delta (fn [message] (get-in (first (data-chunks (s/chat-completion->sse {"choices" [{"message" message}]} now))) ["choices" 0 "delta"]))]
      (is (= {"role" "assistant" "content" ""} (delta {})))
      (is (= {"role" "assistant" "content" ""} (delta {"content" nil})))
      (is (= {"role" "assistant" "content" ["x"]} (delta {"content" ["x"]})))
      (is (= {"role" "assistant"} (delta {"content" []})))
      (is (= {"role" "assistant" "content" {"a" 1}} (delta {"content" {"a" 1}})))
      (is (= {"role" "assistant" "tool_calls" [{"index" 0 "id" "call_0" "type" "function" "function" {"name" "f" "arguments" "{}"}}]}
             (delta {"content" nil "tool_calls" [{"function" {"name" "f"}}]})))
      (is (= "" (get (delta {"content" "" "tool_calls" [{"function" {"name" "f"}}]}) "content")))))
  (let [[c] (data-chunks (s/chat-completion->sse {} now))]
    (is (= ["chatcmpl_1700000123456" 1700000123 "unknown"] ((juxt #(get % "id") #(get % "created") #(get % "model")) c)))))

;; ---------------------------------------------------------------------------
;; interleaved plan
;; ---------------------------------------------------------------------------

(deftest word-chunking
  (is (= ["a b c d" " e f"] (s/chunk-text-by-words "a b c d e f" 4)) "whitespace rides with the following word")
  (is (= ["a b"] (s/chunk-text-by-words "a b" 4)))
  (is (= ["  a b c d" " e"] (s/chunk-text-by-words "  a b c d e" 4)) "leading whitespace rides with the first word")
  (is (= [] (s/chunk-text-by-words "" 4)))
  (is (= "one  two\nthree" (apply str (s/chunk-text-by-words "one  two\nthree" 2))) "chunking never loses text"))

(deftest interleaved-plan
  (let [plan (s/interleaved-chunks
              {"id" "r1" "created_at" 5 "model" "m"
               "output" [{"type" "reasoning" "text" "think hard"}
                         {"type" "message" "role" "assistant" "reasoning" "mr"
                          "content" [{"type" "output_text" "text" "one two three four five"}
                                     {"type" "thinking" "text" "t2"}]}
                         {"type" "function_call" "name" "f" "arguments" {"a" 1}}
                         {"type" "function_call" "name" "g" "call_id" "cg"}
                         {"type" "function_call" "name" ""}]}
              "fb" now)
        decoded (mapv (fn [{:keys [data pace?]}] [pace? (when-not (str/includes? data "[DONE]") (json/parse (subs data 6 (- (count data) 2))))]) plan)
        deltas (mapv (fn [[_ c]] (when c (get-in c ["choices" 0 "delta"]))) decoded)]
    (is (= {"role" "assistant" "reasoning_content" "think hard"} (first deltas)) "role rides on the first chunk only")
    (is (= [{"reasoning_content" "mr"} {"content" "one two three four"} {"content" " five"} {"reasoning_content" "t2"}]
           (subvec deltas 1 5)))
    (is (= {"tool_calls" [{"index" 0 "id" "call_0" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}]} (nth deltas 5)))
    (is (= {"tool_calls" [{"index" 1 "id" "cg" "type" "function" "function" {"name" "g" "arguments" "{}"}}]} (nth deltas 6)))
    (is (= {} (nth deltas 7)))
    (is (= "tool_calls" (get-in (second (nth decoded 7)) ["choices" 0 "finish_reason"])))
    (is (= "data: [DONE]\n\n" (:data (peek plan))))
    (is (= [true true true true true true true false false] (mapv first decoded))
        "content and tool-call chunks are paceable; the closing chunks are not")
    (is (every? #(= ["r1" 5 "m"] ((juxt (fn [c] (get c "id")) (fn [c] (get c "created")) (fn [c] (get c "model"))) (second %)))
                (butlast decoded))))
  (testing "an empty response still says something"
    (let [plan (s/interleaved-chunks {} "fb" now)
          [a b] (data-chunks (apply str (map :data plan)))]
      (is (= {"role" "assistant" "content" ""} (get-in a ["choices" 0 "delta"])))
      (is (= "stop" (get-in b ["choices" 0 "finish_reason"])))
      (is (= "fb" (get a "model")))
      (is (= "chatcmpl_1700000123456" (get a "id"))))))

;; ---------------------------------------------------------------------------
;; incremental translator
;; ---------------------------------------------------------------------------

(defn- run-translator
  "Feed events, collect every chunk the translator queued (chunks are decoded)."
  [events]
  (let [st (s/translator-finish (reduce s/translator-step (s/translator-init "fb" now) events))]
    {:state st
     :chunks (->> (:out st) (remove #{"data: [DONE]\n\n"}) (mapv #(json/parse (subs % 6))))
     :done? (= "data: [DONE]\n\n" (peek (:out st)))}))

(defn- deltas [{:keys [chunks]}] (mapv #(get-in % ["choices" 0 "delta"]) chunks))

(deftest translator-text-and-reasoning
  (let [out (run-translator [{"type" "response.created" "response" {"id" "rid" "model" "mx" "created_at" 9}}
                             {"type" "response.reasoning_summary_text.delta" "delta" {"text" "th"}}
                             {"type" "response.output_text.delta" "delta" "hi"}
                             {"type" "response.output_text.delta" "delta" ""}
                             {"type" "response.completed"
                              "response" {"model" "final" "usage" {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3}}}])]
    (is (= [{"role" "assistant" "reasoning_content" "th"} {"content" "hi"} {} ] (deltas out)))
    (is (= [["rid" 9 "mx"] ["rid" 9 "mx"] ["rid" 9 "final"]]
           (mapv (fn [c] ((juxt #(get % "id") #(get % "created") #(get % "model")) c)) (:chunks out)))
        "the terminal model applies to the closing chunk only")
    (is (= {"prompt_tokens" 1 "completion_tokens" 2 "total_tokens" 3} (get (peek (:chunks out)) "usage")))
    (is (= "stop" (get-in (peek (:chunks out)) ["choices" 0 "finish_reason"])))
    (is (:done? out))
    (is (= {"model" "final" "usage" {"input_tokens" 1 "output_tokens" 2 "total_tokens" 3}} (:terminal (:state out))))))

(deftest translator-function-calls
  (let [out (run-translator [{"type" "response.output_item.added" "item" {"type" "function_call" "id" "fc1" "call_id" "c1" "name" "f"}}
                             {"type" "response.function_call_arguments.delta" "item_id" "fc1" "delta" "{\"a\""}
                             {"type" "response.function_call_arguments.delta" "call_id" "c1" "delta" ":1}"}
                             {"type" "response.function_call_arguments.delta" "item_id" "c1" "delta" "!"}
                             {"type" "response.function_call_arguments.delta" "call_id" "late" "name" "g" "delta" "zz"}
                             {"type" "response.function_call_arguments.delta" "call_id" "late2"}
                             {"type" "response.function_call_arguments.delta" "delta" "orphan"}
                             {"type" "response.function_call_arguments.delta" "item_id" "nope" "delta" "q"}
                             {"type" "response.function_call_arguments.delta" "item_id" "fc1" "delta" ""}
                             {"type" "response.output_item.added" "item" {"type" "message"}}
                             {"type" "response.output_item.added" "item" {"type" "function_call" "name" "no-call-id"}}])]
    (is (= [{"role" "assistant" "tool_calls" [{"index" 0 "id" "c1" "type" "function" "function" {"name" "f" "arguments" ""}}]}
            {"tool_calls" [{"index" 0 "function" {"arguments" "{\"a\""}}]}
            {"tool_calls" [{"index" 0 "function" {"arguments" ":1}"}}]}
            {"tool_calls" [{"index" 0 "function" {"arguments" "!"}}]}
            {"tool_calls" [{"index" 1 "id" "late" "type" "function" "function" {"name" "g" "arguments" "zz"}}]}
            {"tool_calls" [{"index" 2 "id" "late2" "type" "function" "function" {"name" "" "arguments" ""}}]}
            {}]
           (deltas out)))
    (is (= "tool_calls" (get-in (peek (:chunks out)) ["choices" 0 "finish_reason"])))))

(deftest translator-errors-and-closing
  (is (= {"message" "boom"} (:error (:state (run-translator [{"type" "error" "error" {"message" "boom"}}])))))
  (is (= {"type" "error" "message" "flat"} (:error (:state (run-translator [{"type" "error" "message" "flat"}])))))
  (is (= {"message" "f"} (:error (:state (run-translator [{"type" "response.failed" "response" {"error" {"message" "f"}}}])))))
  (is (nil? (:error (:state (run-translator [{"type" "response.failed" "response" {}}])))))
  (testing "a silent stream still yields a role chunk, then stop"
    (let [out (run-translator [{"type" 5} {"foo" 1}])]
      (is (= [{"role" "assistant" "content" ""} {}] (deltas out)))
      (is (= [nil "stop"] (mapv #(get-in % ["choices" 0 "finish_reason"]) (:chunks out))))
      (is (= ["chatcmpl_1700000123456" 1700000123 "fb"] ((juxt #(get % "id") #(get % "created") #(get % "model")) (first (:chunks out)))))))
  (testing "usage needs all three counts; otherwise a plain finish chunk"
    (let [out (run-translator [{"type" "response.completed" "response" {"usage" {"input_tokens" 1 "output_tokens" 2}}}])]
      (is (not (contains? (peek (:chunks out)) "usage")))))
  (testing "created_at of zero does not overwrite"
    (is (= 1700000123 (get (first (:chunks (run-translator [{"type" "response.created" "response" {"created_at" 0}}]))) "created")))))
