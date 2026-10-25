(ns proxx.runtime.request-log
  "Stateful edge of the request log: one atom holding the immutable ledger
  state of proxx.analytics.request-log, a parallel JS array of the entry
  objects it hands out (so `snapshot` stays a cheap copy), and conversions
  that keep the property order the TypeScript store produced. Persistence,
  subscribers and the SQL mirror stay in TypeScript, which drives this facade.

  deps (optional): {now: () => ms, uuid: () => string}."
  (:require [proxx.analytics.request-log :as rl]))

(defn- ->wire [x]
  (cond
    (undefined? x) nil
    (array? x) (mapv ->wire x)
    (object? x) (reduce (fn [m k] (let [v (aget x k)] (if (undefined? v) m (assoc m k (->wire v)))))
                        {} (js-keys x))
    :else x))

(defn- ordered [m order]
  (let [o #js {}]
    (doseq [k order] (let [v (get m k)] (when (some? v) (aset o k v))))
    o))

(defn- nullable-ordered [m order]
  (let [o #js {}]
    (doseq [k order] (aset o k (get m k)))
    o))

(def ^:private diagnostics-order
  ["requestFormat" "promptCacheKeyHash" "shapeFingerprint" "messageCount" "inputItemCount" "systemMessageCount"
   "userMessageCount" "assistantMessageCount" "toolMessageCount" "functionCallCount" "functionCallOutputCount"
   "imageInputCount" "hasInstructions" "instructionsChars" "totalTextChars" "maxTextBlockChars" "hasReasoning"
   "hasCodeFence" "hasXmlLikeTags" "hasOpencodeMarkers" "hasAgentProtocolMarkers" "textFingerprint"
   "instructionsFingerprint"])

(def ^:private entry-order
  ["id" "timestamp" "tenantId" "issuer" "keyId" "routeKind" "federationOwnerSubject" "routedPeerId"
   "routedPeerLabel" "providerId" "accountId" "authType" "model" "upstreamMode" "upstreamPath" "status"
   "latencyMs" "serviceTier" "serviceTierSource" "promptTokens" "completionTokens" "totalTokens"
   "cachedPromptTokens" "imageCount" "imageCostUsd" "promptCacheKeyHash" "promptCacheKeyUsed" "cacheHit"
   "ttftMs" "tps" "endToEndTps" "error" "upstreamErrorCode" "upstreamErrorType" "upstreamErrorMessage"
   "factoryDiagnostics" "costUsd" "energyJoules" "waterEvaporatedMl"])

(defn- entry->js [e]
  (let [o #js {}]
    (doseq [k entry-order]
      (let [v (get e k)]
        (when (some? v)
          (aset o k (if (= k "factoryDiagnostics") (ordered v diagnostics-order) v)))))
    o))

(def ^:private counters
  ["requestCount" "errorCount" "totalTokens" "promptTokens" "completionTokens" "cachedPromptTokens" "imageCount"
   "imageCostUsd" "cacheHitCount" "cacheKeyUseCount" "fastModeRequestCount" "priorityRequestCount"
   "standardRequestCount"])
(def ^:private tail ["costUsd" "energyJoules" "waterEvaporatedMl"])
(def ^:private perf ["ttftSum" "ttftCount" "tpsSum" "tpsCount" "endToEndTpsSum" "endToEndTpsCount" "lastUsedAtMs"])

(def ^:private order-hourly (vec (concat ["startMs"] counters tail)))
(def ^:private order-model (vec (concat ["startMs" "providerId" "model"] counters perf tail)))
(def ^:private order-account
  (vec (concat ["startMs" "tenantId" "issuer" "keyId" "providerId" "accountId" "authType"] counters perf tail)))
(def ^:private order-acc
  ["tenantId" "issuer" "keyId" "providerId" "accountId" "authType" "requestCount" "totalTokens" "promptTokens"
   "completionTokens" "cachedPromptTokens" "imageCount" "imageCostUsd" "cacheHitCount" "cacheKeyUseCount"
   "ttftSum" "ttftCount" "tpsSum" "tpsCount" "endToEndTpsSum" "endToEndTpsCount" "lastUsedAtMs"
   "costUsd" "energyJoules" "waterEvaporatedMl"])
(def ^:private order-perf
  ["providerId" "accountId" "model" "upstreamMode" "sampleCount" "ewmaTtftMs" "ewmaTps" "ewmaEndToEndTps" "updatedAt"])
(def ^:private order-coverage
  ["earliestEntryAtMs" "earliestHourlyBucketAtMs" "earliestDailyBucketAtMs" "earliestModelBreakdownAtMs"
   "earliestAccountBreakdownAtMs" "retainedEntryCount" "maxEntries"])

(defn- buckets->js [order bs] (to-array (map #(ordered % order) bs)))

(defn- estimator [^js estimate-fn]
  (fn [provider-id model prompt completion]
    (let [^js r (estimate-fn provider-id model prompt completion)]
      {"costUsd" (.-costUsd r) "energyJoules" (.-energyJoules r) "waterEvaporatedMl" (.-waterEvaporatedMl r)})))

(defn- cursor->wire [^js after]
  (when after {"timestampMs" (.-timestampMs after) "id" (.-id after)}))

(defn create-request-log-core-js
  [max-entries ^js deps]
  (let [env {:now (if (and deps (.-now deps)) (.-now deps) (fn [] (js/Date.now)))
             :uuid (if (and deps (.-uuid deps)) (.-uuid deps) (fn [] (js/crypto.randomUUID)))}
        state (atom rl/empty-state)
        cache (atom #js [])
        trim! (fn [] (let [n (.-length @cache)] (when (> n max-entries) (.splice @cache 0 (- n max-entries)))))
        reset-cache! (fn [entries] (reset! cache (to-array (map entry->js entries))))]
    #js {:record
         (fn [input]
           (let [e (rl/new-entry (->wire input) env)
                 [_ s overflowed?] (rl/record @state e max-entries)
                 ej (entry->js e)]
             (reset! state s)
             (.push @cache ej)
             (trim!)
             #js {:entry ej :overflowed overflowed?}))

         :update
         (fn [entry-id patch]
           (if-let [[next s i] (rl/update-entry @state entry-id (->wire patch))]
             (let [ej (entry->js next)]
               (reset! state s)
               (aset @cache i ej)
               ej)
             js/undefined))

         :refreshDerivedEstimates
         (fn [estimate-fn on-updated]
           (let [pairs (rl/refresh-estimates @state (estimator estimate-fn))]
             (doseq [[i next] pairs]
               (let [[s _] (rl/update-at @state i next)
                     ej (entry->js next)]
                 (reset! state s)
                 (aset @cache i ej)
                 (on-updated ej)))
             (count pairs)))

         :load
         (fn [raw estimate-fn]
           (let [hydrated (rl/hydrate-db (->wire raw) max-entries env)
                 [s repaired] (rl/load-db hydrated (estimator estimate-fn))]
             (reset! state s)
             (reset-cache! (:entries s))
             (to-array (map entry->js repaired))))

         :hydrateEntry
         (fn [raw] (if-let [e (rl/hydrate-entry (->wire raw) env)] (entry->js e) nil))

         :hydrateMetadata
         (fn [parsed]
           (let [w (->wire parsed)
                 h (rl/hydrate-db (assoc (if (map? w) w {}) "entries" []) max-entries env)]
             #js {:hourlyBuckets (buckets->js order-hourly (get h "hourlyBuckets"))
                  :dailyBuckets (buckets->js order-hourly (get h "dailyBuckets"))
                  :dailyModelBuckets (buckets->js order-model (get h "dailyModelBuckets"))
                  :dailyAccountBuckets (buckets->js order-account (get h "dailyAccountBuckets"))
                  :accountAccumulators #js []}))

         :reset (fn [] (reset! state rl/empty-state) (reset! cache #js []) nil)
         :entryCount (fn [] (.-length @cache))
         :snapshot (fn [] (.slice @cache))
         :snapshotSinceWithLimit
         (fn [since limit after]
           (to-array (map entry->js (rl/since-with-limit @state since limit (cursor->wire after)))))
         :hourlyBuckets (fn [since] (buckets->js order-hourly (rl/hourly-buckets @state since)))
         :dailyBuckets (fn [since] (buckets->js order-hourly (rl/daily-buckets @state since)))
         :dailyModelBuckets (fn [since] (buckets->js order-model (rl/model-buckets @state since)))
         :dailyAccountBuckets (fn [since] (buckets->js order-account (rl/account-buckets @state since)))
         :accountAccumulators (fn [] (buckets->js order-acc (rl/accumulators @state)))
         :coverage (fn [] (nullable-ordered (rl/coverage @state max-entries) order-coverage))
         :perfSummary (fn [p a m u]
                        (if-let [s (rl/perf-summary @state p a m u)] (nullable-ordered s order-perf) js/undefined))
         :modelPerfSummary (fn [p m u]
                             (if-let [s (rl/model-perf-summary @state p m u)] (nullable-ordered s order-perf) js/undefined))
         :list (fn [filters] (to-array (map entry->js (rl/list-entries @state (->wire filters)))))
         :countRequestsSince (fn [since filters] (rl/count-since @state since (->wire filters)))
         :providerSummary (fn [] (let [o #js {}]
                                   (doseq [[p s] (rl/provider-summary @state)]
                                     (aset o p #js {:count (get s "count") :lastTimestamp (get s "lastTimestamp")}))
                                   o))
         :shouldCompactJournal (fn [force? needs? lines pending]
                                 (rl/journal-should-compact? force? needs? lines pending max-entries (.-length @cache)))}))

(defn request-log-hydrate-entry-js [raw]
  (let [env {:now (fn [] (js/Date.now)) :uuid (fn [] (js/crypto.randomUUID))}]
    (if-let [e (rl/hydrate-entry (->wire raw) env)] (entry->js e) nil)))
