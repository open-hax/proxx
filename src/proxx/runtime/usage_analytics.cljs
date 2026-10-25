(ns proxx.runtime.usage-analytics
  "JS facade over proxx.analytics.usage for the dashboard routes. Entries and
  contexts are converted to wire data (undefined fields dropped); reports are
  written back key by key in the order the TypeScript route produced, with
  `null` for present-but-nil fields."
  (:require [proxx.analytics.usage :as usage]))

(defn- shallow [^js o]
  (reduce (fn [m k] (let [v (aget o k)] (if (undefined? v) m (assoc m k v)))) {} (js-keys o)))

(defn- ->wire [x]
  (cond
    (undefined? x) nil
    (array? x) (mapv ->wire x)
    (object? x) (reduce (fn [m k] (let [v (aget x k)] (if (undefined? v) m (assoc m k (->wire v))))) {} (js-keys x))
    :else x))

(defn- entries->wire [entries] (into [] (map shallow) (array-seq entries)))

(defn- emit
  "Object with the present keys of `m`, in `order`; nested values via `sub`."
  ([m order] (emit m order {}))
  ([m order sub]
   (let [o #js {}]
     (doseq [k order]
       (when (contains? m k)
         (let [v (get m k) f (get sub k)]
           (aset o k (cond (and f (some? v)) (f v) :else v)))))
     o)))

(def ^:private routing-order ["local" "federated" "bridge" "distinctPeers" "topPeer"])
(def ^:private tier-order ["fastMode" "priority" "standard"])
(def ^:private coverage-order ["requestedWindowStart" "coverageStart" "hasFullWindowCoverage" "retainedEntryCount" "maxRetainedEntries"])
(def ^:private summary-order
  ["requests24h" "tokens24h" "promptTokens24h" "completionTokens24h" "cachedPromptTokens24h" "imageCount24h"
   "imageCostUsd24h" "costUsd24h" "energyJoules24h" "waterEvaporatedMl24h" "cacheKeyUses24h" "cacheHitRate24h"
   "errorRate24h" "topModel" "topProvider" "activeAccounts" "routingRequests24h" "serviceTierRequests24h"])
(def ^:private account-order
  ["accountId" "displayName" "providerId" "authType" "planType" "status" "requestCount" "totalTokens" "promptTokens"
   "completionTokens" "cachedPromptTokens" "imageCount" "imageCostUsd" "costUsd" "energyJoules" "waterEvaporatedMl"
   "cacheHitCount" "cacheKeyUseCount" "avgDecodeTps" "avgTtftMs" "avgTps" "avgEndToEndTps" "healthScore"
   "transientDebuff" "lastUsedAt"])
(def ^:private row-order
  ["providerId" "model" "requestCount" "errorCount" "errorRate" "totalTokens" "promptTokens" "completionTokens"
   "cachedPromptTokens" "cacheHitRate" "avgTtftMs" "avgDecodeTps" "avgTps" "avgEndToEndTps" "costUsd" "energyJoules"
   "waterEvaporatedMl" "firstSeenAt" "lastSeenAt" "providerCoverageCount" "modelCoverageCount" "confidenceScore"
   "suitabilityScore"])

(defn- points [ps] (to-array (map (fn [p] #js {:t (get p "t") :v (get p "v")}) ps)))

(defn- overview->js [r]
  (emit r ["window" "generatedAt" "coverage" "summary" "trends" "accounts"]
        {"coverage" #(emit % coverage-order)
         "summary" #(emit % summary-order {"routingRequests24h" (fn [x] (emit x routing-order))
                                           "serviceTierRequests24h" (fn [x] (emit x tier-order))})
         "trends" (fn [t] #js {:requests (points (get t "requests")) :tokens (points (get t "tokens")) :errors (points (get t "errors"))})
         "accounts" (fn [as] (to-array (map #(emit % account-order) as)))}))

(defn- analytics->js [r]
  (let [rows (fn [xs] (to-array (map #(emit % row-order) xs)))]
    (emit r ["window" "generatedAt" "coverage" "models" "providers" "providerModels"]
          {"coverage" #(emit % coverage-order) "models" rows "providers" rows "providerModels" rows})))

(defn usage-to-window-js [v] (usage/to-usage-window v))
(defn usage-to-safe-limit-js [v fallback max-value] (usage/to-safe-limit v fallback max-value))

(defn usage-window-config-js [window now]
  (let [{:keys [bucket-ms bucket-count bucket-window-start entry-window-start]} (usage/window-config window now)]
    #js {:bucketMs bucket-ms :bucketCount bucket-count :bucketWindowStart bucket-window-start
         :entryWindowStart entry-window-start}))

(defn usage-overview-from-entries-js [entries ctx]
  (overview->js (usage/overview-from-entries (entries->wire entries) (->wire ctx))))

(defn usage-overview-from-rollups-js [input]
  (let [w (->wire input)
        w (assoc w "entries" (entries->wire (aget input "entries")))]
    (overview->js (usage/overview-from-rollups w))))

(defn usage-analytics-from-entries-js [entries ctx]
  (analytics->js (usage/analytics-from-entries (entries->wire entries) (->wire ctx))))

(defn usage-analytics-from-rollups-js [input]
  (let [w (->wire input)
        w (assoc w "entries" (entries->wire (aget input "entries")))]
    (analytics->js (usage/analytics-from-rollups w))))

(defn usage-scope-active-js [scope] (usage/scope-active? (when scope (shallow scope))))

(defn usage-filter-entries-js
  "The entries (same objects) that fall inside `scope`."
  [entries scope]
  (let [s (when scope (shallow scope))
        pick (fn [^js e] {"tenantId" (aget e "tenantId") "issuer" (aget e "issuer") "keyId" (aget e "keyId")})]
    (.filter entries (fn [e] (usage/entry-matches-scope? (into {} (remove (comp nil? val)) (pick e)) s)))))

(defn usage-summarize-routing-js [entries]
  (emit (usage/summarize-routing (entries->wire entries)) routing-order))
