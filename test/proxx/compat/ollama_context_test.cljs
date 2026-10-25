(ns proxx.compat.ollama-context-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.compat.ollama-context :as c]
            [proxx.runtime.ollama-context :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")

(deftest text-estimates
  (is (= 0 (c/estimate-text-tokens "")))
  (is (= 1 (c/estimate-text-tokens "a")))
  (is (= 1 (c/estimate-text-tokens "abcd")))
  (is (= 2 (c/estimate-text-tokens "abcde"))))

(deftest message-estimates
  (testing "chat: role + content + 8, tool calls cost 64 each, images are a placeholder"
    (is (= (+ 1 1 8) (c/estimate-chat-tokens [{"role" "user" "content" "hi"}])))
    (is (= (+ 1 3 8 128) (c/estimate-chat-tokens [{"role" "user" "tool_calls" [1 2]
                                                    "content" [{"type" "image_url"} {"type" "text" "text" "x"} "y" 5 nil]}])))
    (is (= 0 (c/estimate-chat-tokens "nope")))
    (is (= 9 (c/estimate-chat-tokens [nil 5 {"content" ""}])) "non-maps cost nothing; a missing role is `user`"))
  (testing "native: string content only, 2048 per image"
    (is (= (+ 1 1 8 2048 64) (c/estimate-native-chat-tokens [{"role" "user" "content" "hi" "images" ["b64"] "tool_calls" [1]}])))
    (is (= 9 (c/estimate-native-chat-tokens [{"content" ["not" "a" "string"]}]))))
  (testing "embeddings"
    (is (= 1 (c/estimate-embed-tokens "abc")))
    (is (= 3 (c/estimate-embed-tokens ["abcde" 5 "a"])))
    (is (= 0 (c/estimate-embed-tokens 5)))))

(deftest context-length-from-show
  (let [ks ["qwen3.context_length" "general.context_length"]]
    (is (= 4096 (c/context-length-from-show ks {"context_length" 4096 "model_info" {"general.context_length" 1}})))
    (is (= 8192 (c/context-length-from-show ks {"model_info" {"general.context_length" 1 "qwen3.context_length" 8192}}))
        "key order, not map order, decides")
    (is (= 1 (c/context-length-from-show ks {"model_info" {"qwen3.context_length" "x" "general.context_length" 1}})))
    (is (nil? (c/context-length-from-show ks {"model_info" {}})))
    (is (nil? (c/context-length-from-show ks "x")))
    (is (= 7 (edge/ollama-context-length-from-show-js manifest #js {"model_info" #js {"gemma3.context_length" 7}})))))

(deftest budgets
  (let [chat (c/context-budget :chat {"model" "m" "messages" [{"role" "user" "content" "hi"}] "max_tokens" 100} 32768)]
    (is (= {:model "m" :context-length 32768 :estimated-input-tokens 10 :requested-output-tokens 100
            :required-context-tokens 110 :available-context-tokens 32768 :recommended-num-ctx 4096}
           chat)))
  (is (= 2048 (:requested-output-tokens (c/context-budget :chat {"model" "m"} 8192))) "default output")
  (is (= 5000 (:requested-output-tokens (c/context-budget :chat {"model" "m" "max_completion_tokens" 5000 "max_tokens" 1} 8192))))
  (is (= 6144 (:recommended-num-ctx (c/context-budget :chat {"model" "m" "max_tokens" 5000} 100000)))
      "rounded up to the next 1024 after 512 headroom")
  (is (= 3000 (:recommended-num-ctx (c/context-budget :chat {"model" "m"} 3000))) "never above the window")
  (testing "native chat includes tools and num_predict from options or top level"
    (let [b (c/context-budget :native-chat {"model" "m" "tools" [{"a" "bcdefgh"}] "options" {"num_predict" 7}} 10000)]
      (is (= 7 (:requested-output-tokens b)))
      (is (= (c/estimate-text-tokens "[{\"a\":\"bcdefgh\"}]") (:estimated-input-tokens b))))
    (is (= 9 (:requested-output-tokens (c/context-budget :native-chat {"model" "m" "num_predict" 9} 10000)))))
  (testing "embed prefers input over prompt, asks for no output"
    (let [b (c/context-budget :embed {"model" "m" "input" "abcdefgh" "prompt" "zz"} 10000)]
      (is (= 2 (:estimated-input-tokens b)))
      (is (= 0 (:requested-output-tokens b))))
    (is (= 1 (:estimated-input-tokens (c/context-budget :embed {"model" "m" "prompt" "zz"} 10000)))))
  (testing "no model or no usable length: no budget"
    (is (nil? (c/context-budget :chat {} 100)))
    (is (nil? (c/context-budget :chat {"model" ""} 100)))
    (is (nil? (c/context-budget :chat {"model" "m"} 0)))
    (is (nil? (c/context-budget :chat {"model" "m"} nil)))))

(deftest edge-shape
  (let [b (edge/ollama-context-budget-js "chat" #js {"model" "m"} 8192)]
    (is (= 8192 (.-contextLength b)))
    (is (= 4096 (.-recommendedNumCtx b))))
  (is (nil? (edge/ollama-context-budget-js "embed" #js {} 8192)))
  (is (thrown? js/Error (edge/ollama-context-budget-js "bogus" #js {"model" "m"} 1))))
