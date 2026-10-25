(ns proxx.compat.wire-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.compat.wire :as wire]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.runtime.requesty :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")

(def requesty
  (-> (loader/load-policy-contracts! manifest) contracts/compile-contracts (wire/profile "requesty")))

(deftest requesty-provider-by-prefix
  (doseq [[model provider]
          [["gpt-5" "openai"] ["chatgpt-4o" "openai"] ["o1" "openai"] ["o3-mini" "openai"] ["o4mini" "openai"] ["gpt" "openai"]
           ["claude-opus-4" "anthropic"] ["claude" "anthropic"] ["gemini-2.5" "google"] ["glm-5" "zhipu"]
           ["deepseek-v3" "deepseek"] ["deepseekish" "deepseek"] ["kimi-k2" "moonshotai"] ["qwen3-coder" "qwen"]
           ["gptx" "openai"] ["claudex" "openai"] ["mystery" "openai"] ["" "openai"]
           ["  CLAUDE-3  " "anthropic"] ["GEMINI-2" "google"]]]
    (is (= provider (wire/normalized-api-provider requesty model)) (pr-str model))
    (is (= provider (edge/requesty-model-provider-js manifest model)) (pr-str model))))
