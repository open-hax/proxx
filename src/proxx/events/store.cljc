(ns proxx.events.store
  "The event table's contract and the pure half of the event store: DDL,
  SQL text and parameters for queries, row -> event mapping, and payload
  sanitising. The SQL text and column names are persisted contracts; they are
  byte-identical to what the TypeScript store issued.

  Filters and events are string-keyed wire maps in which `undefined` is
  absent (so `null` is present). `since`/`until` arrive as ISO strings."
  (:require [clojure.string :as str]))

(def ddl
  "Statements `init` issues, in order."
  ["
      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        kind TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        provider_id TEXT,
        account_id TEXT,
        model TEXT,
        status INTEGER,
        tags JSONB DEFAULT '[]'::jsonb,
        meta JSONB DEFAULT '{}'::jsonb,
        payload JSONB,
        payload_bytes INTEGER
      );
    "
   "CREATE INDEX IF NOT EXISTS idx_events_entry ON events(entry_id);"
   "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);"
   "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);"
   "CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);"
   "CREATE INDEX IF NOT EXISTS idx_events_tags ON events USING GIN(tags);"
   "CREATE INDEX IF NOT EXISTS idx_events_provider_status ON events(provider_id, status);"
   "
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    "])

(def max-payload-bytes (* 2 1024 1024))

(defn- js-truthy? [v]
  (not (or (nil? v) (false? v) (= v "") (= v 0) (and (number? v) (not= v v)))))

;; ---------------------------------------------------------------------------
;; Queries

(defn- conditions
  "[[sql-template value] ...] in the fixed column order; `?` marks the slot
  that is numbered once the whole list is known."
  [filters]
  (let [truthy (fn [k sql] (when (js-truthy? (get filters k)) [sql (get filters k)]))
        defined (fn [k sql] (when (contains? filters k) [sql (get filters k)]))]
    (keep identity
          [(truthy "kind" "kind = $?")
           (truthy "entryId" "entry_id = $?")
           (truthy "providerId" "provider_id = $?")
           (truthy "model" "model = $?")
           (defined "status" "status = $?")
           (defined "statusGte" "status >= $?")
           (defined "statusLt" "status < $?")
           (truthy "tag" "tags ? $?")
           (truthy "since" "ts >= $?")
           (truthy "until" "ts < $?")])))

(defn- numbered [conds]
  (map-indexed (fn [i [sql _]] (str/replace sql "$?" (str "$" (inc i)))) conds))

(defn- where-clause [conds]
  (if (seq conds) (str "WHERE " (str/join " AND " (numbered conds))) ""))

(defn- or-default [v default] (if (nil? v) default v))

(defn build-query
  "{\"text\" \"values\"} for EventStore.query."
  [filters]
  (let [conds (conditions filters)
        n (count conds)
        limit (min (or-default (get filters "limit") 100) 1000)
        offset (or-default (get filters "offset") 0)
        order (if (false? (get filters "orderDesc")) "ASC" "DESC")
        columns (if (js-truthy? (get filters "includePayload"))
                  "*"
                  "id, ts, kind, entry_id, provider_id, account_id, model, status, tags, meta, payload_bytes")]
    {"text" (str "SELECT " columns " FROM events " (where-clause conds)
                 " ORDER BY ts " order " LIMIT $" (+ n 1) " OFFSET $" (+ n 2))
     "values" (conj (mapv second conds) limit offset)}))

(defn build-count
  "{\"text\" \"values\"} for EventStore.count."
  [filters]
  (let [conds (conditions filters)]
    {"text" (str "SELECT COUNT(*) as count FROM events " (where-clause conds))
     "values" (mapv second conds)}))

(defn count-by-tag-query
  "{\"text\" \"values\"}; `since-iso` may be nil."
  [since-iso]
  {"text" (str "SELECT tag, COUNT(*) as count FROM events e, LATERAL jsonb_array_elements_text(e.tags) AS tag "
               "WHERE e.tags IS NOT NULL AND jsonb_typeof(e.tags) = 'array' "
               (if since-iso "AND e.ts >= $1" "")
               " GROUP BY tag ORDER BY count DESC")
   "values" (if since-iso [since-iso] [])})

;; ---------------------------------------------------------------------------
;; Rows

(defn parse-row
  "Row (string-keyed column map) -> event map. JSON columns that arrive as
  text are decoded with `parse-json`; already-decoded values are carried
  through untouched. Null columns are absent in the result, except tags and
  meta which become the platform's `empties` (\"tags\" and \"meta\" values)."
  [row parse-json empties]
  (let [decode (fn [v] (if (string? v) (parse-json v) v))
        opt (fn [m k out v] (if (nil? v) m (assoc m out v)))]
    (-> {"id" (get row "id")
         "ts" (get row "ts")
         "kind" (get row "kind")
         "entryId" (get row "entry_id")
         "tags" (let [t (get row "tags")] (if (nil? t) (get empties "tags") (decode t)))
         "meta" (let [m (get row "meta")] (if (nil? m) (get empties "meta") (decode m)))
         "payload" (let [p (get row "payload")] (if (nil? p) nil (decode p)))}
        (opt "providerId" "providerId" (get row "provider_id"))
        (opt "accountId" "accountId" (get row "account_id"))
        (opt "model" "model" (get row "model"))
        (opt "status" "status" (get row "status"))
        (opt "payloadBytes" "payloadBytes" (get row "payload_bytes")))))

;; ---------------------------------------------------------------------------
;; Payload sanitising

(defn extract-urls
  "Every string value that is an http(s) URL, depth first."
  [v]
  (cond (string? v) (if (re-find #"^https?://" v) [v] [])
        (sequential? v) (into [] (mapcat extract-urls) v)
        (map? v) (into [] (mapcat extract-urls) (vals v))
        :else []))

(defn strip-invalid-json-chars
  "Drop NULs and map U+001F to U+241F in every string value."
  [v]
  (cond (string? v) (-> v (str/replace #"\u0000" "") (str/replace #"\u001F" "␟"))
        (sequential? v) (mapv strip-invalid-json-chars v)
        (map? v) (reduce-kv (fn [m k x] (assoc m k (strip-invalid-json-chars x))) {} v)
        :else v))

(defn sanitize-payload
  "Oversized payloads collapse to a summary; the rest are cleaned.
  `byte-length` maps a payload to the byte size of its JSON encoding."
  [payload byte-length]
  (let [size (byte-length payload)]
    (if (> size max-payload-bytes)
      (let [urls (extract-urls payload)
            messages (get payload "messages")
            input (get payload "input")]
        (cond-> {"_truncated" true "_originalBytes" size}
          (contains? payload "model") (assoc "model" (get payload "model"))
          (sequential? messages) (assoc "_messageCount" (count messages))
          (sequential? input) (assoc "_inputCount" (count input))
          (seq urls) (assoc "_urls" urls)))
      (strip-invalid-json-chars payload))))
