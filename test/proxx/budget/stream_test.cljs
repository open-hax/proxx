(ns proxx.budget.stream-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.budget.stream :as stream]))

(defn event [x] (str "data: " (js/JSON.stringify (clj->js x)) "\n\n"))
(def tools [{:type "function" :function {:name "lookup"}}])

(deftest reasoning-and-heartbeats-are-not-usable
  (is (false? (:ready (stream/probe ": keepalive\n\n" "sse" tools))))
  (is (false? (:ready (stream/probe (event {:choices [{:delta {:reasoning_content "thinking"}}]}) "sse" tools))))
  (is (:ready (stream/probe (event {:choices [{:delta {:content "answer"}}]}) "sse" tools))))

(deftest tool-output-needs-completion-known-name-and-valid-arguments
  (let [start (event {:choices [{:delta {:tool_calls [{:index 0 :id "call1" :function {:name "lookup" :arguments "{\"q\":"}}]}}]})
        finish (event {:choices [{:delta {:tool_calls [{:index 0 :function {:arguments "\"x\"}"}}]} :finish_reason "tool_calls"}]})]
    (is (false? (:ready (stream/probe start "sse" tools))))
    (is (:ready (stream/probe (str start finish) "sse" tools)))
    (is (false? (:ready (stream/probe (str start finish) "sse" []))))))

(deftest json-output-and-errors
  (is (:ready (stream/probe (js/JSON.stringify #js {:choices #js [#js {:message #js {:content "ok"}}]}) "json" tools)))
  (is (false? (:ready (stream/probe "{" "json" tools))))
  (is (:fatal (stream/probe (event {:error {:message "quota"}}) "sse" tools))))
