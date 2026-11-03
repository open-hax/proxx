(ns proxx.runtime.glm
  "JS edge for GLM compat (same names/signatures as src/lib/glm-compat.ts)."
  (:require [proxx.compat.glm :as glm]
            [proxx.policy.contracts :as contracts]))

(defn is-glm-model-js [model] (contracts/glm-model? model))

(defn apply-glm-thinking-js
  "Rewrite `body` for GLM; returns it untouched when `model` is given and is not GLM."
  [body model]
  (if (and (some? model) (not (contracts/glm-model? model)))
    body
    (clj->js (glm/apply-glm-thinking (js->clj body)))))
