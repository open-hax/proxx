(ns proxx.analytics.request-log
  "The request log as an append-only ledger of facts plus derived aggregates.

  Facts are entries (string-keyed wire maps, absent = undefined). Every number
  a dashboard shows is a fold of entries: `step` folds one entry into the
  indexes (hourly/daily/model/account buckets, account accumulators, perf
  EWMAs), `delta-step` folds a correction to an entry already counted, and
  `rebuild` is `reduce` of `step` over the retained entries. Indexes are
  derived and disposable: the same entries always yield the same report.

    state {:entries [entry ...]
           :hourly okv :daily okv :model okv :account okv :perf okv :acc okv}

  `okv` is an insertion-ordered keyed collection `{:by {} :seq {} :next n}`
  (JavaScript Map semantics: re-setting a key keeps its position), because
  float sums and stable sorts downstream depend on that order.

  Time and identity come in through `env` ({:now (fn []) :uuid (fn [])})."
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Scalars (JavaScript-faithful at the data boundary)

(defn- finite? [v]
  (and (number? v)
       #?(:cljs (js/Number.isFinite v)
          :clj (and (not (Double/isNaN (double v))) (not (Double/isInfinite (double v)))))))

(defn- js-truthy? [v]
  (not (or (nil? v) (false? v) (= v "") (and (number? v) (or (zero? v) (not= v v))))))

(defn- as-string [v] (when (string? v) v))
(defn- as-number [v] (when (finite? v) v))
(defn- trimmed [v] (when (string? v) (str/trim v)))

(defn count-or-nil
  "sanitizeOptionalCount / sanitizeOptionalCost: finite and non-negative."
  [v]
  (when (and (finite? v) (>= v 0)) v))

(defn- short-string
  "Trimmed non-empty string clipped to `max-length` UTF-16 units."
  ([v] (short-string v 240))
  ([v max-length]
   (when (string? v)
     (let [t (str/trim v)]
       (cond (zero? (count t)) nil
             (<= (count t) max-length) t
             :else (subs t 0 max-length))))))

(defn sum-count [v] (if (and (finite? v) (> v 0)) v 0))

(defn- present [m] (into {} (remove (comp nil? val)) m))

(def ^:private hour-ms (* 60 60 1000))
(def ^:private day-ms (* 24 hour-ms))

(defn hour-start [ts] (* (Math/floor (/ ts hour-ms)) hour-ms))
(defn day-start [ts] (* (Math/floor (/ ts day-ms)) day-ms))

