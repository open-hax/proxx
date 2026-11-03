;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.typed-kimi
  "JS value conversion only; the accepted owner supplies every protocol decision."
  (:require [pr-flow.kimi-verdict :as verdict]))

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

#js {:schema schema :publicationIntent publication-intent}
