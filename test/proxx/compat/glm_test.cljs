(ns proxx.compat.glm-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.compat.glm :as glm]
            [proxx.runtime.glm :as edge]))

(deftest thinking-flag-precedence
  (is (false? (glm/thinking-flag {"thinking" {"type" "disabled"} "reasoning_effort" "high"})))
  (is (false? (glm/thinking-flag {"thinking" {"type" "enabled"} "reasoning_effort" "off"}))
      "any effort string outranks thinking.type enabled")
  (doseq [e ["none" "DISABLE" " Off " "disabled"]]
    (is (false? (glm/thinking-flag {"reasoning_effort" e})) e))
  (doseq [e ["low" "high" "bogus" ""]]
    (is (true? (glm/thinking-flag {"reasoning" {"effort" e}})) e))
  (is (true? (glm/thinking-flag {"reasoningEffort" "high"})))
  (is (true? (glm/thinking-flag {"thinking" {"type" "enabled"}})))
  (is (true? (glm/thinking-flag {"reasoning" {}})))
  (is (nil? (glm/thinking-flag {"reasoning" [1]})) "intentional: arrays are not reasoning objects")
  (is (nil? (glm/thinking-flag {"model" "glm-5"}))))

(deftest apply-glm-thinking
  (is (= {"enable_thinking" false "m" 1}
         (glm/apply-glm-thinking {"thinking" {"type" "disabled"} "m" 1})))
  (is (= {"reasoning_effort" "none" "enable_thinking" false}
         (glm/apply-glm-thinking {"reasoning_effort" "none"})))
  (is (= {"thinking" {"type" "enabled"} "enable_thinking" true}
         (glm/apply-glm-thinking {"thinking" {"type" "enabled"}})))
  (let [plain {"messages" []}]
    (is (identical? plain (glm/apply-glm-thinking plain)) "no controls: body unchanged")))

(deftest edge-respects-family-policy
  (let [body #js {"reasoning_effort" "none"}]
    (is (identical? body (edge/apply-glm-thinking-js body "gpt-5")))
    (is (= false (.-enable_thinking (edge/apply-glm-thinking-js body "GLM-5"))))
    (is (= false (.-enable_thinking (edge/apply-glm-thinking-js body js/undefined)))
        "no model: apply unconditionally, as before")
    (is (edge/is-glm-model-js " glm-4.6 "))
    (is (not (edge/is-glm-model-js "gpt-5")))))
