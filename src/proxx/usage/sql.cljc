(ns proxx.usage.sql
  "SQL text, parameters and row mapping for the persisted request-usage table.

  Everything here is a persisted contract: table and column names, statement
  text and parameter order are byte-identical to what the TypeScript store
  issued. Executing statements and decoding JSON columns are edge work.

  Rows and entries are shallow string-keyed maps: rows use column names
  (\"timestamp_ms\"), entries use the camelCase names callers know
  (\"timestamp\"). `undefined` fields are absent."
  (:require [clojure.string :as str]))

(def ddl
  "Statements `init` issues, in order."
  [
"
      CREATE TABLE IF NOT EXISTS request_usage_entries (
        id TEXT PRIMARY KEY,
        timestamp_ms BIGINT NOT NULL,
        tenant_id TEXT,
        issuer TEXT,
        key_id TEXT,
        route_kind TEXT NOT NULL DEFAULT 'local',
        federation_owner_subject TEXT,
        routed_peer_id TEXT,
        routed_peer_label TEXT,
        provider_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        model TEXT NOT NULL,
        upstream_mode TEXT NOT NULL,
        upstream_path TEXT NOT NULL,
        status INTEGER NOT NULL,
        latency_ms BIGINT NOT NULL,
        service_tier TEXT,
        service_tier_source TEXT NOT NULL DEFAULT 'none',
        prompt_tokens BIGINT,
        completion_tokens BIGINT,
        total_tokens BIGINT,
        cached_prompt_tokens BIGINT,
        image_count BIGINT,
        image_cost_usd DOUBLE PRECISION,
        prompt_cache_key_hash TEXT,
        prompt_cache_key_used BOOLEAN NOT NULL DEFAULT FALSE,
        cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
        ttft_ms BIGINT,
        tps DOUBLE PRECISION,
        end_to_end_tps DOUBLE PRECISION,
        error TEXT,
        upstream_error_code TEXT,
        upstream_error_type TEXT,
        upstream_error_message TEXT,
        factory_diagnostics JSONB,
        cost_usd DOUBLE PRECISION,
        energy_joules DOUBLE PRECISION,
        water_evaporated_ml DOUBLE PRECISION
      );
    "
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_ts ON request_usage_entries(timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_tenant_ts ON request_usage_entries(tenant_id, timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_account_ts ON request_usage_entries(account_id, timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_issuer_ts ON request_usage_entries(issuer, timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_key_ts ON request_usage_entries(key_id, timestamp_ms DESC, id DESC);"
   "ALTER TABLE request_usage_entries ADD COLUMN IF NOT EXISTS route_kind TEXT NOT NULL DEFAULT 'local';"
   "ALTER TABLE request_usage_entries ADD COLUMN IF NOT EXISTS federation_owner_subject TEXT;"
   "ALTER TABLE request_usage_entries ADD COLUMN IF NOT EXISTS routed_peer_id TEXT;"
   "ALTER TABLE request_usage_entries ADD COLUMN IF NOT EXISTS routed_peer_label TEXT;"
   "ALTER TABLE request_usage_entries ADD COLUMN IF NOT EXISTS prompt_cache_key_hash TEXT;"
   "ALTER TABLE request_usage_entries ADD COLUMN IF NOT EXISTS end_to_end_tps DOUBLE PRECISION;"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_route_ts ON request_usage_entries(route_kind, timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_provider_ts ON request_usage_entries(provider_id, timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_provider_model_ts ON request_usage_entries(provider_id, model, timestamp_ms DESC, id DESC);"
   "CREATE INDEX IF NOT EXISTS idx_request_usage_entries_provider_prompt_cache_hash_ts ON request_usage_entries(provider_id, prompt_cache_key_hash, timestamp_ms DESC, id DESC);"
   ])

(def entry-columns ["id" "timestamp_ms" "tenant_id" "issuer" "key_id" "route_kind" "federation_owner_subject" "routed_peer_id" "routed_peer_label" "provider_id" "account_id" "auth_type" "model" "upstream_mode" "upstream_path" "status" "latency_ms" "service_tier" "service_tier_source" "prompt_tokens" "completion_tokens" "total_tokens" "cached_prompt_tokens" "image_count" "image_cost_usd" "prompt_cache_key_hash" "prompt_cache_key_used" "cache_hit" "ttft_ms" "tps" "end_to_end_tps" "error" "upstream_error_code" "upstream_error_type" "upstream_error_message" "factory_diagnostics" "cost_usd" "energy_joules" "water_evaporated_ml"])

(def max-page-size 5000)

;; ---------------------------------------------------------------------------
;; Small coercions (mirroring the store's database-boundary rules)

(defn- finite? [v]
  (and (number? v)
       #?(:cljs (js/Number.isFinite v)
          :clj (and (not (Double/isNaN (double v))) (not (Double/isInfinite (double v)))))))

(defn- parse-number
  "Number(s) for a string; NaN when it is not numeric."
  [s]
  #?(:cljs (js/Number s)
     :clj (try (Double/parseDouble s) (catch Exception _ ##NaN))))

(defn- numeric-string? [v] (and (string? v) (pos? (count (str/trim v)))))

(defn optional-number [v]
  (cond (finite? v) v
        (numeric-string? v) (let [n (parse-number v)] (when (finite? n) n))))

(defn required-number [v]
  (or (cond (finite? v) v
            (numeric-string? v) (let [n (parse-number v)] (when (finite? n) n)))
      (throw (ex-info (str "Expected numeric database value, got " (if (nil? v) "null" v))
                      {:error/type ::bad-numeric}))))

(defn- optional-string [v] (when (and (string? v) (pos? (count v))) v))

(def ^:private auth-types #{"api_key" "oauth_bearer" "local" "none"})
(def ^:private tier-sources #{"fast_mode" "explicit" "none"})

(defn sanitize-limit
  "Positive integer page size, clamped; `fallback` for anything unusable."
  [limit fallback]
  (if-not (finite? limit)
    fallback
    (let [n (long (Math/floor limit))]
      (if (<= n 0) fallback (min n max-page-size)))))

;; ---------------------------------------------------------------------------
;; Row -> entry

(defn row->entry
  "Entry map (camelCase string keys; absent when the column is null/empty).
  `diagnostics` is the already-decoded factory_diagnostics value."
  [row diagnostics]
  (let [opt-s (fn [k] (optional-string (get row k)))
        opt-n (fn [k] (optional-number (get row k)))
        optional [["tenantId" (opt-s "tenant_id")] ["issuer" (opt-s "issuer")] ["keyId" (opt-s "key_id")]
                  ["federationOwnerSubject" (opt-s "federation_owner_subject")]
                  ["routedPeerId" (opt-s "routed_peer_id")] ["routedPeerLabel" (opt-s "routed_peer_label")]
                  ["serviceTier" (opt-s "service_tier")]
                  ["promptTokens" (opt-n "prompt_tokens")] ["completionTokens" (opt-n "completion_tokens")]
                  ["totalTokens" (opt-n "total_tokens")] ["cachedPromptTokens" (opt-n "cached_prompt_tokens")]
                  ["imageCount" (opt-n "image_count")] ["imageCostUsd" (opt-n "image_cost_usd")]
                  ["promptCacheKeyHash" (opt-s "prompt_cache_key_hash")]
                  ["ttftMs" (opt-n "ttft_ms")] ["tps" (opt-n "tps")] ["endToEndTps" (opt-n "end_to_end_tps")]
                  ["error" (opt-s "error")] ["upstreamErrorCode" (opt-s "upstream_error_code")]
                  ["upstreamErrorType" (opt-s "upstream_error_type")]
                  ["upstreamErrorMessage" (opt-s "upstream_error_message")]
                  ["factoryDiagnostics" diagnostics]
                  ["costUsd" (opt-n "cost_usd")] ["energyJoules" (opt-n "energy_joules")]
                  ["waterEvaporatedMl" (opt-n "water_evaporated_ml")]]
        ;; Required numbers are read in column order so the first bad one is
        ;; the one reported (a map literal gives no evaluation-order promise).
        timestamp (required-number (get row "timestamp_ms"))
        status (required-number (get row "status"))
        latency (required-number (get row "latency_ms"))]
    (into {"id" (get row "id")
           "timestamp" timestamp
           "routeKind" (let [k (get row "route_kind")] (if (#{"federated" "bridge"} k) k "local"))
           "providerId" (get row "provider_id")
           "accountId" (get row "account_id")
           "authType" (let [a (get row "auth_type")] (if (auth-types a) a "none"))
           "model" (get row "model")
           "upstreamMode" (get row "upstream_mode")
           "upstreamPath" (get row "upstream_path")
           "status" status
           "latencyMs" latency
           "serviceTierSource" (let [s (get row "service_tier_source")] (if (tier-sources s) s "none"))
           "promptCacheKeyUsed" (true? (get row "prompt_cache_key_used"))
           "cacheHit" (true? (get row "cache_hit"))}
          (filter (comp some? second))
          optional)))

(defn coverage
  "Coverage summary from the single aggregate row (or none)."
  [row]
  (let [retained (if row (required-number (get row "retained_entry_count")) 0)]
    {"earliestEntryAtMs" (when row (optional-number (get row "earliest_entry_at_ms")))
     "retainedEntryCount" retained
     "maxRetainedEntries" retained}))

;; ---------------------------------------------------------------------------
;; Upsert

(def ^:private entry-key
  {"timestamp_ms" "timestamp" "tenant_id" "tenantId" "issuer" "issuer" "key_id" "keyId"
   "route_kind" "routeKind" "federation_owner_subject" "federationOwnerSubject"
   "routed_peer_id" "routedPeerId" "routed_peer_label" "routedPeerLabel"
   "provider_id" "providerId" "account_id" "accountId" "auth_type" "authType" "model" "model"
   "upstream_mode" "upstreamMode" "upstream_path" "upstreamPath" "status" "status"
   "latency_ms" "latencyMs" "service_tier" "serviceTier" "service_tier_source" "serviceTierSource"
   "prompt_tokens" "promptTokens" "completion_tokens" "completionTokens" "total_tokens" "totalTokens"
   "cached_prompt_tokens" "cachedPromptTokens" "image_count" "imageCount" "image_cost_usd" "imageCostUsd"
   "prompt_cache_key_hash" "promptCacheKeyHash" "prompt_cache_key_used" "promptCacheKeyUsed"
   "cache_hit" "cacheHit" "ttft_ms" "ttftMs" "tps" "tps" "end_to_end_tps" "endToEndTps"
   "error" "error" "upstream_error_code" "upstreamErrorCode" "upstream_error_type" "upstreamErrorType"
   "upstream_error_message" "upstreamErrorMessage" "factory_diagnostics" "factoryDiagnosticsJson"
   "cost_usd" "costUsd" "energy_joules" "energyJoules" "water_evaporated_ml" "waterEvaporatedMl"})

(def ^:private raw-columns #{"id" "timestamp_ms" "route_kind" "provider_id" "account_id" "auth_type" "model"
                             "upstream_mode" "upstream_path" "status" "latency_ms" "service_tier_source"})
(def ^:private boolean-columns #{"prompt_cache_key_used" "cache_hit"})

(def ^:private jsonb-column "factory_diagnostics")

(defn- param [entry col]
  (let [v (get entry (get entry-key col col))]
    (cond (boolean-columns col) (true? v)
          (raw-columns col) v
          :else (if (nil? v) nil v))))

(defn upsert-statement
  "{\"strings\" [...] \"values\" [...]} shaped like a tagged template call:
  `strings` has one more element than `values`. The `entry` carries
  \"factoryDiagnosticsJson\" (already JSON text, or absent)."
  [entry]
  (let [list-sep ",\n        "
        head (str "\n      INSERT INTO request_usage_entries (\n        "
                  (str/join list-sep entry-columns)
                  "\n      ) VALUES (\n        ")
        tail (str "\n      )\n      ON CONFLICT (id) DO UPDATE SET\n        "
                  (str/join list-sep (map #(str % " = EXCLUDED." %) (rest entry-columns)))
                  "\n    ")
        n (count entry-columns)
        between (fn [i] (str (when (= (nth entry-columns i) jsonb-column) "::jsonb") list-sep))]
    {"strings" (vec (concat [head]
                            (map between (range (dec n)))
                            [(str (when (= (peek entry-columns) jsonb-column) "::jsonb") tail)]))
     "values" (mapv #(param entry %) entry-columns)}))

;; ---------------------------------------------------------------------------
;; Queries

(defn- js-truthy? [v]
  (not (or (nil? v) (false? v) (= v "") (= v 0) (and (number? v) (not= v v)))))

(defn- where-parts
  "Conditions and values for the shared filters (+ optional descending cursor)."
  [filters cursor]
  (let [since (get filters "sinceMs")
        eq (fn [k col] (when (js-truthy? (get filters k)) [(str col " = $?") [(get filters k)]]))
        parts (keep identity
                    [(when (finite? since) ["timestamp_ms >= $?" [since]])
                     (eq "providerId" "provider_id")
                     (eq "accountId" "account_id")
                     (eq "tenantId" "tenant_id")
                     (eq "issuer" "issuer")
                     (eq "keyId" "key_id")
                     (when cursor ["(timestamp_ms < $? OR (timestamp_ms = $? AND id < $?))"
                                   [(get cursor "timestampMs") (get cursor "id")]])])]
    parts))

(defn- number-placeholders
  "Replace each `$?` in order with `$n`, numbering across all parts; the
  cursor's repeated first `$?` shares one number (as the original did)."
  [parts]
  (loop [parts parts n 1 out [] values []]
    (if-let [[[sql vs] & more] (seq parts)]
      (if (= (count vs) 2)
        (recur more (+ n 2)
               (conj out (-> sql (str/replace-first "$?" (str "$" n)) (str/replace-first "$?" (str "$" n))
                             (str/replace-first "$?" (str "$" (inc n)))))
               (into values vs))
        (recur more (inc n) (conj out (str/replace sql "$?" (str "$" n))) (into values vs)))
      {"conditions" out "values" values})))

(defn- where-from [filters cursor]
  (let [{conds "conditions" values "values"} (number-placeholders (where-parts filters cursor))]
    {"where" (if (seq conds) (str "WHERE " (str/join " AND " conds)) "") "values" values "conditions" conds}))

(defn list-query
  "{\"text\" \"values\"} for a newest-first page."
  [filters cursor]
  (let [limit (sanitize-limit (get filters "limit") 200)
        {:strs [where values]} (where-from filters cursor)]
    {"text" (str "SELECT " (str/join ", " entry-columns) " FROM request_usage_entries " where
                 " ORDER BY timestamp_ms DESC, id DESC LIMIT " limit)
     "values" values}))

(defn list-since-query
  "{\"text\" \"values\"} for an oldest-first scan after `since-ms` (and an
  optional ascending cursor `after`)."
  [since-ms filters limit after]
  (let [{:strs [values conditions]} (where-from (assoc filters "sinceMs" since-ms) nil)
        n (count values)
        conds (cond-> (vec conditions)
                after (conj (str "(timestamp_ms > $" (inc n) " OR (timestamp_ms = $" (inc n) " AND id > $" (+ n 2) "))")))
        values (cond-> (vec values) after (into [(get after "timestampMs") (get after "id")]))
        where (if (seq conds) (str "WHERE " (str/join " AND " conds)) "")
        limit-clause (if (finite? limit) (str " LIMIT " (sanitize-limit limit max-page-size)) "")]
    {"text" (str "SELECT " (str/join ", " entry-columns) " FROM request_usage_entries " where
                 " ORDER BY timestamp_ms ASC, id ASC" limit-clause)
     "values" values}))

(defn coverage-query [filters]
  (let [{:strs [where values]} (where-from filters nil)]
    {"text" (str "SELECT MIN(timestamp_ms) AS earliest_entry_at_ms, COUNT(*)::BIGINT AS retained_entry_count FROM request_usage_entries " where)
     "values" values}))

(def cursor-query "SELECT id, timestamp_ms FROM request_usage_entries WHERE id = $1 LIMIT 1")

(defn row->cursor
  "Keyset cursor from the cursor lookup row."
  [row]
  {"timestampMs" (required-number (get row "timestamp_ms")) "id" (get row "id")})
