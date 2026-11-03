(ns proxx.events.labelers-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.events.labelers :as l]))

(deftest error-classifier
  (let [ev {"kind" "response" "status" 429 "providerId" "p"
            "payload" {"error" {"message" "Rate limit: content filter policy" "code" "Content_Filter"}}}]
    (is (l/applies? "error_classifier" ev))
    (is (= ["rate_limited" "content_filter" "quota_exceeded" "provider:p"] (l/label "error_classifier" ev))
        "deduplicated, in rule order")
    (is (not (l/applies? "error_classifier" {"kind" "response" "status" 200})))
    (is (= ["server_error"] (l/label "error_classifier" {"status" 503})))))

(deftest tool-use
  (let [ev {"kind" "request" "payload" {"tools" [{"function" {"name" "f"}} {"name" "g"} nil {"name" ""}]
                                        "tool_choice" nil}}]
    (is (= ["has_tools" "tool_count:4" "tool:f" "tool:g" "forced_tool_choice"] (l/label "tool_use" ev))
        "a present-but-null tool_choice counts as forced, as before")
    (is (= [] (l/label "tool_use" {"payload" {"tool_choice" "auto"}})))
    (is (= [] (l/label "tool_use" {"payload" "not a record"})))))

(deftest content-pattern
  (let [ev {"kind" "request" "payload" {"instructions" "Use OpenCode"
                                        "messages" [{"role" "system" "content" "```x```"}
                                                    {"role" "user" "content" [{"type" "input_image" "text" "<b>hi</b>"}]}]}}]
    (is (= ["has_code_fence" "has_xml_tags" "has_agent_markers" "has_system_prompt" "has_image_input"]
           (l/label "content_pattern" ev)))
    (is (= [] (l/label "content_pattern" {"payload" {"messages" [{"role" "system"}]}})) "no text, no tags")))

(deftest response-quality-and-cost
  (is (= ["tool_call_response" "truncated_response" "cache_heavy" "reasoning_heavy" "success"]
         (l/label "response_quality"
                  {"status" 200 "payload" {"choices" [{"finish_reason" "tool_calls"} nil {"finish_reason" "length"}]
                                           "usage" {"cached_tokens" 60 "prompt_tokens" 100
                                                    "reasoning_tokens" 6 "completion_tokens" 10}}})))
  (is (= ["very_high_cost"] (l/label "cost_tier" {"meta" {"costUsd" 2}})))
  (is (= ["low_cost"] (l/label "cost_tier" {"meta" {"costUsd" "3"}}))))
