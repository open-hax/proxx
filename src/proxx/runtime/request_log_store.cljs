(ns proxx.runtime.request-log-store
  "The request log store (formerly RequestLogStore): the JSONL journal, its
  metadata file, compaction, quarantine of corrupt input, subscribers and the
  SQL mirror. The ledger and every report are proxx.runtime.request-log (over
  proxx.analytics.request-log); this namespace sequences the file effects.

  State is one atom of plain values (`:pending` journal entries, counters,
  flags); the persist and mirror chains are promise chains held in atoms.
  File formats are persisted contracts, kept byte-for-byte: the journal is one
  `JSON.stringify(entry)` per line; the metadata file is the pretty-printed
  (2 spaces) bucket snapshot, written via temp file then rename."
  (:require ["node:crypto" :as crypto]
            ["node:fs" :as fs]
            ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            ["node:readline" :as readline]
            [clojure.string :as str]
            [proxx.jsval :as j]
            [proxx.runtime.policy-manifest :as policy-manifest]
            [proxx.runtime.pricing :as pricing]
            [proxx.runtime.request-log :as request-log]))

;; ---------------------------------------------------------------------------
;; Pure path helpers
;; ---------------------------------------------------------------------------

(defn- uuid [] (.randomUUID crypto))

(defn- sibling [file-path name] (.join path (.dirname path file-path) name))

(defn- temp-path [file-path]
  (sibling file-path (str "." (.basename path file-path) "." js/process.pid "." (uuid) ".tmp")))

(defn- suffixed-path [file-path tag]
  (sibling file-path (str (.basename path file-path) "." tag "-" (js/Date.now) "-" js/process.pid "-" (uuid))))

(defn- corrupt-path [file-path] (suffixed-path file-path "corrupt"))
(defn- migrated-path [file-path] (suffixed-path file-path "migrated"))

(defn- legacy-path [file-path]
  (when (str/ends-with? file-path ".jsonl") (subs file-path 0 (dec (count file-path)))))

(defn- metadata-path [file-path]
  (cond (str/ends-with? file-path ".jsonl") (str (subs file-path 0 (- (count file-path) 6)) ".meta.json")
        (str/ends-with? file-path ".json") (str (subs file-path 0 (- (count file-path) 5)) ".meta.json")
        :else (str file-path ".meta.json")))

(defn- serialize-entry [entry] (str (js/JSON.stringify entry) "\n"))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))
(defn- error-code [e] (when (and (some? e) (object? e)) (.-code ^js e)))
(defn- syntax-error? [e] (instance? js/SyntaxError e))

