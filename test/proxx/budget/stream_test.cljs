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

(deftest incremental-probe-parses-each-complete-event-once
  (let [line (event {:choices [{:delta {:reasoning_content "thinking"}}]})
        calls (atom 0)
        original (.-parse js/JSON)]
    (try
      (set! (.-parse js/JSON) (fn [text] (swap! calls inc) (original text)))
      (let [state (reduce #(stream/advance %1 %2 "sse" [] false) nil (repeat 200 line))]
        (is (false? (:ready state)))
        (is (= 200 @calls)))
      (finally (set! (.-parse js/JSON) original)))))

(deftest incremental-probe-retains-split-tools-and-fatal-state
  (let [text (str (event {:choices [{:delta {:tool_calls [{:index 0 :id "call1" :function {:name "lookup" :arguments "{\"q\":"}}]}}]})
                  (event {:choices [{:delta {:tool_calls [{:index 0 :function {:arguments "\"x\"}"}}]} :finish_reason "tool_calls"}]}))
        state (reduce #(stream/advance %1 %2 "sse" tools false) nil (map str text))]
    (is (:ready state))
    (is (:fatal (stream/advance state (event {:error {:message "quota"}}) "sse" tools false)))))

(deftest incremental-json-waits-for-end
  (let [calls (atom 0) original (.-parse js/JSON)]
    (try
      (set! (.-parse js/JSON) (fn [text] (swap! calls inc) (original text)))
      (let [state (stream/advance nil "{\"choices\":[{\"message\":{\"content\":\"answer\"}}]}" "json" [] false)]
        (is (false? (:ready state)))
        (is (zero? @calls))
        (is (:ready (stream/advance state "" "json" [] true)))
        (is (= 1 @calls)))
      (finally (set! (.-parse js/JSON) original)))))
