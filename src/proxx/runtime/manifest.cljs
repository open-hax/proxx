(ns proxx.runtime.manifest
  "Where the runtime policy manifest lives for code that has no ProxyConfig in hand
  (the former src/lib/policy-manifest.ts): the PROXX_/PROXY_CLJS_POLICY_MANIFEST
  aliases, else the default, resolved against the working directory."
  (:require ["node:path" :as path]
            [clojure.string :as str]))

(def default-manifest "./resources/policies/runtime/00-manifest.edn")

(defn policy-manifest-path []
  (let [configured (some (fn [k] (let [v (aget js/process.env k)]
                                   (when (and (string? v) (seq (str/trim v))) (str/trim v))))
                         ["PROXX_CLJS_POLICY_MANIFEST" "PROXY_CLJS_POLICY_MANIFEST"])]
    (.resolve path (js/process.cwd) (or configured default-manifest))))
