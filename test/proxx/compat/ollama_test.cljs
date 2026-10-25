(ns proxx.compat.ollama-test
  (:require [cljs.test :refer [deftest is testing async]]
            [proxx.compat.ollama :as o]
            [proxx.compat.reasoning :as r]
            [proxx.runtime.ollama :as edge]))

(def prefixes ["ollama/" "ollama:"])
(defn- req [body] (o/chat-request->ollama-request body prefixes))
(defn- thrown [f] (try (f) nil (catch :default e (ex-message e))))

(deftest reasoning-trace-decision
  (is (r/wants-reasoning-trace? {"include" ["reasoning.encrypted_content"] "thinking" {"type" "disabled"}}))
  (is (r/wants-reasoning-trace? {"thinking" {"type" "enabled"} "reasoning_effort" "off"}))
  (is (not (r/wants-reasoning-trace? {"thinking" {"type" "disabled"} "reasoning_effort" "high"})))
  (is (not (r/wants-reasoning-trace? {"reasoning_effort" "OFF"})))
  (is (r/wants-reasoning-trace? {"reasoningEffort" "low"}))
  (is (r/wants-reasoning-trace? {"reasoning" {}}) "a bare reasoning object counts")
  (is (r/wants-reasoning-trace? {"reasoning" {"effort" ""}}) "an empty effort is no effort")
  (is (not (r/wants-reasoning-trace? {})))
  (is (not (r/wants-reasoning-trace? {"reasoning" [1]})) "intentional: arrays are not reasoning objects"))