(def ^:private empty-metadata
  (fn [] #js {"hourlyBuckets" #js [] "dailyBuckets" #js [] "dailyModelBuckets" #js []
              "dailyAccountBuckets" #js [] "accountAccumulators" #js []}))

(def ^:private water-ml-per-kwh
  (js/Number (let [v (aget js/process.env "DC_WATER_USE_EFFICIENCY_ML_PER_KWH")] (if (nil? v) "1800" v))))

(defn- estimate-request-cost [provider-id model prompt completion]
  (pricing/estimate-request-cost-js (policy-manifest/policy-manifest-path) provider-id model prompt completion water-ml-per-kwh))

;; ---------------------------------------------------------------------------
;; Edge
;; ---------------------------------------------------------------------------

(defn- reset-state! [{:keys [core st]}]
  (.reset ^js core)
  (swap! st assoc :pending [] :journal-lines 0 :needs-compaction? false))

(defn- snapshot-metadata [^js core]
  #js {"hourlyBuckets" (.hourlyBuckets core) "dailyBuckets" (.dailyBuckets core)
       "dailyModelBuckets" (.dailyModelBuckets core) "dailyAccountBuckets" (.dailyAccountBuckets core)
       "accountAccumulators" (.accountAccumulators core)})

(defn- ^:async persist-metadata! [{:keys [file-path core]}]
  (let [meta-path (metadata-path file-path)
        temp (temp-path meta-path)]
    (try
      (await (.writeFile fsp temp (js/JSON.stringify (snapshot-metadata core) nil 2) "utf8"))
      (await (.rename fsp temp meta-path))
      (catch :default e
        (await (.catch (.rm fsp temp #js {:force true}) (fn [_] nil)))
        (throw e)))))

(defn- should-compact? [{:keys [core st]} force?]
  (let [{:keys [needs-compaction? journal-lines pending]} @st]
    (.shouldCompactJournal ^js core force? needs-compaction? journal-lines (count pending))))

(defn- ^:async persist-now! [{:keys [file-path core st] :as ctx} force-compact?]
  (await (.mkdir fsp (.dirname path file-path) #js {:recursive true}))
  (if (should-compact? ctx force-compact?)
    (let [temp (temp-path file-path)
          snapshot (.snapshot ^js core)
          pending-before (:pending @st)]
      (swap! st assoc :pending [])
      (try
        (await (.writeFile fsp temp (apply str (map serialize-entry (array-seq snapshot))) "utf8"))
        (await (.rename fsp temp file-path))
        (swap! st assoc :journal-lines (.-length snapshot) :needs-compaction? false)
        (await (persist-metadata! ctx))
        (catch :default e
          (swap! st update :pending #(into (vec pending-before) %))
          (await (.catch (.rm fsp temp #js {:force true}) (fn [_] nil)))
          (throw e))))
    (if (empty? (:pending @st))
      (await (persist-metadata! ctx))
      (let [pending-entries (:pending @st)]
        (swap! st assoc :pending [])
        (try
          (await (.appendFile fsp file-path (apply str (map serialize-entry pending-entries)) "utf8"))
          (swap! st update :journal-lines + (count pending-entries))
          (await (persist-metadata! ctx))
          (catch :default e
            (swap! st update :pending #(into (vec pending-entries) %))
            (throw e)))))))

(defn- ^:async queue-persist! [{:keys [st persist-chain] :as ctx} force?]
  (reset! persist-chain
          (.then (.catch @persist-chain (fn [_] js/undefined))
                 (fn ^:async step []
                   (when (or force? (:persist-pending? @st))
                     (swap! st assoc :persist-pending? false)
                     (await (persist-now! ctx force?))))))
  (await @persist-chain))

(defn- schedule-persist! [{:keys [st persist-ms] :as ctx}]
  (when-not (:closed? @st)
    (swap! st assoc :persist-pending? true)
    (when-not (:timer @st)
      (if (zero? persist-ms)
        (queue-persist! ctx false)
        (let [t (js/setTimeout (fn [] (swap! st assoc :timer nil) (queue-persist! ctx false)) persist-ms)]
          (when (fn? (.-unref t)) (.unref t))
          (swap! st assoc :timer t))))))

(defn- note-mirror-failure! [{:keys [st]} stage error]
  (swap! st update :mirror-failures inc)
  (let [now (js/Date.now)
        {:keys [mirror-failures last-warning]} @st
        warn? (or (<= mirror-failures 3) (= mirror-failures 5) (= mirror-failures 10) (>= (- now last-warning) 60000))]
    (when warn?
      (swap! st assoc :last-warning now)
      (js/console.warn (str "[request-log-store] mirror " stage " failed (#" mirror-failures "): " (error-message error))))))

(defn- queue-mirror! [{:keys [^js mirror mirror-chain] :as ctx} entry]
  (when mirror
    (reset! mirror-chain
            (-> @mirror-chain
                (.then (fn ^:async step [] (await (.upsertEntry mirror entry)) js/undefined))
                (.catch (fn [error] (note-mirror-failure! ctx "upsert" error)))))))

(defn- emit! [{:keys [st]} event]
  (doseq [listener (:subscribers @st)]
    (try (listener event) (catch :default _ nil))))

(defn- ^:async apply-loaded-db! [{:keys [^js core ^js mirror] :as ctx} raw]
  (reset-state! ctx)
  (let [repaired (.load core raw estimate-request-cost)]
    (when mirror
      (doseq [^js entry (array-seq repaired)]
        (try (await (.upsertEntry mirror entry))
             (catch :default error
               (js/console.warn (str "[request-log-store] Failed to mirror repaired entry " (.-id entry) ": " (error-message error)))))))))

(defn- ^:async quarantine-corrupt-file! [{:keys [] :as ctx} source-path error]
  (let [corrupt (corrupt-path source-path)]
    (try
      (await (.rename fsp source-path corrupt))
      (js/console.warn (str "[request-log-store] Failed to parse request logs from " source-path "; moved corrupt file to " corrupt ": " (.-message error)))
      (catch :default rename-error
        (when-not (= "ENOENT" (error-code rename-error)) (throw rename-error))
        (js/console.warn (str "[request-log-store] Failed to parse request logs from " source-path "; file disappeared before quarantine: " (.-message error)))))
    (reset-state! ctx)
    (await (persist-now! ctx true))))

(defn- ^:async quarantine-corrupt-lines! [_ctx source-path lines]
  (when (pos? (count lines))
    (let [corrupt (corrupt-path source-path)]
      (await (.writeFile fsp corrupt (str (str/join "\n" lines) "\n") "utf8"))
      (js/console.warn (str "[request-log-store] Ignored " (count lines) " malformed JSONL request log lines from " source-path "; wrote them to " corrupt)))))

(defn- ^:async quarantine-corrupt-metadata! [{:keys [file-path]} error]
  (let [meta-path (metadata-path file-path)
        corrupt (corrupt-path meta-path)]
    (try
      (await (.rename fsp meta-path corrupt))
      (js/console.warn (str "[request-log-store] Failed to parse request log metadata from " meta-path "; moved corrupt file to " corrupt ": " (.-message error)))
      (catch :default rename-error
        (when-not (= "ENOENT" (error-code rename-error)) (throw rename-error))
        (js/console.warn (str "[request-log-store] Failed to parse request log metadata from " meta-path "; file disappeared before quarantine: " (.-message error)))))))

(defn- ^:async archive-migrated-legacy! [{:keys [file-path]} source-path]
  (when-not (= source-path file-path)
    (let [migrated (migrated-path source-path)]
      (try
        (await (.rename fsp source-path migrated))
        (js/console.info (str "[request-log-store] Migrated legacy request logs from " source-path " to " file-path "; archived original file at " migrated))
        (catch :default error
          (when-not (= "ENOENT" (error-code error)) (throw error)))))))

(defn- ^:async accessible? [file]
  (try (await (.access fsp file)) true
       (catch :default error
         (if (= "ENOENT" (error-code error)) false (throw error)))))

(defn- ^:async resolve-source-path [{:keys [file-path]}]
  (if (await (accessible? file-path))
    file-path
    (when-let [legacy (legacy-path file-path)]
      (when (await (accessible? legacy)) legacy))))

(defn- ^:async load-metadata [{:keys [file-path ^js core] :as ctx}]
  (let [contents (try (await (.readFile fsp (metadata-path file-path) "utf8"))
                      (catch :default error
                        (if (= "ENOENT" (error-code error)) ::missing (throw error))))]
    (if (= ::missing contents)
      (empty-metadata)
      (let [parsed (try (js/JSON.parse contents)
                        (catch :default error
                          (if (syntax-error? error) (do (await (quarantine-corrupt-metadata! ctx error)) ::corrupt) (throw error))))]
        (if (= ::corrupt parsed) (empty-metadata) (.hydrateMetadata core parsed))))))

(defn- ^:async load-entries-from-jsonl [{:keys [^js core max-entries]} source-path]
  (let [by-id (js/Map.)
        malformed (atom [])
        line-count (atom 0)
        input (.createReadStream fs source-path #js {:encoding "utf8"})
        reader (.createInterface readline #js {:input input :crlfDelay js/Infinity})]
    (try
      (let [iterator (.call (aget reader js/Symbol.asyncIterator) reader)]
        (loop []
          (let [^js step (await (.next iterator))]
            (when-not (.-done step)
              (let [raw-line (.-value step)
                    line (.trim raw-line)]
                (when (pos? (.-length line))
                  (swap! line-count inc)
                  (let [parsed (try (js/JSON.parse line) (catch :default _ ::bad))
                        entry (when-not (= ::bad parsed) (.hydrateEntry core parsed))]
                    (if (or (= ::bad parsed) (not (j/truthy? entry)))
                      (swap! malformed conj raw-line)
                      (let [had? (.has by-id (.-id ^js entry))]
                        (.set by-id (.-id ^js entry) entry)
                        (when (and (not had?) (> (.-size by-id) max-entries))
                          (let [oldest (.-value (.next (.keys by-id)))]
                            (when (string? oldest) (.delete by-id oldest))))))))
                (recur))))))
      (finally
        (.close reader)
        (.close input)))
    {:entries (js/Array.from (.values by-id)) :malformed @malformed :line-count @line-count}))

(defn- ^:async load-legacy-db! [{:keys [^js core st] :as ctx} source-path]
  (let [contents (await (.readFile fsp source-path "utf8"))
        parsed (try (js/JSON.parse contents)
                    (catch :default error
                      (if (syntax-error? error)
                        (do (await (quarantine-corrupt-file! ctx source-path error)) ::corrupt)
                        (throw error))))]
    (if (= ::corrupt parsed)
      false
      (let [legacy? (or (array? parsed) (and (some? parsed) (object? parsed) (array? (.-entries ^js parsed))))]
        (if-not legacy?
          (do (await (quarantine-corrupt-file! ctx source-path
                                               (js/SyntaxError. "Request log payload is not a valid legacy JSON request log database")))
              false)
          (do (await (apply-loaded-db! ctx parsed))
              (swap! st assoc :journal-lines (.entryCount core))
              true))))))

(defn- ^:async load-from-disk! [{:keys [file-path st] :as ctx}]
  (let [source-path (await (resolve-source-path ctx))]
    (if-not source-path
      (do (await (.mkdir fsp (.dirname path file-path) #js {:recursive true}))
          (await (.writeFile fsp file-path "" "utf8"))
          (await (persist-metadata! ctx)))
      (let [{:keys [entries malformed line-count]} (await (load-entries-from-jsonl ctx source-path))
            legacy-json? (and (zero? (.-length entries)) (pos? (count malformed)))]
        (if legacy-json?
          (when (await (load-legacy-db! ctx source-path))
            (await (persist-now! ctx true))
            (await (archive-migrated-legacy! ctx source-path)))
          (let [^js metadata (await (load-metadata ctx))]
            (await (apply-loaded-db! ctx #js {"entries" entries
                                              "hourlyBuckets" (.-hourlyBuckets metadata)
                                              "dailyBuckets" (.-dailyBuckets metadata)
                                              "dailyModelBuckets" (.-dailyModelBuckets metadata)
                                              "dailyAccountBuckets" (.-dailyAccountBuckets metadata)
                                              "accountAccumulators" (.-accountAccumulators metadata)}))
            (swap! st assoc :journal-lines line-count)
            (cond
              (pos? (count malformed))
              (do (await (quarantine-corrupt-lines! ctx source-path malformed))
                  (await (persist-now! ctx true)))
              (not= source-path file-path)
              (await (persist-now! ctx true)))))))))

(defn create-request-log-store-js
  "A store journaling to `file-path` (max-entries default 1000, persist interval
  default 1000ms), mirroring entries to `mirror` ({upsertEntry, close?}) when given."
  [file-path max-entries persist-interval-ms ^js mirror]
  (let [max-entries (if (nil? max-entries) 1000 max-entries)
        ctx {:file-path file-path :max-entries max-entries
             :persist-ms (if (nil? persist-interval-ms) 1000 persist-interval-ms)
             :mirror (when mirror mirror)
             :core (request-log/create-request-log-core-js max-entries nil)
             :persist-chain (atom (js/Promise.resolve js/undefined))
             :mirror-chain (atom (js/Promise.resolve js/undefined))
             :st (atom {:subscribers [] :pending [] :warmup nil :timer nil :persist-pending? false
                        :mirror-failures 0 :last-warning 0 :journal-lines 0 :needs-compaction? false :closed? false})}
        {:keys [^js core st persist-chain mirror-chain]} ctx
        queue! (fn [entry]
                 (swap! st update :pending conj entry)
                 (schedule-persist! ctx)
                 (queue-mirror! ctx entry))]
    #js {:warmup (fn ^:async warmup []
                   (if-let [p (:warmup @st)]
                     (await p)
                     (let [p (load-from-disk! ctx)]
                       (swap! st assoc :warmup p)
                       (await p)))
                   js/undefined)
         :subscribe (fn [listener]
                      (swap! st update :subscribers conj listener)
                      (fn [] (swap! st update :subscribers (fn [ls] (vec (remove #(identical? % listener) ls)))) js/undefined))
         :record (fn [input]
                   (when (:closed? @st) (throw (js/Error. "request log store is closed")))
                   (let [^js r (.record core input)
                         entry (.-entry r)]
                     (when (.-overflowed r) (swap! st assoc :needs-compaction? true))
                     (swap! st update :pending conj entry)
                     (schedule-persist! ctx)
                     (queue-mirror! ctx entry)
                     (emit! ctx #js {"type" "record" "entry" entry})
                     entry))
         :update (fn [entry-id patch]
                   (if (:closed? @st)
                     js/undefined
                     (let [next (.update core entry-id patch)]
                       (if (undefined? next)
                         js/undefined
                         (do (queue! next)
                             (emit! ctx #js {"type" "update" "entry" next})
                             next)))))
         :refreshDerivedEstimates (fn []
                                    (if (:closed? @st)
                                      0
                                      (let [updated (.refreshDerivedEstimates
                                                     core estimate-request-cost
                                                     (fn [next]
                                                       (swap! st update :pending conj next)
                                                       (queue-mirror! ctx next)
                                                       (emit! ctx #js {"type" "update" "entry" next})))]
                                        (when (pos? updated) (schedule-persist! ctx))
                                        updated)))
         :snapshot (fn [] (.snapshot core))
         :snapshotSinceWithLimit (fn [since-ms limit after] (.snapshotSinceWithLimit core since-ms limit after))
         :snapshotHourlyBuckets (fn [since-ms] (.hourlyBuckets core since-ms))
         :snapshotDailyBuckets (fn [since-ms] (.dailyBuckets core since-ms))
         :snapshotDailyModelBuckets (fn [since-ms] (.dailyModelBuckets core since-ms))
         :snapshotDailyAccountBuckets (fn [since-ms] (.dailyAccountBuckets core since-ms))
         :snapshotAccountAccumulators (fn [] (.accountAccumulators core))
         :getCoverage (fn [] (.coverage core))
         :getPerfSummary (fn [provider-id account-id model upstream-mode] (.perfSummary core provider-id account-id model upstream-mode))
         :getModelPerfSummary (fn [provider-id model upstream-mode] (.modelPerfSummary core provider-id model upstream-mode))
         :close (fn ^:async close []
                  (swap! st assoc :closed? true)
                  (when-let [t (:timer @st)] (js/clearTimeout t) (swap! st assoc :timer nil))
                  (await (queue-persist! ctx true))
                  (await (.catch @persist-chain (fn [_] js/undefined)))
                  (try (await @mirror-chain)
                       (catch :default error (note-mirror-failure! ctx "flush" error)))
                  (when (and mirror (.-close mirror))
                    (try (await (.close mirror))
                         (catch :default error (note-mirror-failure! ctx "close" error))))
                  js/undefined)
         :list (fn [filters] (.list core (if (nil? filters) #js {} filters)))
         :countRequestsSince (fn [since-ms filters] (.countRequestsSince core since-ms (if (nil? filters) #js {} filters)))
         :providerSummary (fn [] (.providerSummary core))}))
