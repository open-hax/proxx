(ns proxx.policy.loader
  (:require [cljs.reader :as reader]
            [proxx.schema :as schema]))

(defn- read-file [path]
  (let [fs (js/require "fs")]
    (.readFileSync fs path "utf8")))

(defn- validate-policy! [policy]
  (try
    (schema/assert! :proxx/policy policy)
    (catch :default e
      (throw (ex-info "Invalid policy EDN"
                      {:policy policy
                       :cause (ex-data e)})))))

(defn load-policies! [path-or-resource-root]
  (let [raw (reader/read-string (read-file path-or-resource-root))
        policies (if (vector? raw) raw [raw])]
    (doseq [policy policies]
      (validate-policy! policy))
    policies))
