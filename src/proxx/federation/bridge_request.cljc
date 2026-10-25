(ns proxx.federation.bridge-request
  "Which response headers cross the bridge. (Capability matching lives in
  proxx.routing.bridge, driven by the provider-surface policy facts.)"
  (:require [clojure.string :as str]))

(defn forwardable-header?
  "Whether a response header may be copied onto our reply: the body length is
  ours to compute. With `hide-upstream-account?`, the headers that name the
  upstream account and its auth type stay behind too."
  [name hide-upstream-account?]
  (let [n (str/lower-case (str name))]
    (not (or (= n "content-length")
             (and hide-upstream-account?
                  (contains? #{"x-open-hax-upstream-account" "x-open-hax-upstream-auth-type"} n))))))
