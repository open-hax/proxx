(ns proxx.sse-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.sse :as sse]))

(defn- parse [s] (js->clj (js/JSON.parse s)))

(defn- body [& events]
  (apply str (map #(str "data: " % "\n\n") events)))

(deftest data-lines-and-comments
  (is (= ["{\"a\":1}" "[DONE]"]
         (sse/data-lines "data: {\"a\":1}\ndata:\nnoise\ndata:  [DONE] \n")))
  (is (= "data: x\n\ndata: y"
         (sse/strip-comment-lines ": keepalive\ndata: x\n\n: another\ndata: y")))
  (is (= "data: x\n\n" (sse/strip-comment-lines "data: x\r\n\r\n"))
      "trailing blank lines are preserved, as chunk boundaries"))

(deftest events-classify-fragments
  (is (= [{:data "{\"a\":1}" :parsed {"a" 1}}
          {:data "nope" :malformed? true}]
         (vec (sse/events parse "data: {\"a\":1}\ndata: [DONE]\ndata: nope\n"))))
  (is (empty? (sse/events parse ""))))

(deftest chat-completion-reasoning
  (is (sse/chat-completion-has-reasoning? {"reasoning_content" "x"}))
  (is (sse/chat-completion-has-reasoning? {"reasoning" "x"}))
  (is (sse/chat-completion-has-reasoning? {"choices" [{"message" {"reasoning_content" "x"}}]}))
  (is (sse/chat-completion-has-reasoning? {"choices" [nil {"delta" {"reasoning" "x"}}]}))
  (is (not (sse/chat-completion-has-reasoning? {"reasoning_content" "" "choices" [{"delta" {"content" "hi"}}]})))
  (is (not (sse/chat-completion-has-reasoning? {"choices" "nope"})))
  (testing "intent over `??` accident: any non-empty reasoning field counts"
    (is (sse/chat-completion-has-reasoning? {"reasoning_content" "" "reasoning" "x"}))))

(deftest stream-reasoning-trace
  (doseq [t ["response.reasoning.delta" "response.reasoning_text.delta"
             "response.reasoning_summary.delta" "response.reasoning_summary_text.delta"
             "response.reasoning_summary_part.delta"]]
    (is (sse/stream-has-reasoning-trace? parse (body (str "{\"type\":\"" t "\",\"delta\":\"hm\"}"))) t)
    (is (sse/stream-has-reasoning-trace? parse (body (str "{\"type\":\"" t "\",\"delta\":{\"text\":\"hm\"}}"))) t))
  (is (sse/stream-has-reasoning-trace? parse (body "{\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}")))
  (is (sse/stream-has-reasoning-trace? parse (body "{\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\"}}")))
  (is (not (sse/stream-has-reasoning-trace? parse (body "{\"type\":\"response.reasoning.delta\",\"delta\":\"\"}"))))
  (is (not (sse/stream-has-reasoning-trace? parse (body "{\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}"))))
  (is (not (sse/stream-has-reasoning-trace? parse "")))
  (is (not (sse/stream-has-reasoning-trace? parse "data: [DONE]")))
  (is (sse/stream-has-reasoning-trace? parse (str "data: {broken\n" (body "{\"reasoning\":\"x\"}")))
      "malformed fragments are skipped, not fatal"))

(deftest stream-substantive-chunks
  (is (not (sse/stream-has-substantive-chunks? parse "")))
  (is (not (sse/stream-has-substantive-chunks? parse "data: [DONE]")))
  (is (sse/stream-has-substantive-chunks? parse (body "{\"type\":\"response.output_text.delta\",\"delta\":\"\"}")))
  (is (sse/stream-has-substantive-chunks? parse "data: not json"))
  (is (sse/stream-has-substantive-chunks? parse (body "[1,2]")))
  (is (not (sse/stream-has-substantive-chunks? parse (body "{\"type\":\"response.reasoning.delta\",\"delta\":\"\"}"))))
  (is (sse/stream-has-substantive-chunks? parse (body "{\"type\":\"response.reasoning.delta\",\"delta\":\"x\"}")))
  (is (sse/stream-has-substantive-chunks?
       parse (body "{\"type\":\"response.reasoning.delta\",\"delta\":\"\"}" "{\"id\":\"c1\"}"))
      "empty reasoning deltas are skipped until something real arrives"))
