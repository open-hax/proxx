(ns proxx.compat.ollama-native-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.compat.ollama-native :as n]))

(deftest chat-request
  (let [out (n/native-chat->openai-request
             {"model" "m" "stream" true "temperature" 0.5 "max_tokens" "64" "think" " TRUE "
              "messages" [{"role" "tool" "content" nil "tool_call_id" "t"} "skip" {"role" "weird" "content" "x"}]
              "options" {"num_ctx" 4096}})]
    (is (= ["model" "messages" "stream" "open_hax"] (keys out)))
    (is (= [{"role" "tool" "content" nil "tool_call_id" "t"} {"role" "user" "content" "x"}]
           (map #(into {} %) (get out "messages")) ) "wrong-typed message entries are dropped, null content kept")
    (is (= {"num_ctx" 4096 "temperature" 0.5 "num_predict" 64 "think" true}
           (into {} (get-in out ["open_hax" "ollama"]))))
    (is (= ["num_ctx" "temperature" "num_predict" "think"] (keys (get-in out ["open_hax" "ollama"]))) "explicit options first, then derived")))

(deftest explicit-options-win
  (is (= {"temperature" 1}
         (into {} (get-in (n/native-chat->openai-request {"temperature" 0.2 "options" {"temperature" 1}}) ["open_hax" "ollama"])))))

(deftest generate-request
  (let [out (n/native-generate->chat-request {"prompt" "hi" "system" "be brief" "stream" true})]
    (is (= [{"role" "system" "content" "be brief"} {"role" "user" "content" "hi"}] (get out "messages")))
    (is (= false (get out "stream")))))

(deftest completion-to-native
  (let [resp {"model" "m" "choices" [{"message" {"content" "hi" "reasoning" "why"} "finish_reason" "length"}]
              "usage" {"prompt_tokens" 3 "completion_tokens" 4}}
        chat (n/chat-completion->native-chat resp "T")
        gen (n/chat-completion->native-generate resp "T")]
    (is (= ["model" "created_at" "message" "done" "done_reason" "prompt_eval_count" "eval_count"] (keys chat)))
    (is (= {"role" "assistant" "content" "hi" "thinking" "why"} (into {} (get chat "message"))))
    (is (= 9 (count (keys gen))) "generate has nine fields in wire order, none null")
    (is (= ["model" "created_at" "response" "thinking" "done" "done_reason" "context" "prompt_eval_count" "eval_count"] (keys gen)))
    (testing "empty completion"
      (is (= {"model" "" "created_at" "T" "message" {"role" "assistant" "content" ""} "done" true "done_reason" "stop"
              "prompt_eval_count" 0 "eval_count" 0}
             (into {} (update (n/chat-completion->native-chat {} "T") "message" #(into {} %))))))))

(deftest embeddings
  (is (= {"model" "m" "input" ["a" "b"] "num_ctx" 512 "ollama_num_ctx" 512}
         (into {} (n/native-embed->openai-request {"model" "m" "prompt" ["a" 1 "b"] "ollama_num_ctx" "512"}))))
  (is (= {"model" "m" "input" "" "options" {"num_ctx" 100}}
         (into {} (n/native-embed->ollama-request {"model" "m" "input" 5} 100))))
  (is (= {"embedding" [1 2]} (n/openai-embeddings->native-embeddings {"data" [{"embedding" []} {"embedding" [1 "x" 2]}]})))
  (is (= [[1 2]] (get (n/openai-embeddings->native-embed {"data" [{"embedding" [1 2]} {"embedding" []} nil]}) "embeddings")))
  (let [out (n/native-embed-response->openai-embeddings {"embedding" [1 2]} "m")]
    (is (= [{"object" "embedding" "index" 0 "embedding" [1 2]}] (map #(into {} %) (get out "data"))))
    (is (= {"prompt_tokens" 0 "total_tokens" 0} (into {} (get out "usage"))))))

(deftest tags
  (let [tags (n/model-ids->native-tags ["a" "b"] "T" (let [i (atom 0)] #(str "d" (swap! i inc))))]
    (is (= ["d1" "d2"] (map #(get % "digest") (get tags "models"))))
    (is (= ["name" "model" "modified_at" "size" "digest" "details"] (keys (first (get tags "models")))))))