(deftest model-and-prefixes
  (is (o/should-use-ollama-upstream? "OLLAMA/gemma" prefixes))
  (is (not (o/should-use-ollama-upstream? "gemma" prefixes)))
  (is (not (o/should-use-ollama-upstream? "gemma" [""])))
  (is (not (o/should-use-ollama-upstream? nil prefixes)))
  (is (= "gemma4:31b" (get (req {"model" "ollama/gemma4:31b"}) "model")))
  (is (= "gemma4:31b" (get (req {"model" "Ollama:  gemma4:31b "}) "model")))
  (is (= "ollama/" (get (req {"model" "ollama/"}) "model")) "stripping to nothing keeps the whole name")
  (is (= "bare" (get (req {"model" "bare"}) "model")))
  (is (= "Ollama routing requires a non-empty model name" (thrown #(req {}))))
  (is (= "Ollama routing requires a non-empty model name" (thrown #(req {"model" 5}))) "a non-string model is an empty one"))

(deftest messages
  (is (= [{"role" "system" "content" "s"} {"role" "user" "content" "t"} {"role" "user" "content" "result"}
          {"role" "assistant" "content" ""}]
         (get (req {"model" "m" "messages" [{"role" "system" "content" "s"}
                                             {"role" "user" "content" [{"type" "input_text" "text" "t"} {"type" "image_url"}]}
                                             {"role" "tool" "content" "result"}
                                             {"role" "user" "content" ""}
                                             {"role" "assistant" "content" nil}
                                             "junk"]}) "messages"))
      "empty non-assistant turns drop; tool becomes user")
  (is (= [{"role" "user" "content" "{\"a\":1}"}] (get (req {"model" "m" "messages" [{"role" "dev" "content" {"a" 1}}]}) "messages"))))

(deftest think-and-reasoning
  (is (= {"think" true "reasoning_effort" "max"}
         (select-keys (req {"model" "m" "reasoning_effort" "max" "include" ["reasoning.encrypted_content"]})
                      ["think" "reasoning_effort"])))
  (is (false? (get (req {"model" "m" "think" "FALSE" "reasoning_effort" "high"}) "think")) "explicit think wins")
  (is (true? (get (req {"model" "m" "open_hax" {"ollama" {"think" true}} "think" false}) "think")) "control object outranks top level")
  (is (false? (get (req {"model" "m" "open_hax" {"ollama" {"think" false}} "think" true}) "think"))
      "a false control value is a value, not an absence")
  (is (true? (get (req {"model" "m" "provider_options" {"ollama" {"think" "true"}}}) "think")))
  (is (not (contains? (req {"model" "m"}) "think")))
  (is (not (contains? (req {"model" "m" "reasoning_effort" ""}) "reasoning_effort")))
  (is (= {"effort" "low" "x" 1} (get (req {"model" "m" "reasoning" {"effort" "low" "x" 1}}) "reasoning")))
  (is (not (contains? (req {"model" "m" "reasoning" {"x" 1}}) "reasoning")))
  (is (false? (get (req {"model" "m" "thinking" nil "reasoning" nil}) "think")) "present-but-null still asks the question; no reasoning object means false"))

(deftest options
  (is (= {"num_ctx" 4096 "num_predict" 99 "temperature" 0.5 "top_p" 0.9 "stop" ["a" "b"]}
         (get (req {"model" "m" "open_hax" {"ollama" {"num_ctx" "4096.7"}} "num_ctx" 1
                    "max_completion_tokens" 99.9 "max_tokens" 5 "temperature" 0.5 "top_p" 0.9
                    "stop" [" a " 5 "" "b"]}) "options")))
  (is (= 8192 (get-in (req {"model" "m" "ollama_num_ctx" 8192}) ["options" "num_ctx"])))
  (is (= 1 (get-in (req {"model" "m" "max_tokens" 0.2}) ["options" "num_predict"])))
  (is (= ["s"] (get-in (req {"model" "m" "stop" "s"}) ["options" "stop"])))
  (is (not (contains? (req {"model" "m" "stop" ["" " "]}) "options")))
  (is (not (contains? (req {"model" "m"}) "options")))
  (testing "invalid num_ctx is a hard error, from any spelling"
    (doseq [v [0 -1 "abc" "" true [1]]]
      (is (= "num_ctx must be a positive number" (thrown #(req {"model" "m" "num_ctx" v}))) (pr-str v)))
    (is (= "ollama_num_ctx must be a positive number" (thrown #(req {"model" "m" "ollama_num_ctx" 0}))))
    (is (true? (o/explicit-num-ctx? {"num_ctx" 1})))
    (is (false? (o/explicit-num-ctx? {})))))

(deftest tools-and-stream-flag
  (is (= [{"type" "function"}] (get (req {"model" "m" "tools" [{"type" "function"}]}) "tools")))
  (is (not (contains? (req {"model" "m" "tools" "x"}) "tools")))
  (is (true? (get (req {"model" "m" "stream" true}) "stream")))
  (is (false? (get (req {"model" "m" "stream" "true"}) "stream"))))

(def now 1700000123456)

(deftest response-translation
  (let [c (o/ollama->chat-completion
           {"model" "gemma" "created_at" "2025-01-01T00:00:00Z" "done_reason" "length"
            "message" {"content" "hi" "thinking" "hm"} "prompt_eval_count" 3 "eval_count" 4}
           "fb" now)]
    (is (= {"id" "chatcmpl_ollama_1700000123456" "object" "chat.completion" "created" 1735689600 "model" "gemma"
            "system_fingerprint" ""
            "choices" [{"index" 0 "finish_reason" "length"
                        "message" {"role" "assistant" "content" "hi" "reasoning_content" "hm"}}]
            "usage" {"prompt_tokens" 3 "completion_tokens" 4 "total_tokens" 7}}
           c)))
  (testing "tool calls win the finish reason; silent content is null; ids by position"
    (let [c (o/ollama->chat-completion
             {"created_at" "bad"
              "message" {"tool_calls" [{"function" {"name" "f" "arguments" {"a" 1}}} 5 {"name" "g" "arguments" "{}"} {"function" {}}]}}
             "fb" now)
          choice (get-in c ["choices" 0])]
      (is (= 1700000123 (get c "created")) "bad created_at falls back to the clock")
      (is (= "fb" (get c "model")))
      (is (= "tool_calls" (get choice "finish_reason")))
      (is (nil? (get-in choice ["message" "content"])))
      (is (= [{"id" "call_0" "type" "function" "function" {"name" "f" "arguments" "{\"a\":1}"}}
              {"id" "call_2" "type" "function" "function" {"name" "g" "arguments" "{}"}}]
             (get-in choice ["message" "tool_calls"])))))
  (is (= "Invalid Ollama /api/chat response payload" (thrown #(o/ollama->chat-completion nil "fb" now))))
  (is (= "Invalid Ollama /api/chat response payload" (thrown #(o/ollama->chat-completion [] "fb" now)))
      "intentional: an array is not a response object")
  (is (= "fb" (get (o/ollama->chat-completion {"model" ""} "fb" now) "model"))
      "intentional: an empty model name falls back instead of leaking")
  (is (= "t2" (get-in (o/ollama->chat-completion {"message" {"thinking" "" } "thinking" "t2"} "fb" now)
                      ["choices" 0 "message" "reasoning_content"]))
      "intentional: an empty message.thinking does not shadow a top-level thinking")
  (is (not (contains? (o/ollama->chat-completion {"prompt_eval_count" 1} "fb" now) "usage"))))

(deftest diff-appended-text
  (is (= "" (o/diff-appended-text "a" "")))
  (is (= "The" (o/diff-appended-text "" "The")))
  (is (= "" (o/diff-appended-text "The" "The")))
  (is (= " user" (o/diff-appended-text "The" "The user")))
  (is (= " The answer" (o/diff-appended-text "The" "The The answer")) "a legitimate repeat is kept")
  (is (= " answer" (o/diff-appended-text "The" "TheThe answer")) "duplicated first token collapses")
  (is (= "de" (o/diff-appended-text "abc" "bcde")) "non-prefix snapshots keep only the non-overlapping tail")
  (is (= "xyz" (o/diff-appended-text "abc" "xyz"))))

(defn- run-lines [lines]
  (reduce (fn [{:keys [state events]} line]
            (let [r (o/process-line state line {:stream-id "s" :fallback-model "fb" :now-ms now})]
              {:state (:state r) :events (into events (:events r))}))
          {:state o/initial-stream-state :events []}
          lines))

(deftest stream-line-machine
  (let [line (fn [m] (js/JSON.stringify (clj->js m)))
        {:keys [events state]} (run-lines ["" "not json" "[1]"
                                           (line {"message" {"thinking" "The"} "done" false})
                                           (line {"message" {"thinking" "The user"} "done" false})
                                           (line {"message" {"thinking" "The user wants"} "done" true "done_reason" "stop"})])
        payloads (map #(js->clj (js/JSON.parse (subs % 6))) (remove #{o/done-event} events))
        deltas (map #(get-in % ["choices" 0 "delta"]) payloads)]
    (is (= ["The" " user" " wants"] (keep #(get % "reasoning_content") deltas)))
    (is (= "stop" (get-in (last payloads) ["choices" 0 "finish_reason"])))
    (is (= o/done-event (last events)))
    (is (true? (:sent-done? state)))
    (is (= 5 (count events)) "three deltas, one finish chunk, one [DONE]")))

(deftest split-lines
  (is (= [["a" "b"] "c"] (let [[ls r] (o/split-lines "a\nb\nc")] [(vec ls) r])))
  (is (= [[] ""] (let [[ls r] (o/split-lines "")] [(vec ls) r])))
  (is (= [["a"] ""] (let [[ls r] (o/split-lines "a\n")] [(vec ls) r]))))

(deftest ^:async edge-stream-reads-bytes
  (let [encoder (js/TextEncoder.)
        ndjson (str (js/JSON.stringify #js {:message #js {:thinking "A"} :done false}) "\n"
                    (js/JSON.stringify #js {:message #js {:content "B"} :done false}) "\n"
                    (js/JSON.stringify #js {:message #js {:content "BC"} :done true}))
        body (js/ReadableStream. #js {:start (fn [c] (.enqueue c (.encode encoder ndjson)) (.close c))})
        out (atom [])]
    (await (edge/stream-ollama-ndjson-to-chat-completion-sse-js body "fb" #(swap! out conj %)))
    (is (= o/done-event (last @out)))
    (is (= 1 (count (filter #{o/done-event} @out))))
    (is (= 5 (count @out)) "reasoning A, content B, content C, finish chunk, [DONE]")))
