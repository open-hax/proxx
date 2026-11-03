(ns proxx.proxy.chat-image-parts-test
  "Image content parts of chat completions normalised for Responses and Messages
  upstreams, through the real application."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json]]))

(deftest ^:async normalizes-image-input-parts-for-responses-upstream-requests
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (fx/json-reply {:id "resp_image_norm" :object "response" :created_at 1772516804
                                            :model "gpt-5.3-codex"
                                            :output [{:id "msg_image_norm" :type "message" :role "assistant"
                                                      :content [{:type "output_text" :text "image-normalized"}]}]}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          {:model "gpt-5.3-codex"
                                           :messages [{:role "user"
                                                       :content [{:type "input_text" :text "describe this image"}
                                                                 {:type "input_image"
                                                                  :image_url {:url "data:image/png;base64,AAAA" :detail "high"}}
                                                                 {:type "image"
                                                                  :source {:type "url" :url "https://example.com/cat.png"}}]}]
                                           :stream false}))
               content (get-in @seen ["input" 0 "content"])]
           (is (= 200 (:status response)))
           (is (map? @seen))
           (is (vector? (get @seen "input")))
           (is (map? (get-in @seen ["input" 0])))
           (is (vector? content))
           (is (= 3 (count content)))
           (is (map? (get content 0)))
           (is (= "input_text" (get-in content [0 "type"])))
           (is (= "describe this image" (get-in content [0 "text"])))
           (is (map? (get content 1)))
           (is (= "input_image" (get-in content [1 "type"])))
           (is (= "data:image/png;base64,AAAA" (get-in content [1 "image_url"])))
           (is (= "high" (get-in content [1 "detail"])))
           (is (map? (get content 2)))
           (is (= "input_image" (get-in content [2 "type"])))
           (is (= "https://example.com/cat.png" (get-in content [2 "image_url"])))))))))

(deftest ^:async normalizes-image-input-parts-for-messages-upstream-requests
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)})
                            (fx/json-reply {:id "msg_image_norm" :model "claude-opus-4-5-20251101" :role "assistant" :type "message"
                                            :content [{:type "text" :text "claude-image-normalized"}]
                                            :usage {:input_tokens 10 :output_tokens 6}}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          {:model "claude-opus-4-5"
                                           :messages [{:role "user"
                                                       :content [{:type "input_text" :text "what is in this image?"}
                                                                 {:type "input_image" :image_url {:url "data:image/png;base64,BBBB"}}
                                                                 {:type "image_url" :image_url {:url "https://example.com/dog.png"}}]}]
                                           :stream false}))
               body (:body @seen)
               content (get-in body ["messages" 0 "content"])]
           (is (= 200 (:status response)))
           (is (= "/v1/messages" (:path @seen)))
           (is (map? body))
           (is (vector? (get body "messages")))
           (is (map? (get-in body ["messages" 0])))
           (is (vector? content))
           (is (= 3 (count content)))
           (is (map? (get content 0)))
           (is (= "text" (get-in content [0 "type"])))
           (is (= "what is in this image?" (get-in content [0 "text"])))
           (is (map? (get content 1)))
           (is (= "image" (get-in content [1 "type"])))
           (is (map? (get-in content [1 "source"])))
           (is (= "base64" (get-in content [1 "source" "type"])))
           (is (= "image/png" (get-in content [1 "source" "media_type"])))
           (is (= "BBBB" (get-in content [1 "source" "data"])))
           (is (map? (get content 2)))
           (is (= "image" (get-in content [2 "type"])))
           (is (map? (get-in content [2 "source"])))
           (is (= "url" (get-in content [2 "source" "type"])))
           (is (= "https://example.com/dog.png" (get-in content [2 "source" "url"])))))))))
