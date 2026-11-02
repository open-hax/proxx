(ns proxx.analytics.request-log-journal
  "Decisions of the request-log persistence edge (src/lib/request-log-store.ts),
  as pure data transitions. The edge in proxx.runtime.request-log performs the
  file operations; everything it needs to *decide* is here:

  * file naming (temp/corrupt/migrated/legacy/metadata),
  * the journal ledger `{:pending :lines :needs-compaction?}` and the persist
    plan it yields (compact | append | metadata-only) with the success and
    failure transitions,
  * folding a JSONL journal into the retained entry set,
  * the verdicts of the warmup procedure (legacy detection, post-load repairs),
  * the mirror-failure warning throttle,
  * the exact operator-facing log lines.

  No I/O, no clocks, no randomness: time, pid and uuid arrive as arguments."
  (:require [clojure.string :as str]
            [proxx.analytics.request-log :as rl]))

;; ---------------------------------------------------------------------------
;; Names. The edge joins these with the journal's directory.

(defn file-name
  "Final path segment (node:path basename for '/'-separated paths)."
  [path]
  (let [p (str/replace path #"/+$" "")]
    (subs p (inc (.lastIndexOf p "/")))))

(defn temp-name [path pid uuid] (str "." (file-name path) "." pid "." uuid ".tmp"))
(defn corrupt-name [path now pid uuid] (str (file-name path) ".corrupt-" now "-" pid "-" uuid))
(defn migrated-name [path now pid uuid] (str (file-name path) ".migrated-" now "-" pid "-" uuid))

(defn legacy-path
  "The pre-JSONL single-document sibling (`x.jsonl` -> `x.json`), or nil."
  [path]
  (when (str/ends-with? path ".jsonl") (subs path 0 (dec (count path)))))

(defn metadata-path [path]
  (cond
    (str/ends-with? path ".jsonl") (str (subs path 0 (- (count path) 6)) ".meta.json")
    (str/ends-with? path ".json") (str (subs path 0 (- (count path) 5)) ".meta.json")
    :else (str path ".meta.json")))

(defn source-candidates
  "Files that may hold the journal, in preference order."
  [path]
  (cond-> [path] (legacy-path path) (conj (legacy-path path))))

;; ---------------------------------------------------------------------------
;; The journal ledger

(def empty-journal {:pending [] :lines 0 :needs-compaction? false})

(defn queue-entry
  "An entry that must reach the journal; `overflowed?` marks the log as due a
  compaction."
  ([j entry] (queue-entry j entry false))
  ([j entry overflowed?]
   (cond-> (update j :pending conj entry)
     overflowed? (assoc :needs-compaction? true))))

(defn persist-plan
  "[plan journal']. `plan` is {:op :compact :entries pending}, {:op :append
  :entries pending} or {:op :metadata}. Compact and append take the pending
  queue; the plan carries it for rollback."
  [j force? max-entries retained]
  (let [pending (:pending j)
        n (count pending)]
    (cond
      (rl/journal-should-compact? force? (:needs-compaction? j) (:lines j) n max-entries retained)
      [{:op :compact :entries pending} (assoc j :pending [])]

      (zero? n) [{:op :metadata} j]

      :else [{:op :append :entries pending} (assoc j :pending [])])))

(defn appended
  "The journal grew by the plan's entries."
  [j {:keys [entries]}]
  (update j :lines + (count entries)))

(defn compacted
  "The journal was rewritten to `retained` lines."
  [j retained]
  (assoc j :lines retained :needs-compaction? false))

(defn persist-failed
  "The plan's entries go back in front of whatever queued meanwhile."
  [j {:keys [entries]}]
  (update j :pending #(into (vec entries) %)))

;; ---------------------------------------------------------------------------
;; Reading a JSONL journal

(defn- remember [{:keys [by order] :as acc} id entry max-entries]
  (if (contains? by id)
    (assoc-in acc [:by id] entry)
    (let [by (assoc by id entry)
          order (conj order id)]
      (if (> (count by) max-entries)
        (assoc acc :by (dissoc by (peek order)) :order (pop order))
        (assoc acc :by by :order order)))))

(defn- try-parse [parse line]
  (try (parse line)
       (catch #?(:cljs :default :clj Exception) _ ::unparseable)))

(def ^:private empty-queue #?(:cljs cljs.core/PersistentQueue.EMPTY :clj clojure.lang.PersistentQueue/EMPTY))

(defn ingest-lines
  "Fold raw journal lines into {:entries [oldest..newest] :malformed [raw lines]
  :line-count n}. Later lines for an id replace earlier ones in place; once more
  than `max-entries` distinct ids are held the oldest is dropped. `parse` maps a
  line to wire data (throwing when malformed); `hydrate` maps wire data to an
  entry or nil."
  [lines max-entries parse hydrate]
  (let [{:keys [acc malformed n]}
        (reduce (fn [st raw]
                  (let [line (str/trim raw)]
                    (if (zero? (count line))
                      st
                      (let [st (update st :n inc)
                            parsed (try-parse parse line)
                            entry (when-not (= ::unparseable parsed) (hydrate parsed))]
                        (if entry
                          (update st :acc remember (get entry "id") entry max-entries)
                          (update st :malformed conj raw))))))
                {:acc {:by {} :order empty-queue} :malformed [] :n 0}
                lines)]
    {:entries (mapv (:by acc) (:order acc))
     :malformed malformed
     :line-count n}))

;; ---------------------------------------------------------------------------
;; Warmup verdicts

(defn looks-like-legacy-json?
  "A file with no readable entry but unreadable lines is probably the old
  single-document format."
  [{:keys [entries malformed]}]
  (boolean (and (empty? entries) (seq malformed))))

(defn legacy-payload?
  "Parsed legacy documents are an entry array or an object whose `entries` is an
  array. `facts`: {:array? :entries-array?}, read by the edge from the parsed value."
  [{:keys [array? entries-array?]}]
  (boolean (or array? entries-array?)))

(defn post-load-steps
  "What follows a successful load from a journal, in order."
  [{:keys [malformed]} migrated-source?]
  (cond
    (seq malformed) [:quarantine-lines :persist]
    migrated-source? [:persist]
    :else []))

;; ---------------------------------------------------------------------------
;; Mirror failure throttle

(defn mirror-failure
  "[warn? state'] for a failed mirror call. Warn for the first three failures,
  the 5th, the 10th, and at most once a minute after that."
  [{:keys [count last-warning-at] :or {count 0 last-warning-at 0}} now]
  (let [n (inc count)
        warn? (or (<= n 3) (= n 5) (= n 10) (>= (- now last-warning-at) 60000))]
    [warn? {:count n :last-warning-at (if warn? now last-warning-at)}]))

;; ---------------------------------------------------------------------------
;; Operator-facing lines

(def ^:private tag "[request-log-store]")

(defn mirror-warning [stage n message]
  (str tag " mirror " stage " failed (#" n "): " message))

(defn repaired-mirror-warning [id message]
  (str tag " Failed to mirror repaired entry " id ": " message))

(defn corrupt-file-warning [source corrupt message]
  (str tag " Failed to parse request logs from " source "; moved corrupt file to " corrupt ": " message))

(defn vanished-file-warning [source message]
  (str tag " Failed to parse request logs from " source "; file disappeared before quarantine: " message))

(defn corrupt-metadata-warning [source corrupt message]
  (str tag " Failed to parse request log metadata from " source "; moved corrupt file to " corrupt ": " message))

(defn vanished-metadata-warning [source message]
  (str tag " Failed to parse request log metadata from " source "; file disappeared before quarantine: " message))

(defn corrupt-lines-warning [n source corrupt]
  (str tag " Ignored " n " malformed JSONL request log lines from " source "; wrote them to " corrupt))

(defn migrated-info [source target archived]
  (str tag " Migrated legacy request logs from " source " to " target "; archived original file at " archived))

(def not-a-legacy-database "Request log payload is not a valid legacy JSON request log database")