(defn locale-compare [a b]
  #?(:cljs (.localeCompare ^string a b) :clj (compare a b)))

(defn- undef-str [v] (if (nil? v) "undefined" (str v)))

(def ^:private nul "\u0000")

;; ---------------------------------------------------------------------------
;; Ordered keyed collection

(def empty-okv {:by {} :seq {} :next 0})

(defn okv-get [c k] (get-in c [:by k]))

(defn okv-assoc [c k v]
  (if (contains? (:by c) k)
    (assoc-in c [:by k] v)
    (-> c (assoc-in [:by k] v) (assoc-in [:seq k] (:next c)) (update :next inc))))

(defn okv-dissoc [c k]
  (-> c (update :by dissoc k) (update :seq dissoc k)))

(defn okv-values
  "Values in insertion order."
  [c]
  (->> (:by c) (sort-by (fn [[k _]] (get (:seq c) k))) (mapv val)))

(defn okv-count [c] (count (:by c)))

(defn okv-entries
  "[[k v] ...] in insertion order."
  [c]
  (->> (:by c) (sort-by (fn [[k _]] (get (:seq c) k))) vec))

(defn- okv-remove-where [c pred]
  (reduce (fn [acc [k v]] (if (pred v) (okv-dissoc acc k) acc)) c (:by c)))

;; ---------------------------------------------------------------------------
;; Entries

(def auth-types #{"api_key" "oauth_bearer" "local" "none"})
(def tier-sources #{"fast_mode" "explicit" "none"})

(def diagnostic-count-keys
  ["messageCount" "inputItemCount" "systemMessageCount" "userMessageCount" "assistantMessageCount"
   "toolMessageCount" "functionCallCount" "functionCallOutputCount" "imageInputCount"
   "instructionsChars" "totalTextChars" "maxTextBlockChars"])
(def diagnostic-flag-keys
  ["hasInstructions" "hasReasoning" "hasCodeFence" "hasXmlLikeTags" "hasOpencodeMarkers" "hasAgentProtocolMarkers"])
(def diagnostic-short-keys ["promptCacheKeyHash" "shapeFingerprint" "textFingerprint" "instructionsFingerprint"])

(defn hydrate-factory-diagnostics
  "Cleaned diagnostics, or nil when `raw` carries no signal."
  [raw]
  (when (or (map? raw) (sequential? raw))
    (let [get* (fn [k] (when (map? raw) (get raw k)))
          fmt (get* "requestFormat")
          request-format (if (#{"responses" "messages" "chat_completions" "unknown"} fmt) fmt "unknown")
          d (present (merge {"requestFormat" request-format}
                            (into {} (map (fn [k] [k (short-string (get* k) 80)])) diagnostic-short-keys)
                            (into {} (map (fn [k] [k (count-or-nil (as-number (get* k)))])) diagnostic-count-keys)
                            (into {} (map (fn [k] [k (let [v (get* k)] (when (boolean? v) v))])) diagnostic-flag-keys)))]
      (when (or (not= request-format "unknown") (> (count d) 1)) d))))

(defn- hydrate-entry-fields [raw id timestamp]
  (let [provider-id (trimmed (as-string (get raw "providerId")))
        account-id (trimmed (as-string (get raw "accountId")))
        model (trimmed (as-string (get raw "model")))
        upstream-mode (trimmed (as-string (get raw "upstreamMode")))
        upstream-path (trimmed (as-string (get raw "upstreamPath")))
        status (as-number (get raw "status"))
        latency (as-number (get raw "latencyMs"))
        service-tier (trimmed (as-string (get raw "serviceTier")))
        tier-source (get raw "serviceTierSource")]
    (when-not (or (not (js-truthy? provider-id)) (not (js-truthy? account-id)) (not (js-truthy? model))
                  (not (js-truthy? upstream-mode)) (not (js-truthy? upstream-path)) (nil? status) (nil? latency))
      (present
       {"id" id
        "timestamp" timestamp
        "tenantId" (short-string (get raw "tenantId") 120)
        "issuer" (short-string (get raw "issuer") 240)
        "keyId" (short-string (get raw "keyId") 160)
        "routeKind" (if (#{"federated" "bridge"} (get raw "routeKind")) (get raw "routeKind") "local")
        "federationOwnerSubject" (short-string (get raw "federationOwnerSubject") 240)
        "routedPeerId" (short-string (get raw "routedPeerId") 160)
        "routedPeerLabel" (short-string (get raw "routedPeerLabel") 240)
        "providerId" provider-id
        "accountId" account-id
        "authType" (if (auth-types (get raw "authType")) (get raw "authType") "none")
        "model" model
        "upstreamMode" upstream-mode
        "upstreamPath" upstream-path
        "status" status
        "latencyMs" latency
        "serviceTier" service-tier
        "serviceTierSource" (cond (tier-sources tier-source) tier-source
                                  (js-truthy? service-tier) "explicit"
                                  :else "none")
        "promptTokens" (count-or-nil (as-number (get raw "promptTokens")))
        "completionTokens" (count-or-nil (as-number (get raw "completionTokens")))
        "totalTokens" (count-or-nil (as-number (get raw "totalTokens")))
        "cachedPromptTokens" (count-or-nil (as-number (get raw "cachedPromptTokens")))
        "imageCount" (count-or-nil (as-number (get raw "imageCount")))
        "imageCostUsd" (count-or-nil (as-number (get raw "imageCostUsd")))
        "promptCacheKeyHash" (short-string (get raw "promptCacheKeyHash") 80)
        "promptCacheKeyUsed" (true? (get raw "promptCacheKeyUsed"))
        "cacheHit" (true? (get raw "cacheHit"))
        "ttftMs" (count-or-nil (as-number (get raw "ttftMs")))
        "tps" (as-number (get raw "tps"))
        "endToEndTps" (as-number (get raw "endToEndTps"))
        "error" (as-string (get raw "error"))
        "upstreamErrorCode" (short-string (get raw "upstreamErrorCode") 80)
        "upstreamErrorType" (short-string (get raw "upstreamErrorType") 80)
        "upstreamErrorMessage" (short-string (get raw "upstreamErrorMessage"))
        "factoryDiagnostics" (hydrate-factory-diagnostics (get raw "factoryDiagnostics"))
        "costUsd" (count-or-nil (as-number (get raw "costUsd")))
        "energyJoules" (count-or-nil (as-number (get raw "energyJoules")))
        "waterEvaporatedMl" (count-or-nil (as-number (get raw "waterEvaporatedMl")))}))))

(defn hydrate-entry
  "Persisted wire map -> entry, or nil when it is not a usable entry.
  Missing id/timestamp are minted from `env` (in that order, only if needed)."
  [raw env]
  (when (map? raw)
    ;; Validate first so identity/clock are only consumed for real entries,
    ;; exactly as the original object literal did.
    (when (hydrate-entry-fields raw nil nil)
      (hydrate-entry-fields raw
                            (or (as-string (get raw "id")) ((:uuid env)))
                            (or (as-number (get raw "timestamp")) ((:now env)))))))

(defn new-entry
  "Entry for a freshly recorded request (`input` is a wire map)."
  [input env]
  (let [id ((:uuid env))
        timestamp (let [t (get input "timestamp")] (if (nil? t) ((:now env)) t))
        tier (get input "serviceTier")]
    (present
     {"id" id
      "timestamp" timestamp
      "tenantId" (short-string (get input "tenantId") 120)
      "issuer" (short-string (get input "issuer") 240)
      "keyId" (short-string (get input "keyId") 160)
      "routeKind" (let [k (get input "routeKind")] (if (nil? k) "local" k))
      "federationOwnerSubject" (short-string (get input "federationOwnerSubject") 240)
      "routedPeerId" (short-string (get input "routedPeerId") 160)
      "routedPeerLabel" (short-string (get input "routedPeerLabel") 240)
      "providerId" (get input "providerId")
      "accountId" (get input "accountId")
      "authType" (get input "authType")
      "model" (get input "model")
      "upstreamMode" (get input "upstreamMode")
      "upstreamPath" (get input "upstreamPath")
      "status" (get input "status")
      "latencyMs" (get input "latencyMs")
      "serviceTier" (let [t (when (string? tier) (str/trim tier))] (when (js-truthy? t) t))
      "serviceTierSource" (let [s (get input "serviceTierSource")]
                            (if (nil? s) (if (js-truthy? tier) "explicit" "none") s))
      "promptTokens" (count-or-nil (get input "promptTokens"))
      "completionTokens" (count-or-nil (get input "completionTokens"))
      "totalTokens" (count-or-nil (get input "totalTokens"))
      "cachedPromptTokens" (count-or-nil (get input "cachedPromptTokens"))
      "imageCount" (count-or-nil (get input "imageCount"))
      "imageCostUsd" (count-or-nil (get input "imageCostUsd"))
      "promptCacheKeyHash" (short-string (get input "promptCacheKeyHash") 80)
      "promptCacheKeyUsed" (true? (get input "promptCacheKeyUsed"))
      "cacheHit" (true? (get input "cacheHit"))
      "ttftMs" (count-or-nil (get input "ttftMs"))
      "tps" (get input "tps")
      "endToEndTps" (get input "endToEndTps")
      "error" (get input "error")
      "upstreamErrorCode" (short-string (get input "upstreamErrorCode") 80)
      "upstreamErrorType" (short-string (get input "upstreamErrorType") 80)
      "upstreamErrorMessage" (short-string (get input "upstreamErrorMessage"))
      "factoryDiagnostics" (hydrate-factory-diagnostics (get input "factoryDiagnostics"))
      "costUsd" (count-or-nil (get input "costUsd"))
      "energyJoules" (count-or-nil (get input "energyJoules"))
      "waterEvaporatedMl" (count-or-nil (get input "waterEvaporatedMl"))})))

(defn patch-entry
  "The entry after applying a late-arriving patch (usage, timings, errors);
  fields the patch does not usefully supply keep their current value."
  [current patch]
  (let [or-current (fn [k v] (if (nil? v) (get current k) v))
        count-field (fn [k] (or-current k (count-or-nil (get patch k))))
        short-field (fn [k n] (or-current k (short-string (get patch k) n)))
        finite-field (fn [k] (let [v (get patch k)] (if (finite? v) v (get current k))))]
    (present
     (assoc current
            "promptTokens" (count-field "promptTokens")
            "completionTokens" (count-field "completionTokens")
            "totalTokens" (count-field "totalTokens")
            "cachedPromptTokens" (count-field "cachedPromptTokens")
            "imageCount" (count-field "imageCount")
            "imageCostUsd" (count-field "imageCostUsd")
            "promptCacheKeyHash" (short-field "promptCacheKeyHash" 80)
            "promptCacheKeyUsed" (or-current "promptCacheKeyUsed" (get patch "promptCacheKeyUsed"))
            "cacheHit" (or-current "cacheHit" (get patch "cacheHit"))
            "ttftMs" (count-field "ttftMs")
            "tps" (finite-field "tps")
            "endToEndTps" (finite-field "endToEndTps")
            "error" (or-current "error" (get patch "error"))
            "upstreamErrorCode" (short-field "upstreamErrorCode" 80)
            "upstreamErrorType" (short-field "upstreamErrorType" 80)
            "upstreamErrorMessage" (short-field "upstreamErrorMessage" 240)
            "factoryDiagnostics" (or-current "factoryDiagnostics" (hydrate-factory-diagnostics (get patch "factoryDiagnostics")))
            "costUsd" (count-field "costUsd")
            "energyJoules" (count-field "energyJoules")
            "waterEvaporatedMl" (count-field "waterEvaporatedMl")))))

(defn entry-error?
  [e]
  (or (>= (get e "status") 400) (string? (get e "error")) (string? (get e "upstreamErrorCode"))))

(defn- counts-toward-cache-key-use? [e] (and (true? (get e "promptCacheKeyUsed")) (not (entry-error? e))))
(defn- counts-toward-cache-hit? [e] (and (true? (get e "cacheHit")) (not (entry-error? e))))

;; ---------------------------------------------------------------------------
;; Buckets

(def core-fields
  ["requestCount" "errorCount" "totalTokens" "promptTokens" "completionTokens" "cachedPromptTokens"
   "imageCount" "imageCostUsd" "cacheHitCount" "cacheKeyUseCount" "fastModeRequestCount"
   "priorityRequestCount" "standardRequestCount" "costUsd" "energyJoules" "waterEvaporatedMl"])
(def perf-fields ["ttftSum" "ttftCount" "tpsSum" "tpsCount" "endToEndTpsSum" "endToEndTpsCount" "lastUsedAtMs"])

(defn- zeros [ks] (into {} (map (fn [k] [k 0])) ks))

(def ^:private kind-fields
  {:hourly core-fields :daily core-fields
   :model (concat core-fields perf-fields) :account (concat core-fields perf-fields)})

(defn- new-bucket [kind ident]
  (merge ident (zeros (kind-fields kind))))

(defn- bucket-ident [kind e start]
  (case kind
    (:hourly :daily) {"startMs" start}
    :model {"startMs" start "providerId" (get e "providerId") "model" (get e "model")}
    :account (present {"startMs" start "tenantId" (get e "tenantId") "issuer" (get e "issuer") "keyId" (get e "keyId")
                       "providerId" (get e "providerId") "accountId" (get e "accountId") "authType" (get e "authType")})))

(defn- bucket-key [kind e start]
  (case kind
    (:hourly :daily) start
    :model (str start nul (undef-str (get e "providerId")) nul (undef-str (get e "model")))
    :account (str start nul (undef-str (get e "providerId")) nul (undef-str (get e "accountId")) nul
                  (or (get e "tenantId") "") nul (or (get e "issuer") "") nul (or (get e "keyId") ""))))

(defn- bucket-start [kind ts] (if (= kind :hourly) (hour-start ts) (day-start ts)))

(defn- prune-cutoff [kind now]
  (if (= kind :hourly)
    (hour-start (- now (* 8 day-ms)))
    (day-start (- now (* 45 day-ms)))))

(defn- prune [state kind now]
  (let [cutoff (prune-cutoff kind now)]
    (update state kind okv-remove-where #(< (get % "startMs") cutoff))))

(defn- add [b k n] (update b k (fnil + 0) n))

(defn- tier-field [e]
  (cond (= (get e "serviceTierSource") "fast_mode") "fastModeRequestCount"
        (= (get e "serviceTier") "priority") "priorityRequestCount"
        :else "standardRequestCount"))

(defn- fold-core [b e]
  (-> b
      (add "requestCount" 1)
      (cond-> (entry-error? e) (add "errorCount" 1))
      (add (tier-field e) 1)
      (add "totalTokens" (sum-count (get e "totalTokens")))
      (add "promptTokens" (sum-count (get e "promptTokens")))
      (add "completionTokens" (sum-count (get e "completionTokens")))
      (add "cachedPromptTokens" (sum-count (get e "cachedPromptTokens")))
      (add "imageCount" (sum-count (get e "imageCount")))
      (add "imageCostUsd" (sum-count (get e "imageCostUsd")))
      (add "costUsd" (sum-count (get e "costUsd")))
      (add "energyJoules" (sum-count (get e "energyJoules")))
      (add "waterEvaporatedMl" (sum-count (get e "waterEvaporatedMl")))
      (cond-> (counts-toward-cache-key-use? e) (add "cacheKeyUseCount" 1))
      (cond-> (counts-toward-cache-hit? e) (add "cacheHitCount" 1))))

(defn- fold-perf [b e]
  (let [obs (fn [b v sum cnt] (if (finite? v) (-> b (add sum v) (add cnt 1)) b))]
    (-> b
        (obs (get e "ttftMs") "ttftSum" "ttftCount")
        (obs (get e "tps") "tpsSum" "tpsCount")
        (obs (get e "endToEndTps") "endToEndTpsSum" "endToEndTpsCount")
        (update "lastUsedAtMs" (fnil max 0) (get e "timestamp")))))

(defn- delta-core [b e prev]
  (let [d (fn [b k] (add b k (- (sum-count (get e k)) (sum-count (get prev k)))))
        flip (fn [b pred k] (if (not= (pred e) (pred prev)) (add b k (if (pred e) 1 -1)) b))]
    (-> b
        (d "totalTokens") (d "promptTokens") (d "completionTokens") (d "cachedPromptTokens")
        (d "imageCount") (d "imageCostUsd") (d "costUsd") (d "energyJoules") (d "waterEvaporatedMl")
        (flip counts-toward-cache-key-use? "cacheKeyUseCount")
        (flip counts-toward-cache-hit? "cacheHitCount"))))

(defn- delta-perf [b e prev]
  (let [first-obs (fn [b k sum cnt]
                    (let [v (get e k)]
                      (if (and (finite? v) (nil? (get prev k))) (-> b (add sum v) (add cnt 1)) b)))]
    (-> b
        (first-obs "ttftMs" "ttftSum" "ttftCount")
        (first-obs "tps" "tpsSum" "tpsCount")
        (first-obs "endToEndTps" "endToEndTpsSum" "endToEndTpsCount")
        (update "lastUsedAtMs" (fnil max 0) (get e "timestamp")))))

(def ^:private bucket-kinds [:hourly :daily :model :account])

(defn- with-bucket [state kind e f]
  (let [start (bucket-start kind (get e "timestamp"))
        k (bucket-key kind e start)
        b (or (okv-get (get state kind) k) (new-bucket kind (bucket-ident kind e start)))]
    (-> state
        (update kind okv-assoc k (f b))
        (prune kind (get e "timestamp")))))

;; ---------------------------------------------------------------------------
;; Account accumulators and the perf index

(defn- acc-key [e]
  (str (undef-str (get e "providerId")) nul (undef-str (get e "accountId")) nul
       (or (get e "tenantId") "") nul (or (get e "issuer") "") nul (or (get e "keyId") "")))

(def ^:private acc-fields
  ["requestCount" "totalTokens" "promptTokens" "completionTokens" "cachedPromptTokens" "imageCount" "imageCostUsd"
   "cacheHitCount" "cacheKeyUseCount" "ttftSum" "ttftCount" "tpsSum" "tpsCount" "endToEndTpsSum" "endToEndTpsCount"
   "lastUsedAtMs" "costUsd" "energyJoules" "waterEvaporatedMl"])

(defn- fold-accumulator [acc e]
  (let [c (fn [v] (or (count-or-nil v) 0))
        obs (fn [a v sum cnt] (if (finite? v) (-> a (add sum v) (add cnt 1)) a))]
    (-> acc
        (add "requestCount" 1)
        (add "totalTokens" (c (get e "totalTokens")))
        (add "promptTokens" (c (get e "promptTokens")))
        (add "completionTokens" (c (get e "completionTokens")))
        (add "cachedPromptTokens" (c (get e "cachedPromptTokens")))
        (add "imageCount" (c (get e "imageCount")))
        (add "imageCostUsd" (c (get e "imageCostUsd")))
        (add "costUsd" (c (get e "costUsd")))
        (add "energyJoules" (c (get e "energyJoules")))
        (add "waterEvaporatedMl" (c (get e "waterEvaporatedMl")))
        (cond-> (counts-toward-cache-hit? e) (add "cacheHitCount" 1))
        (cond-> (counts-toward-cache-key-use? e) (add "cacheKeyUseCount" 1))
        (obs (get e "ttftMs") "ttftSum" "ttftCount")
        (obs (get e "tps") "tpsSum" "tpsCount")
        (obs (get e "endToEndTps") "endToEndTpsSum" "endToEndTpsCount")
        (update "lastUsedAtMs" max (get e "timestamp")))))

(defn- step-accumulator [state e]
  (let [k (acc-key e)
        acc (or (okv-get (:acc state) k)
                (merge (present {"tenantId" (get e "tenantId") "issuer" (get e "issuer") "keyId" (get e "keyId")
                                 "providerId" (get e "providerId") "accountId" (get e "accountId") "authType" (get e "authType")})
                       (zeros acc-fields)))]
    (update state :acc okv-assoc k (fold-accumulator acc e))))

(defn- delta-accumulator [state e prev]
  (let [k (acc-key e)]
    (if-let [acc (okv-get (:acc state) k)]
      (let [c (fn [v] (or (count-or-nil v) 0))
            d (fn [a k] (add a k (- (c (get e k)) (c (get prev k)))))
            flip (fn [a pred k] (if (not= (pred e) (pred prev)) (add a k (if (pred e) 1 -1)) a))
            first-obs (fn [a k sum cnt]
                        (let [v (get e k)] (if (and (finite? v) (nil? (get prev k))) (-> a (add sum v) (add cnt 1)) a)))]
        (assoc-in state [:acc :by k]
                  (-> acc
                      (d "totalTokens") (d "promptTokens") (d "completionTokens") (d "cachedPromptTokens")
                      (d "imageCount") (d "imageCostUsd") (d "costUsd") (d "energyJoules") (d "waterEvaporatedMl")
                      (flip counts-toward-cache-hit? "cacheHitCount")
                      (flip counts-toward-cache-key-use? "cacheKeyUseCount")
                      (first-obs "ttftMs" "ttftSum" "ttftCount")
                      (first-obs "tps" "tpsSum" "tpsCount")
                      (first-obs "endToEndTps" "endToEndTpsSum" "endToEndTpsCount"))))
      state)))

(def ^:private ewma-alpha 0.20)

(defn- perf-key [e]
  (str (undef-str (get e "providerId")) nul (undef-str (get e "accountId")) nul (undef-str (get e "model")) nul (undef-str (get e "upstreamMode"))))

(defn- step-perf [state e]
  (let [k (perf-key e)
        ttft (max 0 (let [t (get e "ttftMs")] (if (finite? t) t (get e "latencyMs"))))
        derived (fn [v]
                  (cond (finite? v) v
                        (and (finite? (get e "completionTokens")) (> (get e "latencyMs") 0))
                        (/ (get e "completionTokens") (/ (get e "latencyMs") 1000))
                        :else nil))
        tps (derived (get e "tps"))
        e2e (derived (get e "endToEndTps"))
        ewma (fn [old new] (+ (* old (- 1 ewma-alpha)) (* new ewma-alpha)))
        existing (okv-get (:perf state) k)]
    (if-not existing
      (update state :perf okv-assoc k {"providerId" (get e "providerId") "accountId" (get e "accountId")
                                       "model" (get e "model") "upstreamMode" (get e "upstreamMode")
                                       "sampleCount" 1 "ewmaTtftMs" ttft "ewmaTps" tps "ewmaEndToEndTps" e2e
                                       "updatedAt" (get e "timestamp")})
      (let [n (inc (get existing "sampleCount"))]
        (update state :perf okv-assoc k
                (cond-> (assoc existing
                               "sampleCount" n
                               "ewmaTtftMs" (if (<= n 1) ttft (ewma (get existing "ewmaTtftMs") ttft))
                               "updatedAt" (max (get existing "updatedAt") (get e "timestamp")))
                  (some? tps) (assoc "ewmaTps" (if (nil? (get existing "ewmaTps")) tps (ewma (get existing "ewmaTps") tps)))
                  (some? e2e) (assoc "ewmaEndToEndTps"
                                     (if (nil? (get existing "ewmaEndToEndTps")) e2e (ewma (get existing "ewmaEndToEndTps") e2e)))))))))

;; ---------------------------------------------------------------------------
;; The fold

(def empty-state
  {:entries [] :hourly empty-okv :daily empty-okv :model empty-okv :account empty-okv :perf empty-okv :acc empty-okv})

(defn step
  "Fold one *new* entry into every index (not into `:entries`)."
  [state e]
  (-> (reduce (fn [s kind] (with-bucket s kind e #(let [b (fold-core % e)]
                                                    (if (#{:model :account} kind) (fold-perf b e) b))))
              state bucket-kinds)
      (step-accumulator e)
      (step-perf e)))

(defn delta-step
  "Fold a correction (`e` replaces `prev`, same entry) into the indexes."
  [state e prev]
  (-> (reduce (fn [s kind] (with-bucket s kind e #(let [b (delta-core % e prev)]
                                                    (if (#{:model :account} kind) (delta-perf b e prev) b))))
              state bucket-kinds)
      (delta-accumulator e prev)
      (step-perf e)))

(defn record
  "[entry state' overflowed?]: append `e` to the retained window and fold it."
  [state e max-entries]
  (let [entries (conj (:entries state) e)
        overflow (- (count entries) max-entries)
        entries (if (pos? overflow) (subvec entries overflow) entries)]
    [e (-> state (assoc :entries entries) (step e)) (pos? overflow)]))

(defn find-index [state entry-id]
  (first (keep-indexed #(when (= (get %2 "id") entry-id) %1) (:entries state))))

(defn update-entry
  "[next state' index] or nil when `entry-id` is not retained."
  [state entry-id patch]
  (when-let [i (find-index state entry-id)]
    (let [current (nth (:entries state) i)
          next (patch-entry current patch)]
      [next (-> state (assoc-in [:entries i] next) (delta-step next current)) i])))

(defn rebuild-indexes
  "Reset every derived index and fold the retained entries back in."
  [state]
  (reduce step (assoc state :hourly empty-okv :daily empty-okv :model empty-okv :account empty-okv :perf empty-okv :acc empty-okv)
          (:entries state)))

(defn- install-persisted
  "Persisted rollups outlive the entries they were built from: when present
  they replace the rebuilt buckets."
  [state {:strs [hourlyBuckets dailyBuckets dailyModelBuckets dailyAccountBuckets]}]
  (let [install (fn [state kind buckets keyf]
                  (if (seq buckets)
                    (assoc state kind (reduce (fn [c b] (okv-assoc c (keyf b) b)) empty-okv buckets))
                    state))]
    (-> state
        (install :hourly hourlyBuckets #(get % "startMs"))
        (install :daily dailyBuckets #(get % "startMs"))
        (install :model dailyModelBuckets #(bucket-key :model % (get % "startMs")))
        (install :account dailyAccountBuckets #(bucket-key :account % (get % "startMs"))))))

(defn- bucket-number [raw k] (or (as-number (get raw k)) 0))

(defn- hydrate-bucket [kind raw]
  (when (map? raw)
    (let [start (as-number (get raw "startMs"))
          provider (trimmed (as-string (get raw "providerId")))
          model (trimmed (as-string (get raw "model")))
          account (trimmed (as-string (get raw "accountId")))
          ok? (and (some? start)
                   (case kind
                     (:hourly :daily) true
                     :model (and (js-truthy? provider) (js-truthy? model))
                     :account (and (js-truthy? provider) (js-truthy? account))))]
      (when ok?
        (merge (case kind
                 (:hourly :daily) {"startMs" start}
                 :model {"startMs" start "providerId" provider "model" model}
                 :account (present {"startMs" start "tenantId" (short-string (get raw "tenantId") 120)
                                    "issuer" (short-string (get raw "issuer") 240) "keyId" (short-string (get raw "keyId") 160)
                                    "providerId" provider "accountId" account
                                    "authType" (if (auth-types (get raw "authType")) (get raw "authType") "none")}))
               (into {} (map (fn [k] [k (bucket-number raw k)])) (kind-fields kind)))))))

(defn hydrate-db
  "Persisted wire data -> {:entries [...] :hourly [...] ...}; sequences, not
  indexes. Entries are clipped to the newest `max-entries`."
  [raw max-entries env]
  (let [empty {:entries [] "hourlyBuckets" [] "dailyBuckets" [] "dailyModelBuckets" [] "dailyAccountBuckets" []}
        entries (fn [xs] (let [es (into [] (keep #(hydrate-entry % env)) xs)]
                           (if (> (count es) max-entries) (subvec es (- (count es) max-entries)) es)))
        buckets (fn [xs kind] (if (sequential? xs) (into [] (keep #(hydrate-bucket kind %)) xs) []))]
    (cond
      (sequential? raw) (assoc empty :entries (entries raw))
      (and (map? raw) (sequential? (get raw "entries")))
      {:entries (entries (get raw "entries"))
       "hourlyBuckets" (buckets (get raw "hourlyBuckets") :hourly)
       "dailyBuckets" (buckets (get raw "dailyBuckets") :daily)
       "dailyModelBuckets" (buckets (get raw "dailyModelBuckets") :model)
       "dailyAccountBuckets" (buckets (get raw "dailyAccountBuckets") :account)}
      :else empty)))

(defn repair-entry
  "Fill zero cost/energy/water from `estimate` ({\"costUsd\" ..}); nil if nothing to fix."
  [e estimate]
  (let [prompt (or (count-or-nil (get e "promptTokens")) 0)
        completion (or (count-or-nil (get e "completionTokens")) 0)]
    (when (or (> prompt 0) (> completion 0))
      (let [missing (fn [k] (zero? (sum-count (get e k))))
            fields ["costUsd" "energyJoules" "waterEvaporatedMl"]
            todo (filter missing fields)]
        (when (seq todo)
          (let [est (estimate (get e "providerId") (get e "model") prompt completion)]
            (reduce (fn [acc k] (assoc acc k (get est k))) e todo)))))))

(defn load-db
  "State from a hydrated db: repair estimates, fold, then let persisted
  rollups win. Returns [state' repaired-entries]."
  [hydrated estimate]
  (let [[entries repaired] (reduce (fn [[out fixed] e]
                                     (if-let [r (repair-entry e estimate)]
                                       [(conj out r) (conj fixed r)]
                                       [(conj out e) fixed]))
                                   [[] []] (:entries hydrated))
        state (rebuild-indexes (assoc empty-state :entries entries))]
    [(install-persisted state hydrated) repaired]))

(defn refresh-estimates
  "Entries whose derived cost/energy/water differ from `estimate`, as
  [index next] pairs in order (apply them one at a time with `update-at`)."
  [state estimate]
  (into []
        (keep-indexed
         (fn [i e]
           (let [prompt (or (count-or-nil (get e "promptTokens")) 0)
                 completion (or (count-or-nil (get e "completionTokens")) 0)]
             (when (or (> prompt 0) (> completion 0))
               (let [est (estimate (get e "providerId") (get e "model") prompt completion)
                     changed? (some (fn [k] (> (abs (- (sum-count (get e k)) (get est k))) 1e-12))
                                    ["costUsd" "energyJoules" "waterEvaporatedMl"])]
                 (when changed?
                   [i (assoc e "costUsd" (get est "costUsd") "energyJoules" (get est "energyJoules")
                             "waterEvaporatedMl" (get est "waterEvaporatedMl"))]))))))
        (:entries state)))

(defn update-at
  "Replace the entry at `i` with `next`, folding the delta. [state' prev]."
  [state i next]
  (let [prev (nth (:entries state) i)]
    [(-> state (assoc-in [:entries i] next) (delta-step next prev)) prev]))

;; ---------------------------------------------------------------------------
;; Reports (pure reads)

(defn- since-ms [v] (if (finite? v) v 0))

(defn- sorted-buckets [okv kind since cmp]
  (->> (okv-values okv) (filter #(>= (get % "startMs") since)) (sort cmp) vec))

(defn hourly-buckets [state since]
  (sorted-buckets (:hourly state) :hourly (since-ms since) #(compare (get %1 "startMs") (get %2 "startMs"))))

(defn daily-buckets [state since]
  (sorted-buckets (:daily state) :daily (since-ms since) #(compare (get %1 "startMs") (get %2 "startMs"))))

(defn- chain [& results] (or (first (remove zero? results)) 0))

(defn model-buckets [state since]
  (sorted-buckets (:model state) :model (since-ms since)
                  (fn [l r] (chain (- (get l "startMs") (get r "startMs"))
                                   (locale-compare (get l "providerId") (get r "providerId"))
                                   (locale-compare (get l "model") (get r "model"))))))

(defn account-buckets [state since]
  (sorted-buckets (:account state) :account (since-ms since)
                  (fn [l r] (chain (- (get l "startMs") (get r "startMs"))
                                   (locale-compare (get l "providerId") (get r "providerId"))
                                   (locale-compare (get l "accountId") (get r "accountId"))
                                   (locale-compare (or (get l "tenantId") "") (or (get r "tenantId") ""))
                                   (locale-compare (or (get l "keyId") "") (or (get r "keyId") ""))))))

(defn accumulators [state] (okv-values (:acc state)))

(defn coverage [state max-entries]
  (let [mn (fn [xs] (when (seq xs) (reduce min xs)))
        starts (fn [okv] (map #(get % "startMs") (vals (:by okv))))]
    {"earliestEntryAtMs" (get (first (:entries state)) "timestamp")
     "earliestHourlyBucketAtMs" (mn (starts (:hourly state)))
     "earliestDailyBucketAtMs" (mn (starts (:daily state)))
     "earliestModelBreakdownAtMs" (mn (starts (:model state)))
     "earliestAccountBreakdownAtMs" (mn (starts (:account state)))
     "retainedEntryCount" (count (:entries state))
     "maxEntries" max-entries}))

(defn perf-summary [state provider-id account-id model upstream-mode]
  (okv-get (:perf state) (str provider-id nul account-id nul model nul upstream-mode)))

(defn model-perf-summary
  "Sample-weighted blend of every account's perf entry for a model/mode."
  [state provider-id model upstream-mode]
  (let [matching (filterv #(and (= (get % "providerId") provider-id) (= (get % "model") model)
                                (= (get % "upstreamMode") upstream-mode))
                          (okv-values (:perf state)))]
    (when (seq matching)
      (let [weight #(max (get % "sampleCount") 1)
            total (reduce + 0 (map weight matching))
            weighted (fn [k] (/ (reduce + 0 (map #(* (get % k) (weight %)) matching)) total))
            nullable (fn [k]
                       (let [cs (filterv #(some? (get % k)) matching)]
                         (when (seq cs)
                           (/ (reduce + 0 (map #(* (get % k) (weight %)) cs))
                              (reduce + 0 (map weight cs))))))]
        {"providerId" provider-id "accountId" "*" "model" model "upstreamMode" upstream-mode
         "sampleCount" total
         "ewmaTtftMs" (weighted "ewmaTtftMs")
         "ewmaTps" (nullable "ewmaTps")
         "ewmaEndToEndTps" (nullable "ewmaEndToEndTps")
         "updatedAt" (reduce max 0 (map #(get % "updatedAt") matching))}))))

;; ---------------------------------------------------------------------------
;; Entry queries

(defn matches-filters? [e filters]
  (every? (fn [k] (or (not (js-truthy? (get filters k))) (= (get e k) (get filters k))))
          ["providerId" "accountId" "tenantId" "issuer" "keyId"]))

(defn- sanitize-limit [limit fallback]
  (if (finite? limit)
    (let [n (Math/floor limit)] (if (<= n 0) fallback n))
    fallback))

(defn list-entries
  "Newest first, at most `limit` (default 200); `before` is an exclusive id cursor."
  [state filters]
  (let [limit (sanitize-limit (get filters "limit") 200)
        entries (:entries state)
        before (get filters "before")
        idx (when (js-truthy? before) (find-index state before))]
    (if (= idx 0)
      []
      (let [source (if (and idx (> idx 0)) (subvec entries 0 idx) entries)]
        (->> source (filter #(matches-filters? % filters)) (take-last limit) reverse vec)))))

(defn count-since [state since filters]
  (count (filter #(and (not (< (get % "timestamp") since)) (matches-filters? % filters)) (:entries state))))

(defn provider-summary
  "{provider {\"count\" n \"lastTimestamp\" ms}} in first-seen order."
  [state]
  (reduce (fn [acc e]
            (let [p (get e "providerId")]
              (if-let [s (get acc p)]
                (assoc acc p {"count" (inc (get s "count")) "lastTimestamp" (max (get s "lastTimestamp") (get e "timestamp"))})
                (assoc acc p {"count" 1 "lastTimestamp" (get e "timestamp")}))))
          {} (:entries state)))

(defn since-with-limit
  "Oldest-first scan from `since` (and after an optional keyset cursor).
  Quirk kept from the original loop: it pushes before it checks the limit, so
  `limit` 0 still yields the first match."
  [state since limit after]
  (let [since (if (finite? since) since 0)
        n (if (finite? limit) (max 0 (Math/floor limit)) (count (:entries state)))]
    (->> (:entries state)
         (remove (fn [e] (< (get e "timestamp") since)))
         (remove (fn [e] (and after
                              (or (< (get e "timestamp") (get after "timestampMs"))
                                  (and (= (get e "timestamp") (get after "timestampMs"))
                                       (<= (compare (get e "id") (get after "id")) 0))))))
         (take (max 1 n))
         vec)))

(defn journal-should-compact?
  "Whether the persisted journal should be rewritten rather than appended to."
  [force? needs-compaction? journal-lines pending max-entries retained]
  (or force?
      (let [projected (+ journal-lines pending)
            stale (max 0 (- projected retained))]
        (or needs-compaction?
            (> projected (max (* max-entries 2) (+ retained 2000)))
            (> stale (max 1000 (Math/floor (/ max-entries 2))))))))
