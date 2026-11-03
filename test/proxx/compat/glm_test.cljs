(ns proxx.compat.glm-test
  (:require [cljs.test :refer [deftest is]]
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

;; ---- ported from src/tests/glm-compat.test.ts (15 tests) -----------------
;; The TS shim called the JS edge, so these drive it with JS bodies.

(defn- glm-body [m] (clj->js (merge {"model" "glm-4.7" "messages" [{"role" "user" "content" "hello"}]} m)))
(defn- apply-glm ^js [m] (edge/apply-glm-thinking-js (glm-body m) "glm-4.7"))

(deftest ts-is-glm-model-matches-glm-prefixed-models
  (doseq [m ["glm-4.5" "glm-4.6" "glm-4.7" "glm-5" "glm-4.5v" "glm-4.7-flash" "GLM-4.5" " glm-4.5 "]]
    (is (true? (edge/is-glm-model-js m)) m))
  (doseq [m ["gpt-4" "claude-3" "gemini-2.5" "qwen3.5"]]
    (is (false? (edge/is-glm-model-js m)) m)))

(deftest ts-none-effort-sets-enable-thinking-false-without-mutating-input
  (let [body (glm-body {"reasoning" {"effort" "none"}})
        ^js result (edge/apply-glm-thinking-js body "glm-4.7")]
    (is (false? (.-enable_thinking result)))
    (is (undefined? (.-enable_thinking body)))))

(deftest ts-low-medium-high-xhigh-effort-sets-enable-thinking-true
  (doseq [effort ["low" "medium" "high" "xhigh"]]
    (is (true? (.-enable_thinking (apply-glm {"reasoning" {"effort" effort}}))) effort)))

(deftest ts-reasoning-effort-top-level-field
  (is (true? (.-enable_thinking (apply-glm {"reasoning_effort" "high"})))))

(deftest ts-reasoning-effort-camel-case-field
  (is (true? (.-enable_thinking (apply-glm {"reasoningEffort" "low"})))))

(deftest ts-thinking-type-disabled
  (let [result (apply-glm {"thinking" {"type" "disabled"}})]
    (is (false? (.-enable_thinking result)))
    (is (undefined? (.-thinking result)))))

(deftest ts-thinking-type-enabled
  (is (true? (.-enable_thinking (apply-glm {"thinking" {"type" "enabled"}})))))

(deftest ts-no-enable-thinking-when-no-reasoning-requested
  (is (undefined? (.-enable_thinking (apply-glm {})))))

(deftest ts-does-not-modify-non-glm-models
  (let [^js result (edge/apply-glm-thinking-js (clj->js {"model" "gpt-5" "messages" [{"role" "user" "content" "hello"}]
                                                         "reasoning" {"effort" "high"}})
                                               "gpt-5")]
    (is (undefined? (.-enable_thinking result)))
    (is (= "high" (.. result -reasoning -effort)))))

(deftest ts-disabled-variants-disable-disabled-off
  (doseq [variant ["disable" "disabled" "off"]]
    (is (false? (.-enable_thinking (apply-glm {"reasoning" {"effort" variant}})))
        (str "expected false for effort=\"" variant "\""))))

(deftest ts-preserves-other-body-fields
  (let [result (apply-glm {"temperature" 0.7 "max_tokens" 4096 "stream" true "reasoning" {"effort" "high"}})]
    (is (= "glm-4.7" (.-model result)))
    (is (= 0.7 (.-temperature result)))
    (is (= 4096 (.-max_tokens result)))
    (is (true? (.-stream result)))
    (is (true? (.-enable_thinking result)))))

(deftest ts-does-not-mutate-the-original-body
  (let [body (glm-body {"thinking" {"type" "disabled"} "reasoning" {"effort" "high"}})
        original (js/JSON.stringify body)]
    (edge/apply-glm-thinking-js body "glm-4.7")
    (is (= original (js/JSON.stringify body)))
    (is (undefined? (.-enable_thinking body)))
    (is (some? (.-reasoning body)))))
