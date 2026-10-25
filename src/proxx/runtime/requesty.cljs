(ns proxx.runtime.requesty
  "JS edge for Requesty upstream-provider naming (src/lib/model-family.ts
  `requestyModelProvider`); takes the manifest path first because the mapping is
  policy (wire-profile/requesty), not code."
  (:require [proxx.compat.wire :as wire]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]))

(defonce ^:private profiles (atom {}))

(defn- profile-for [manifest-path]
  (or (get @profiles manifest-path)
      (let [profile (-> (loader/load-policy-contracts! manifest-path)
                        contracts/compile-contracts
                        (wire/profile "requesty"))]
        (swap! profiles assoc manifest-path profile)
        profile)))

(defn requesty-model-provider-js [manifest-path model]
  (wire/normalized-api-provider (profile-for manifest-path) model))
