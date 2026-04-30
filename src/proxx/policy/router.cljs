(ns proxx.policy.router
  (:require [proxx.policy :as policy]))

(defn route-request! [policies ctx trace]
  (if-let [result (some #(policy/eval-node % ctx trace) policies)]
    result
    (throw (ex-info "Policy tree exhausted"
                    {:proxx/exhausted true
                     :proxx/trace @trace}))))
