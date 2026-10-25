(ns proxx.runtime.routing
  "JS edge for the routing helpers ported from src/lib (provider-routing,
  provider-catalog, catalog-alias-resolver, catalog-resolution,
  model-routing-pipeline, routing-outcome-handler, bridge-helpers).

  The edge owns policy loading and JS <-> domain conversion. Decisions live in
  proxx.routing.*; provider/model facts live in the `:provider-surface-facts`
  contract. Ordered JS objects cross the boundary as arrays of entries and are
  rebuilt with `aset`, so key order is exactly the order the pure code computed."
  (:require [proxx.runtime.interop :as interop]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.bridge :as bridge]
            [proxx.routing.model-ids :as model-ids]
            [proxx.routing.provider-routes :as routes]
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
        (keep (fn [[k prop]] (let [v (aget obj prop)] (when (defined? v) [k (interop/js->data v)]))))
        field-keys))

(def ^:private bridge-capability-fields
  {:paths "paths" :routes "routes" :models "models" :model-prefixes "modelPrefixes"
   :supports-models-list "supportsModelsList" :supports-chat-completions "supportsChatCompletions"
   :supports-responses "supportsResponses"})

(defn bridge-capability-supports-path-js [manifest-path capability normalized-path]
  (bridge/supports-path? (surface-facts manifest-path) (js-fields capability bridge-capability-fields) normalized-path))

(defn bridge-capability-supports-model-js [capability requested-model]
  (bridge/supports-model? (js-fields capability bridge-capability-fields) requested-model))

;; ---------------------------------------------------------------------------
;; provider-routing (src/lib/provider-routing.ts)
;; ---------------------------------------------------------------------------

(defn- or-undefined [x] (if (nil? x) js/undefined x))

(defn- coalesce-prop
  "`o[a] ?? o[b]` for a policy-runtime result."
  [^js o a b]
  (let [v (aget o a)] (if (some? v) v (aget o b))))

(defn provider-routes-from-raw-js [raw]
  (or-undefined (some-> (routes/routes-from-raw (interop/js->data raw)) clj->js)))

(defn- route-config [^js config]
  (when (some? config)
    {:openai-provider-id (.-openaiProviderId config)
     :openai-base-url (.-openaiBaseUrl config)
     :ollama-base-url (.-ollamaBaseUrl config)
     :upstream-provider-base-urls (interop/js->data (.-upstreamProviderBaseUrls config))}))

