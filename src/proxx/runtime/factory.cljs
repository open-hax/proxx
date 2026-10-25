(ns proxx.runtime.factory
  "JS edge for Factory compat (names/signatures of src/lib/factory-compat.ts).
  Functions that read policy take the manifest path first; random per-request
  ids are generated here, at the edge."
  (:require ["node:crypto" :as crypto]
            [proxx.compat.factory :as factory]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]))

(defonce ^:private profiles (atom {}))

(defn- profile-for
  "The factory wire profile for a manifest, loaded and validated once."
  [manifest-path]
  (or (get @profiles manifest-path)
      (let [profile (-> (loader/load-policy-contracts! manifest-path)
                        contracts/compile-contracts
                        (factory/profile "factory"))]
        (swap! profiles assoc manifest-path profile)
        profile)))

(defn- ids [] {:session-id (.randomUUID crypto) :message-id (.randomUUID crypto)})

(defn get-factory-model-type-js [manifest-path model]
  (some-> (factory/model-type (profile-for manifest-path) model) name))

(defn get-factory-api-provider-js [manifest-path model]
  (factory/api-provider (profile-for manifest-path) model))

(defn get-factory-endpoint-path-js [manifest-path model-type]
  (factory/endpoint-path (profile-for manifest-path) (keyword model-type)))

(defn build-factory-common-headers-js [manifest-path model]
  (clj->js (factory/common-headers (profile-for manifest-path) model (ids))))

(defn build-factory-anthropic-headers-js [manifest-path model payload interleaved-thinking-beta]
  (clj->js (factory/anthropic-headers (profile-for manifest-path) model (js->clj payload)
                                      interleaved-thinking-beta (ids))))

(defn inline-system-prompt-js [payload]
  (clj->js (factory/inline-system-prompt (js->clj payload))))

(defn sanitize-factory-system-prompt-js [manifest-path system-text]
  (factory/sanitize-system-prompt (profile-for manifest-path) system-text))

(defn is-fk-key-js [manifest-path credential]
  (boolean (factory/fk-key? (profile-for manifest-path) (js->clj credential))))
