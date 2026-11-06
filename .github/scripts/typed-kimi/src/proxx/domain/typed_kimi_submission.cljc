;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.domain.typed-kimi-submission
  "Pure native wire boundary. Passed metadata is not process or App authentication."
  (:require [clojure.string :as str]
            [pr-flow.kimi-verdict :as verdict]))

;; Same observed SDK route/control as the existing protected v1 runner.
;; This is neither a hidden provider-model nor reasoning-budget attestation.
(def native-profile
  {:providerID "kimi-code-plan-global" :modelID "kimi-for-coding" :variant "low"})
(def binding-fields #{:sessionID :assistantID})

(defn structured-request [expected prompt]
  (if-let [schema (verdict/response-schema expected)]
    (if (and (string? prompt) (not (str/blank? prompt)))
      {:agent "kimi-reviewer" :variant (:variant native-profile)
       :model (select-keys native-profile [:providerID :modelID])
       :parts [{:type "text" :text prompt}]
       :format {:type "json_schema" :retryCount 1 :schema schema}}
      {:refusal :invalid-prompt})
    {:refusal :invalid-context}))

(defn- bound-id? [value prefix]
  (and (string? value)
       (boolean (re-matches (re-pattern (str prefix "_[a-zA-Z0-9]+")) value))))
(defn- binding? [value]
  (and (map? value) (= binding-fields (set (keys value)))
       (bound-id? (:sessionID value) "ses") (bound-id? (:assistantID value) "msg")))
(defn- completed? [time]
  (let [value (:completed time)]
    (and (integer? value) (pos? value) (<= value 9007199254740991))))

(defn parse-submission [expected binding response]
  (let [info (:info response)
        parts (:parts response)
        submissions (when (vector? parts)
                      (filterv #(and (= "tool" (:type %)) (= "StructuredOutput" (:tool %))) parts))
        submission (first submissions)
        value (:structured info)]
    (cond
      (not (binding? binding)) {:refusal :invalid-binding}
      (not (and (= "assistant" (:role info)) (not (:error info))
                (= native-profile (select-keys info (keys native-profile)))
                (= (:assistantID binding) (:id info)) (= (:sessionID binding) (:sessionID info))
                (completed? (:time info))))
      {:refusal :invalid-assistant}
      (not (and (= 1 (count submissions)) (= "completed" (get-in submission [:state :status]))
                (= (:sessionID binding) (:sessionID submission))
                (= (:assistantID binding) (:messageID submission))
                (map? value) (= value (get-in submission [:state :input]))))
      {:refusal :invalid-structured-evidence}
      :else
      (let [proposal (verdict/publication-intent expected value)]
        (if (:refusal proposal)
          proposal
          {:response value :proposal proposal
           :observed (merge native-profile
                            {:sessionID (:sessionID binding) :assistantID (:assistantID binding)
                             :completedAt (get-in info [:time :completed])})})))))
