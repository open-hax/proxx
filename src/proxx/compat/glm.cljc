(ns proxx.compat.glm
  "Pure GLM thinking-control translation.

  GLM upstreams take a boolean `enable_thinking` rather than OpenAI-style
  reasoning effort or an Anthropic `thinking` block. Whether a model *is* GLM is
  policy (`:model-family/glm` in 10-model-families.edn) and is decided by the
  caller; this namespace only rewrites a body already known to target GLM."
  (:require [clojure.string :as str]))

(def ^:private disabled-efforts #{"none" "disable" "disabled" "off"})

(defn- effort-disabled? [effort]
  (contains? disabled-efforts (str/lower-case (str/trim effort))))

(defn- effort
  "The first present effort string, wherever clients put it."
  [body]
  (some #(when (string? %) %)
        [(get (when (map? (get body "reasoning")) (get body "reasoning")) "effort")
         (get body "reasoning_effort")
         (get body "reasoningEffort")]))

(defn thinking-flag
  "Does the request ask for thinking? true / false, or nil when it says nothing.
  Precedence: explicit `thinking.type disabled`, then any effort string, then
  `thinking.type enabled` or a bare `reasoning` object."
  [body]
  (let [thinking-type (get (when (map? (get body "thinking")) (get body "thinking")) "type")]
    (cond
      (= "disabled" thinking-type) false
      (effort body) (not (effort-disabled? (effort body)))
      (or (= "enabled" thinking-type) (map? (get body "reasoning"))) true)))

(defn apply-glm-thinking
  "Set `enable_thinking` on a GLM request body from whatever thinking controls
  it carries. An explicit disable also removes the unsupported `thinking` block."
  [body]
  (let [flag (thinking-flag body)]
    (cond-> body
      (some? flag) (assoc "enable_thinking" flag)
      (= "disabled" (get (when (map? (get body "thinking")) (get body "thinking")) "type")) (dissoc "thinking"))))
