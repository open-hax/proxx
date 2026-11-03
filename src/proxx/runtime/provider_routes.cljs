(ns proxx.runtime.provider-routes
  "JS edge for the declared provider routes (src/lib/provider-routing.ts): load
  the routes from policy, filter them for a request, and apply the policy
  decision. It sequences the policy runtime and the pure route functions in
  proxx.routing.routes (via proxx.runtime.routing); the host only decides whether
  a policy runtime is active at all."
  (:require [proxx.runtime :as runtime]
            [proxx.runtime.routing :as routing]
            [proxx.runtime.strategy :as strategy]))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn get-declared-provider-routes-js
  "Routes declared in the manifest, with configured urls applied. `config-or-manifest-path`
  is a runtime config object, a manifest path, or undefined; `policy-manifest-path` is the
  host's resolved surface-facts manifest."
  [policy-manifest-path config-or-manifest-path]
  (let [config (when (= "object" (js* "typeof ~{}" config-or-manifest-path)) config-or-manifest-path)
        manifest (cond (string? config-or-manifest-path) config-or-manifest-path
                       (some? config) (.-cljsPolicyManifestPath ^js config))
        result (runtime/get-provider-routes-js (or manifest default-manifest))]
    (routing/declared-provider-routes-js policy-manifest-path result config)))

(defn filter-declared-provider-routes-js
  "`{providerRoutes, strategyMode?, strategyModeByProvider?, catalog}`: the routes
  eligible for `input` and the strategy the policy prefers for them. When the
  policy runtime does not answer `ok`, the input routes pass through unfiltered."
  [manifest-path ^js input]
  (let [manifest (or manifest-path default-manifest)
        ^js result (runtime/filter-provider-routes-js manifest input)
        input-routes (.-providerRoutes input)]
    (if (not= "ok" (.-status result))
      #js {"providerRoutes" (to-array (array-seq input-routes))}
      (let [filtered (routing/filtered-provider-routes-js result input-routes)
            infos (strategy/strategy-infos-js nil)
            preview-input #js {"modelId" (.-modelId input)
                               "requestKind" (.-requestKind input)
                               "tenantSettings" (.-tenantSettings input)
                               "providerIds" (to-array (map (fn [^js r] (.-providerId r)) (array-seq filtered)))}
            _ (when (some? (.-requestedProviderIds input))
                (aset preview-input "requestedProviderIds" (.-requestedProviderIds input)))
            _ (aset preview-input "strategies" infos)
            preview (runtime/preview-policy-decision-js manifest preview-input)
            ^js decided (routing/apply-provider-route-decision-js
                         preview filtered (to-array (map (fn [^js i] (.-mode i)) (array-seq infos))))
            out #js {"providerRoutes" (.-providerRoutes decided)}]
        (when (.-strategyMode decided) (aset out "strategyMode" (.-strategyMode decided)))
        (when (.-strategyModeByProvider decided) (aset out "strategyModeByProvider" (.-strategyModeByProvider decided)))
        (aset out "catalog" (.-catalog result))
        out))))