(defn declared-provider-routes-js
  "Routes of a successful `getProviderRoutes` result with configured urls applied; [] otherwise."
  [manifest-path ^js result config]
  (if (and (some? result) (= "ok" (.-status result)))
    (clj->js (routes/apply-configured-route-facts
              (surface-facts manifest-path)
              (or (routes/routes-from-raw (interop/js->data (coalesce-prop result "providerRoutes" "provider-routes"))) [])
              (route-config config)))
    #js []))

(defn filtered-provider-routes-js
  "The routes a `filterProviderRoutes` result kept, enriched from `input-routes`."
  [^js result input-routes]
  (clj->js (routes/filtered-routes (interop/js->data (coalesce-prop result "providerRoutes" "provider-routes"))
                                   (interop/js->data input-routes))))

(defn apply-provider-route-decision-js
  "{providerRoutes, strategyMode?, strategyModeByProvider?} from a policy preview and
  the filtered routes; `upstream-modes` lists the strategy modes that exist."
  [^js preview filtered-routes upstream-modes]
  (let [decision (when (and (some? preview) (= "ok" (.-status preview))) (interop/js->data (.-decision preview)))
        {:keys [routes strategy-mode strategy-mode-by-provider]}
        (routes/apply-policy-decision (interop/js->data filtered-routes) decision (set (interop/js->data upstream-modes)))
        o #js {:providerRoutes (clj->js routes)}]
    (when strategy-mode (aset o "strategyMode" strategy-mode))
    (when strategy-mode-by-provider (aset o "strategyModeByProvider" (clj->js strategy-mode-by-provider)))
    o))

(defn looks-like-hosted-open-ai-family-js [manifest-path model]
  (surface/hosted-openai-family? (surface-facts manifest-path) model))

(defn strip-model-prefix-js [model prefixes] (model-ids/strip-model-prefix model (interop/js->data prefixes)))

(defn has-model-prefix-js [model prefixes] (model-ids/has-model-prefix? model (interop/js->data prefixes)))

(defn should-use-local-ollama-js [manifest-path model patterns]
  (boolean (model-ids/local-ollama-model? (surface-facts manifest-path) model (interop/js->data patterns))))

(defn resolve-request-routing-state-js [manifest-path ^js config requested-model]
  (let [{:keys [explicit-ollama openai-prefixed factory-prefixed local-ollama routed-model]}
        (model-ids/request-routing-state
         (surface-facts manifest-path)
         {:factory-model-prefixes (interop/js->data (.-factoryModelPrefixes config))
          :ollama-model-prefixes (interop/js->data (.-ollamaModelPrefixes config))
          :openai-model-prefixes (interop/js->data (.-openaiModelPrefixes config))
          :local-ollama-enabled (.-localOllamaEnabled config)
          :local-ollama-model-patterns (interop/js->data (.-localOllamaModelPatterns config))}
         requested-model)]
    #js {:explicitOllama explicit-ollama :openAiPrefixed openai-prefixed :factoryPrefixed factory-prefixed
         :localOllama local-ollama :routedModel routed-model}))

(defn dedupe-model-ids-js [model-ids] (to-array (model-ids/dedupe-model-ids (interop/js->data model-ids))))

(defn parse-model-ids-from-catalog-payload-js [payload]
  (to-array (model-ids/parse-model-ids-from-catalog-payload (interop/js->data payload))))

(defn- entries->js-object
  "A JS object built entry by entry: key order is the order of `entries`."
  [entries]
  (let [o #js {}]
    (doseq [[k v] entries] (aset o k v))
    o))

(defn build-largest-model-aliases-js [model-ids]
  (entries->js-object (model-ids/largest-model-aliases (interop/js->data model-ids))))

(defn build-ollama-catalog-routes-js [manifest-path ^js config]
  (clj->js (model-ids/ollama-catalog-routes
            (surface-facts manifest-path)
            {:ollama-base-url (.-ollamaBaseUrl config)
             :local-ollama-enabled (.-localOllamaEnabled config)
             :upstream-provider-base-urls (interop/js->data (js/Object.entries (.-upstreamProviderBaseUrls config)))})))

(defn provider-supports-responses-api-js [manifest-path provider-id open-ai-provider-id]
  (surface/responses-provider? (surface-facts manifest-path) provider-id open-ai-provider-id))

(defn provider-supports-images-api-js [manifest-path provider-id open-ai-provider-id]
  (surface/openai-compatible-provider? (surface-facts manifest-path) provider-id open-ai-provider-id))

(defn filter-responses-api-routes-js [manifest-path ^js route-list open-ai-provider-id]
  (let [facts (surface-facts manifest-path)]
    (.filter route-list (fn [^js route] (surface/responses-provider? facts (.-providerId route) open-ai-provider-id)))))

(defn filter-images-api-routes-js [manifest-path ^js route-list open-ai-provider-id]
  (let [facts (surface-facts manifest-path)]
    (.filter route-list (fn [^js route] (surface/openai-compatible-provider? facts (.-providerId route) open-ai-provider-id)))))

(defn min-ms-until-any-provider-key-ready-js
  "Smallest positive wait before any route's provider has a ready key (0 when none).
  Routes are asked one after another; a status error is ignored so the other
  providers are still considered."
  [^js key-pool route-list]
  (reduce (fn [acc ^js route]
            (.then acc (fn [min-ready]
                         (-> (js/Promise.resolve)
                             (.then (fn [] (.msUntilAnyKeyReady key-pool (.-providerId route))))
                             (.catch (fn [_] 0))
                             (.then (fn [retry] (routes/next-min-ready min-ready retry)))))))
          (js/Promise.resolve 0)
          (array-seq route-list)))

(defn create-dynamic-provider-base-url-getter-js [^js sql-credential-store]
  (if (nil? sql-credential-store)
    js/undefined
    (fn [provider-id]
      (.then (js/Promise.resolve (.getProviderById sql-credential-store provider-id))
             (fn [^js provider] (when (some? provider) (let [url (.-baseUrl provider)] (when (some? url) url))))))))
