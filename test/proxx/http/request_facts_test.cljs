(ns proxx.http.request-facts-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.request-facts :as f]
            [proxx.runtime.http :as edge]))

(deftest prompt-cache-key
  (is (= "k" (f/prompt-cache-key {"prompt_cache_key" "  k "})))
  (is (= "c" (f/prompt-cache-key {"promptCacheKey" "c"})))
  (is (= "s" (f/prompt-cache-key {"prompt_cache_key" "s" "promptCacheKey" "c"})))
  (testing "a string snake_case field wins even when blank: the camelCase one is not consulted"
    (is (nil? (f/prompt-cache-key {"prompt_cache_key" "  " "promptCacheKey" "c"}))))
  (testing "non-strings are ignored"
    (is (= "c" (f/prompt-cache-key {"prompt_cache_key" 5 "promptCacheKey" "c"})))
    (is (nil? (f/prompt-cache-key {"prompt_cache_key" nil})))
    (is (nil? (f/prompt-cache-key {})))))

(deftest hashed-keys
  (let [fake #(str "abcdef0123456789-" %)]
    (is (= "sha256:abcdef012345" (f/hash-prompt-cache-key fake " key ")))
    (is (= "<REDACTED>" (f/hash-prompt-cache-key fake "   ")))
    (is (= "<REDACTED>" (f/hash-prompt-cache-key fake "")))))

(deftest csv-headers
  (is (= "x" (f/csv-header-with nil "x")))
  (is (= "x" (f/csv-header-with "" "x")))
  (is (= "a, x" (f/csv-header-with "a" "x")))
  (is (= "a,b, x" (f/csv-header-with "a,b" "x")) "the existing text is kept verbatim")
  (is (nil? (f/csv-header-with "a , x ,b" "x")) "already listed, whatever the spacing")
  (is (= "ax, x" (f/csv-header-with "ax" "x")) "a substring is not a token")
  (is (= "a, x" (f/csv-header-with "a" "x")))
  (testing "the web Headers edge sets it once"
    (let [h (js/Headers.)]
      (edge/append-csv-header-value-js h "anthropic-beta" "t1")
      (edge/append-csv-header-value-js h "anthropic-beta" "t2")
      (edge/append-csv-header-value-js h "anthropic-beta" "t1")
      (is (= "t1, t2" (.get h "anthropic-beta"))))))

(deftest interleaved-thinking
  (is (true? (f/interleaved-thinking? {"thinking" {"type" "enabled"}})))
  (is (not (f/interleaved-thinking? {"thinking" {"type" "disabled"}})))
  (is (not (f/interleaved-thinking? {"thinking" "enabled"})))
  (is (not (f/interleaved-thinking? {"thinking" ["enabled"]})))
  (is (not (f/interleaved-thinking? {}))))

(deftest responses-summary
  (is (= {"model" "m" "stream" true "max_output_tokens" 10 "input" {"kind" "text" "length" 3}}
         (f/summarize-responses-request {"model" "m" "stream" true "max_output_tokens" 10 "input" "abc"})))
  (testing "malformed scalars are left out; the input kind is the JavaScript typeof"
    (is (= {"input" {"kind" "undefined"}} (f/summarize-responses-request {"model" "  " "stream" "yes"})))
    (is (= {"input" {"kind" "object"}} (f/summarize-responses-request {"input" nil})))
    (is (= {"input" {"kind" "number"}} (f/summarize-responses-request {"input" 4})))
    (is (= {"input" {"kind" "object"}} (f/summarize-responses-request {"input" {"a" 1}})))
    (is (= {"input" {"kind" "undefined"}} (f/summarize-responses-request {"max_output_tokens" ##Inf}))))
  (testing "structured input: text characters and image parts"
    (is (= {"input" {"kind" "structured" "itemCount" 5 "textChars" 10 "imageCount" 3}}
           (f/summarize-responses-request
            {"input" [{"content" "hello"}
                      {"content" [{"type" "input_text" "text" "abc"} {"type" "Input_Image"} {"image_url" "u" "text" "xx"}
                                  "junk" ["nested"] {"type" "x" "imageUrl" nil "text" 7}]}
                      "not an item"
                      ["array"]
                      {"content" 5}]})))))

(deftest edge-wrappers
  (is (= "k" (edge/extract-prompt-cache-key-js #js {"promptCacheKey" " k "})))
  (is (undefined? (edge/extract-prompt-cache-key-js #js {})))
  (is (re-matches #"sha256:[0-9a-f]{12}" (edge/hash-prompt-cache-key-js "key")))
  (is (true? (edge/should-enable-interleaved-thinking-header-js #js {"thinking" #js {"type" "enabled"}})))
  (is (= 2 (.-itemCount ^js (.-input ^js (edge/summarize-responses-request-body-js #js {"input" #js [#js {} #js {}]}))))))
