;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.typed-kimi
  "JS value conversion only; the accepted owner supplies every protocol decision."
  (:require [pr-flow.kimi-verdict :as verdict]
            [proxx.domain.typed-kimi-submission :as submission]))

(defn schema [expected]
  (if-let [result (verdict/response-schema (js->clj expected :keywordize-keys true))]
    (clj->js result)
    (throw (js/Error. "typed-kimi:invalid-context"))))

(defn publication-intent [expected response]
  (let [result (verdict/publication-intent
                (js->clj expected :keywordize-keys true)
                (js->clj response :keywordize-keys true))]
    (if-let [refusal (:refusal result)]
      (throw (js/Error. (str "typed-kimi:" (name refusal))))
      (clj->js result))))

(defn- boundary-result [result]
  (if-let [refusal (:refusal result)]
    (throw (js/Error. (str "typed-kimi:" (name refusal))))
    (clj->js result)))

(defn structured-request [expected prompt]
  (boundary-result (submission/structured-request (js->clj expected :keywordize-keys true) prompt)))

(defn parse-submission [expected binding response]
  (boundary-result
    (submission/parse-submission (js->clj expected :keywordize-keys true)
                                 (js->clj binding :keywordize-keys true)
                                 (js->clj response :keywordize-keys true))))

#js {:schema schema :publicationIntent publication-intent
     :structuredRequest structured-request :parseSubmission parse-submission}
