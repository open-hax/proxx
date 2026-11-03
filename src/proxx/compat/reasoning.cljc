(ns proxx.compat.reasoning
  "Shared reading of the reasoning controls clients send in several spellings
  (`reasoning.effort`, `reasoning_effort`, `reasoningEffort`, `thinking`,
  `include`). Pure decisions over string-keyed request bodies."
  (:require [clojure.string :as str]))

(def ^:private disabled-efforts #{"none" "disable" "disabled" "off"})

(defn effort-disabled? [effort]
  (contains? disabled-efforts (str/lower-case (str/trim effort))))

(defn requested-effort
  "The first effort *string* present, in precedence order, even when empty
  (an empty string still shadows the lower-precedence spellings)."
  [body]
  (let [reasoning (get body "reasoning")]
    (some #(when (string? %) %)
          [(when (map? reasoning) (get reasoning "effort"))
           (get body "reasoning_effort")
           (get body "reasoningEffort")])))

(defn thinking-type [body]
  (let [thinking (get body "thinking")]
    (when (map? thinking) (get thinking "type"))))

(defn includes-trace?
  "Does an `include` list ask for the encrypted reasoning trace?"
  [include]
  (and (sequential? include) (boolean (some #{"reasoning.encrypted_content"} include))))

(defn wants-reasoning-trace?
  "Does the request want reasoning back? An encrypted-trace include wins, then an
  explicit `thinking.type`, then a non-empty effort (unless it says off), and
  finally the mere presence of a `reasoning` object."
  [body]
  (let [effort (requested-effort body)]
    (cond
      (includes-trace? (get body "include")) true
      (= "enabled" (thinking-type body)) true
      (= "disabled" (thinking-type body)) false
      (seq effort) (not (effort-disabled? effort))
      :else (map? (get body "reasoning")))))
