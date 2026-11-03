(ns proxx.runtime.request-log
  "Stateful edge of the request log: one atom holding the immutable ledger
  state of proxx.analytics.request-log, a parallel JS array of the entry
  objects it hands out (so `snapshot` stays a cheap copy), and conversions
  that keep the property order the TypeScript store produced. Persistence,
  subscribers and the SQL mirror are driven by `create-request-log-store-js`
  below, which also owns the file edge (warmup, quarantine, journal, metadata);
  what to do is decided by proxx.analytics.request-log-journal.

  deps (optional): {now: () => ms, uuid: () => string}."
  (:require ["node:fs" :as fs]
            ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            ["node:readline" :as readline]
            [proxx.analytics.request-log :as rl]
            [proxx.analytics.request-log-journal :as journal]
            [proxx.json :as json]))

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

;; ---------------------------------------------------------------------------
;; The store: persistence, mirror and subscribers around the core.

(defn- clock [] (js/Date.now))
(defn- new-uuid [] (js/crypto.randomUUID))
(defn- pid [] js/process.pid)
(defn- err-message [e] (if (instance? js/Error e) (.-message ^js e) (str e)))
(defn- err-code [e] (when (some? e) (.-code ^js e)))
(defn- warn! [s] (js/console.warn s))
(defn- swallow [_] nil)
(defn- path-in [file name] (path/join (path/dirname file) name))
(defn- serialize [entry] (str (js/JSON.stringify entry) "\n"))
(defn- rm-quietly [p] (.catch (fsp/rm p #js {:force true}) swallow))

(defn- empty-metadata []
  #js {:hourlyBuckets #js [] :dailyBuckets #js [] :dailyModelBuckets #js []
       :dailyAccountBuckets #js [] :accountAccumulators #js []})

(declare queue-persist! persist-now! persist-metadata-now!)

(defn- note-mirror-failure! [ctx stage e]
  (let [[warn? s] (journal/mirror-failure @(:mirror-state ctx) (clock))]
    (reset! (:mirror-state ctx) s)
    (when warn? (warn! (journal/mirror-warning stage (:count s) (err-message e))))))

(defn- queue-mirror! [ctx entry]
  (when-let [m (:mirror ctx)]
    (swap! (:mirror-chain ctx)
           (fn [c] (-> c
                       (.then (fn [] (.upsertEntry ^js m entry)))
                       (.catch (fn [e] (note-mirror-failure! ctx "upsert" e) nil)))))))

(defn- emit! [ctx type entry]
  (let [subs @(:subs ctx)]
    (when (seq subs)
      (let [event #js {:type type :entry entry}]
        (doseq [l subs]
          (try (l event) (catch :default _ nil)))))))

(defn- schedule-persist! [ctx]
  (when-not @(:closed ctx)
    (reset! (:persist-pending ctx) true)
    (when-not @(:timer ctx)
      (if (= 0 (:interval ctx))
        (queue-persist! ctx false)
        (let [t (js/setTimeout (fn [] (reset! (:timer ctx) nil) (queue-persist! ctx false)) (:interval ctx))]
          (reset! (:timer ctx) t)
          (when (fn? (.-unref ^js t)) (.unref ^js t)))))))

(defn- ^:async persist-step! [ctx force?]
  (when (or force? @(:persist-pending ctx))
    (reset! (:persist-pending ctx) false)
    (await (persist-now! ctx force?))))

(defn- ^:async queue-persist!
  "Serialise persists on one chain. A failure rejects the caller; the timer
  fires this without awaiting, so a failed background persist is an unhandled
  rejection, as in the original store."
  [ctx force?]
  (reset! (:persist-chain ctx)
          (-> (.catch @(:persist-chain ctx) swallow)
              (.then (fn [] (persist-step! ctx force?)))))
  (await @(:persist-chain ctx)))

(defn- snapshot-metadata [^js core]
  #js {:hourlyBuckets (.hourlyBuckets core) :dailyBuckets (.dailyBuckets core)
       :dailyModelBuckets (.dailyModelBuckets core) :dailyAccountBuckets (.dailyAccountBuckets core)
       :accountAccumulators (.accountAccumulators core)})

(defn- ^:async persist-metadata-now! [ctx]
  (let [mp (journal/metadata-path (:file ctx))
        tmp (path-in mp (journal/temp-name mp (pid) (new-uuid)))]
    (try
      (await (fsp/writeFile tmp (js/JSON.stringify (snapshot-metadata (:core ctx)) nil 2) "utf8"))
      (await (fsp/rename tmp mp))
      (catch :default e
        (await (rm-quietly tmp))
        (throw e)))))

(defn- ^:async persist-now! [ctx force?]
  (let [^js core (:core ctx) file (:file ctx)]
    (await (fsp/mkdir (path/dirname file) #js {:recursive true}))
    (let [[plan j] (journal/persist-plan @(:journal ctx) force? (:max ctx) (.entryCount core))]
      (reset! (:journal ctx) j)
      (case (:op plan)
        :metadata (await (persist-metadata-now! ctx))
        :compact (let [tmp (path-in file (journal/temp-name file (pid) (new-uuid)))
                       snapshot (.snapshot core)]
                   (try
                     (await (fsp/writeFile tmp (apply str (map serialize snapshot)) "utf8"))
                     (await (fsp/rename tmp file))
                     (swap! (:journal ctx) journal/compacted (.-length snapshot))
                     (await (persist-metadata-now! ctx))
                     (catch :default e
                       (swap! (:journal ctx) journal/persist-failed plan)
                       (await (rm-quietly tmp))
                       (throw e))))
        :append (try
                  (await (fsp/appendFile file (apply str (map serialize (:entries plan))) "utf8"))
                  (swap! (:journal ctx) journal/appended plan)
                  (await (persist-metadata-now! ctx))
                  (catch :default e
                    (swap! (:journal ctx) journal/persist-failed plan)
                    (throw e)))))))

(defn- reset-state! [ctx]
  (.reset ^js (:core ctx))
  (reset! (:journal ctx) journal/empty-journal))

(defn- ^:async apply-loaded-db! [ctx raw]
  (reset-state! ctx)
  (let [repaired (.load ^js (:core ctx) raw (:estimate ctx))
        n (.-length repaired)]
    ;; Sync repaired entries to the SQL mirror so analytics see corrected costs.
    (when-let [m (:mirror ctx)]
      (loop [i 0]
        (when (< i n)
          (let [e (aget repaired i)]
            (try (await (.upsertEntry ^js m e))
                 (catch :default err
                   (warn! (journal/repaired-mirror-warning (.-id ^js e) (err-message err))))))
          (recur (inc i)))))))

(defn- ^:async rename-aside!
  "Move `source` to `corrupt`; true if moved, false if it was already gone."
  [source corrupt]
  (try (await (fsp/rename source corrupt)) true
       (catch :default e (if (= "ENOENT" (err-code e)) false (throw e)))))

(defn- ^:async quarantine-corrupt-file! [ctx source ^js error]
  (let [corrupt (path-in source (journal/corrupt-name source (clock) (pid) (new-uuid)))]
    (warn! (if (await (rename-aside! source corrupt))
             (journal/corrupt-file-warning source corrupt (.-message error))
             (journal/vanished-file-warning source (.-message error))))
    (reset-state! ctx)
    (await (persist-now! ctx true))))

(defn- ^:async quarantine-corrupt-metadata! [ctx ^js error]
  (let [mp (journal/metadata-path (:file ctx))
        corrupt (path-in mp (journal/corrupt-name mp (clock) (pid) (new-uuid)))]
    (warn! (if (await (rename-aside! mp corrupt))
             (journal/corrupt-metadata-warning mp corrupt (.-message error))
             (journal/vanished-metadata-warning mp (.-message error))))))

(defn- ^:async quarantine-corrupt-lines! [_ctx source lines]
  (when (seq lines)
    (let [corrupt (path-in source (journal/corrupt-name source (clock) (pid) (new-uuid)))]
      (await (fsp/writeFile corrupt (str (.join (to-array lines) "\n") "\n") "utf8"))
      (warn! (journal/corrupt-lines-warning (count lines) source corrupt)))))

(defn- ^:async archive-migrated! [ctx source]
  (when-not (= source (:file ctx))
    (let [archived (path-in source (journal/migrated-name source (clock) (pid) (new-uuid)))]
      (try
        (await (fsp/rename source archived))
        (js/console.info (journal/migrated-info source (:file ctx) archived))
        (catch :default e
          (when-not (= "ENOENT" (err-code e)) (throw e)))))))

(defn- ^:async file-exists? [p]
  (try (await (fsp/access p)) true
       (catch :default e (if (= "ENOENT" (err-code e)) false (throw e)))))

(defn- ^:async resolve-source-path! [ctx]
  (loop [cs (journal/source-candidates (:file ctx))]
    (when-let [c (first cs)]
      (if (await (file-exists? c)) c (recur (rest cs))))))

(defn- ^:async load-metadata-from-disk! [ctx]
  (let [mp (journal/metadata-path (:file ctx))
        contents (try (await (fsp/readFile mp "utf8"))
                      (catch :default e (if (= "ENOENT" (err-code e)) nil (throw e))))]
    (if (nil? contents)
      (empty-metadata)
      (let [parsed (try #js [(js/JSON.parse contents)]
                        (catch :default e (if (instance? js/SyntaxError e) e (throw e))))]
        (if (array? parsed)
          (.hydrateMetadata ^js (:core ctx) (aget parsed 0))
          (do (await (quarantine-corrupt-metadata! ctx parsed))
              (empty-metadata)))))))

(defn- ^:async read-lines [p]
  (let [input (fs/createReadStream p #js {:encoding "utf8"})
        ^js reader (readline/createInterface #js {:input input :crlfDelay js/Infinity})
        it (.call (aget reader js/Symbol.asyncIterator) reader)]
    (try
      (loop [acc (transient [])]
        (let [^js r (await (.next ^js it))]
          (if (.-done r) (persistent! acc) (recur (conj! acc (.-value r))))))
      (finally
        (.close reader)
        (.close ^js input)))))

(defn- ^:async load-entries-from-jsonl! [ctx source]
  (let [lines (await (read-lines source))
        env {:now clock :uuid new-uuid}]
    (journal/ingest-lines lines (:max ctx) json/parse #(rl/hydrate-entry % env))))

(defn- ^:async load-legacy-db! [ctx source]
  (let [contents (await (fsp/readFile source "utf8"))
        parsed (try #js [(js/JSON.parse contents)]
                    (catch :default e (if (instance? js/SyntaxError e) e (throw e))))]
    (if-not (array? parsed)
      (do (await (quarantine-corrupt-file! ctx source parsed)) false)
      (let [doc (aget parsed 0)]
        (if (journal/legacy-payload? {:array? (array? doc)
                                      :entries-array? (and (object? doc) (array? (aget doc "entries")))})
          (do (await (apply-loaded-db! ctx doc))
              (swap! (:journal ctx) assoc :lines (.entryCount ^js (:core ctx)))
              true)
          (do (await (quarantine-corrupt-file! ctx source (js/SyntaxError. journal/not-a-legacy-database)))
              false))))))

(defn- ^:async load-from-disk! [ctx]
  (let [file (:file ctx)
        source (await (resolve-source-path! ctx))]
    (if-not source
      (do (await (fsp/mkdir (path/dirname file) #js {:recursive true}))
          (await (fsp/writeFile file "" "utf8"))
          (await (persist-metadata-now! ctx)))
      (let [loaded (await (load-entries-from-jsonl! ctx source))]
        (if (journal/looks-like-legacy-json? loaded)
          (when (await (load-legacy-db! ctx source))
            (await (persist-now! ctx true))
            (await (archive-migrated! ctx source)))
          (let [^js meta (await (load-metadata-from-disk! ctx))
                raw (clj->js {"entries" (:entries loaded)})]
            (doseq [k ["hourlyBuckets" "dailyBuckets" "dailyModelBuckets" "dailyAccountBuckets" "accountAccumulators"]]
              (aset raw k (aget meta k)))
            (await (apply-loaded-db! ctx raw))
            (swap! (:journal ctx) assoc :lines (:line-count loaded))
            (loop [steps (journal/post-load-steps loaded (not= source file))]
              (when-let [step (first steps)]
                (case step
                  :quarantine-lines (await (quarantine-corrupt-lines! ctx source (:malformed loaded)))
                  :persist (await (persist-now! ctx true)))
                (recur (rest steps))))))))))

(defn- ^:async close! [ctx]
  (reset! (:closed ctx) true)
  (when-let [t @(:timer ctx)]
    (js/clearTimeout t)
    (reset! (:timer ctx) nil))
  (await (queue-persist! ctx true))
  (await (.catch @(:persist-chain ctx) swallow))
  (try (await @(:mirror-chain ctx))
       (catch :default e (note-mirror-failure! ctx "flush" e)))
  (when-let [m (:mirror ctx)]
    (when (.-close ^js m)
      (try (await (.close ^js m))
           (catch :default e (note-mirror-failure! ctx "close" e))))))

(defn- record! [ctx input]
  (when @(:closed ctx) (throw (js/Error. "request log store is closed")))
  (let [^js r (.record ^js (:core ctx) input)
        entry (.-entry r)]
    (swap! (:journal ctx) journal/queue-entry entry (.-overflowed r))
    (schedule-persist! ctx)
    (queue-mirror! ctx entry)
    (emit! ctx "record" entry)
    entry))

(defn- update! [ctx entry-id patch]
  (if @(:closed ctx)
    js/undefined
    (let [next (.update ^js (:core ctx) entry-id patch)]
      (if (some? next)
        (do (swap! (:journal ctx) journal/queue-entry next)
            (schedule-persist! ctx)
            (queue-mirror! ctx next)
            (emit! ctx "update" next)
            next)
        js/undefined))))

(defn- refresh! [ctx]
  (if @(:closed ctx)
    0
    (let [n (.refreshDerivedEstimates ^js (:core ctx) (:estimate ctx)
                                      (fn [next]
                                        (swap! (:journal ctx) journal/queue-entry next)
                                        (queue-mirror! ctx next)
                                        (emit! ctx "update" next)))]
      (when (> n 0) (schedule-persist! ctx))
      n)))

(def ^:private delegated
  ["snapshot" "snapshotSinceWithLimit" "hourlyBuckets" "dailyBuckets" "dailyModelBuckets"
   "dailyAccountBuckets" "accountAccumulators" "coverage" "perfSummary" "modelPerfSummary"
   "list" "countRequestsSince" "providerSummary"])

(defn create-request-log-store-js
  "opts: {filePath, maxEntries = 1000, persistIntervalMs = 1000, mirror?, estimate}
  where `estimate(providerId, model, prompt, completion)` is the cost estimator and
  `mirror` is {upsertEntry(entry): Promise, close?(): Promise}. Returns the store
  methods: warmup, subscribe, record, update, refreshDerivedEstimates, close, plus
  the core's read side (snapshot, hourlyBuckets, list, ...)."
  [^js opts]
  (let [or-default (fn [v d] (if (some? v) v d))
        max-entries (or-default (aget opts "maxEntries") 1000)
        core (create-request-log-core-js max-entries nil)
        ctx {:file (aget opts "filePath")
             :max max-entries
             :interval (or-default (aget opts "persistIntervalMs") 1000)
             :mirror (aget opts "mirror")
             :estimate (aget opts "estimate")
             :core core
             :journal (atom journal/empty-journal)
             :mirror-state (atom {:count 0 :last-warning-at 0})
             :subs (atom [])
             :persist-chain (atom (js/Promise.resolve))
             :mirror-chain (atom (js/Promise.resolve))
             :timer (atom nil)
             :persist-pending (atom false)
             :closed (atom false)
             :warmup (atom nil)}
        store #js {:warmup (fn [] (or @(:warmup ctx) (reset! (:warmup ctx) (load-from-disk! ctx))))
                   :subscribe (fn [listener]
                                (swap! (:subs ctx) #(if (some (fn [l] (identical? l listener)) %) % (conj % listener)))
                                (fn [] (swap! (:subs ctx) #(vec (remove (fn [l] (identical? l listener)) %)))))
                   :record (fn [input] (record! ctx input))
                   :update (fn [entry-id patch] (update! ctx entry-id patch))
                   :refreshDerivedEstimates (fn [] (refresh! ctx))
                   :close (fn [] (close! ctx))}]
    (doseq [k delegated]
      (aset store k (fn [& args] (.apply (aget core k) core (to-array args)))))
    store))
