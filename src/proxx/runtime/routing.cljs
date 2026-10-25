(ns proxx.runtime.routing
  "JS edge for the routing helpers ported from src/lib (provider-routing,
  provider-catalog, catalog-alias-resolver, catalog-resolution,
  model-routing-pipeline, routing-outcome-handler, bridge-helpers).

  The edge owns policy loading and JS <-> domain conversion. Decisions live in
  proxx.routing.*; provider/model facts live in the `:provider-surface-facts`
  contract. Ordered JS objects cross the boundary as arrays of entries and are
  rebuilt with `aset`, so key order is exactly the order the pure code computed."
  (:require [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.bridge :as bridge]
            [proxx.routing.surface :as surface]))

(defonce ^:private facts-cache (atom {}))

(defn surface-facts
  "The surface-facts contract for a manifest, loaded and validated once."
  [manifest-path]
  (or (get @facts-cache manifest-path)
      (let [f (-> (loader/load-policy-contracts! manifest-path)
                  contracts/compile-contracts
                  surface/facts)]
        (swap! facts-cache assoc manifest-path f)
        f)))

(defn- defined? [v] (not (identical? js/undefined v)))

(defn- js-fields
  "Selected fields of a JS object as a keyword map; undefined fields stay absent
  (an explicit null is kept: `null` and `undefined` are different capability hints)."
  [^js obj field-keys]
  (into {}
        (keep (fn [[k prop]] (let [v (aget obj prop)] (when (defined? v) [k (js->clj v)]))))
        field-keys))

(def ^:private bridge-capability-fields
  {:paths "paths" :routes "routes" :models "models" :model-prefixes "modelPrefixes"
   :supports-models-list "supportsModelsList" :supports-chat-completions "supportsChatCompletions"
   :supports-responses "supportsResponses"})

(defn bridge-capability-supports-path-js [manifest-path capability normalized-path]
  (bridge/supports-path? (surface-facts manifest-path) (js-fields capability bridge-capability-fields) normalized-path))

(defn bridge-capability-supports-model-js [capability requested-model]
  (bridge/supports-model? (js-fields capability bridge-capability-fields) requested-model))
