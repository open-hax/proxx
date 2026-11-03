(ns proxx.compat.ollama-context-test
  (:require [cljs.test :refer [deftest is testing async]]
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
    (is (= 8192 (c/context-length-from-show ks {"parameters" "stop \"<x>\"\nnum_ctx                        8192\ntemperature 0.7"
                                                "model_info" {"general.context_length" 40960}}))
        "a Modelfile num_ctx wins over the architecture maximum")
    (is (= 40960 (c/context-length-from-show ks {"parameters" "temperature 0.7" "model_info" {"general.context_length" 40960}})))
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

(deftest context-cache
  (let [k (c/cache-key "http://h" "m")
        cache (c/remember {} k 4096 1000)]
    (is (= "http://h::m" k))
    (is (= "http://h/api/show" (c/show-url "http://h///")))
    (is (= 4096 (c/cached-length cache k (+ 1000 c/cache-ttl-ms -1) false)) "fresh inside the TTL")
    (is (nil? (c/cached-length cache k (+ 1000 c/cache-ttl-ms) false)) "stale at exactly the TTL")
    (is (= 4096 (c/cached-length cache k (+ 1000 c/cache-ttl-ms 1) true)) "stale entries still answer after a failure")
    (is (nil? (c/cached-length cache (c/cache-key "http://h" "other") 1000 true)))))

(defn- with-show-server
  "Run `f` with a base URL whose /api/show answers `(respond n)`; resolves to
  [result request-count]."
  [respond f]
  (let [http (js/require "node:http")
        n (atom 0)
        server (.createServer http
                              (fn [^js req ^js res]
                                (.on req "data" (fn [_]))
                                (.on req "end"
                                     (fn []
                                       (let [[status body] (respond (swap! n inc))]
                                         (.writeHead res status #js {"content-type" "application/json"})
                                         (.end res body))))))]
    (js/Promise.
     (fn [resolve reject]
       (.listen server 0 "127.0.0.1"
                (fn []
                  (let [base (str "http://127.0.0.1:" (.-port (.address server)))]
                    (-> (f base)
                        (.then (fn [r] (.close server) (resolve [r @n])))
                        (.catch (fn [e] (.close server) (reject e)))))))))))

(deftest edge-fetch-and-cache
  (async done
    (-> (with-show-server
          (fn [n] (if (= n 1) [200 "{\"context_length\":4096}"] [500 "{}"]))
          (fn [base]
            (-> (edge/fetch-ollama-model-context-length-js manifest base "m" 500 js/undefined)
                (.then (fn [a]
                         (-> (edge/fetch-ollama-model-context-length-js manifest base "m" 500 js/undefined)
                             (.then (fn [b] [a b]))))))))
        (.then (fn [[[a b] requests]]
                 (is (= [4096 4096] [a b]))
                 (is (= 1 requests) "the second answer is cached")
                 (done))))))

(deftest edge-failures
  (async done
    (-> (with-show-server
          (fn [_] [200 "[1]"])
          (fn [base]
            (-> (edge/ensure-ollama-context-fits-js manifest "chat" base #js {"model" "m"} 500 js/undefined)
                (.then (fn [budget]
                         (-> (edge/ensure-ollama-context-fits-js manifest "chat" base #js {"model" 5} 500 js/undefined)
                             (.then (fn [no-model] [budget no-model]))))))))
        (.then (fn [[[budget no-model] requests]]
                 (is (nil? budget) "an array body names no length")
                 (is (nil? no-model))
                 (is (= 1 requests) "no model, no request")
                 (done))))))
