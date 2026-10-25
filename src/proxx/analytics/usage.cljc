(ns proxx.analytics.usage
  "Dashboard usage numbers as pure folds over request-log entries (or over
  the ledger's persisted rollups).

  Inputs are string-keyed wire data: entries as the request log stores them,
  `providers`/`statuses` as the credential store and key pool report them.
  Outputs are string-keyed maps in which a key is present only when the
  original field was not `undefined`; JSON `null` is `nil`, so the edge emits
  exactly the present keys. Same inputs, same report: nothing here reads a
  clock (`now` is an argument) or a store.

  Accumulators that were JavaScript `Map`s are `okv` values (insertion
  ordered) because float sums and stable sorts depend on that order."
  (:require [clojure.string :as str]
            [proxx.analytics.request-log :as rl]))

;; ---------------------------------------------------------------------------
;; JavaScript-faithful scalars

(defn- finite? [v]
  (and (number? v)
       #?(:cljs (js/Number.isFinite v)
          :clj (and (not (Double/isNaN (double v))) (not (Double/isInfinite (double v)))))))

(defn- truthy? [v]
  (not (or (nil? v) (false? v) (= v "") (and (number? v) (or (zero? v) (not= v v))))))

(defn- num-or
  "JavaScript `a || b || ...` over numbers: the first non-zero, non-NaN
  value, else the last."
  [& xs]
  (or (first (filter truthy? (butlast xs))) (last xs)))

(defn- comparator-result [n] (if (not= n n) 0 n))

(defn usage-count [v] (if (finite? v) v 0))

(defn percentage
  "`part` as a percentage of `total` rounded to two places; 0 when total <= 0."
  [part total]
  (if (<= total 0)
    0
    (let [x (* (/ part total) 100)]
      #?(:cljs (js/Number (.toFixed x 2))
         :clj (/ (Math/round (* x 100.0)) 100.0)))))

(defn iso-from-timestamp [v]
  (when (finite? v)
    #?(:cljs (.toISOString (js/Date. v))
       :clj (str v))))

(defn- locale-compare [a b] (rl/locale-compare a b))

(def ^:private nul "\u0000")
(defn- pair-key [a b] (str a nul b))

(defn- add [m k n] (update m k (fnil + 0) n))

;; ---------------------------------------------------------------------------
;; Query normalisation

(defn to-usage-window [v]
  (cond (#{"weekly" "monthly" "daily"} v) v
        (not (string? v)) "daily"
        :else (let [n (str/lower-case (str/trim v))]
                (cond (#{"month" "monthly" "30d"} n) "monthly"
                      (#{"week" "weekly" "7d"} n) "weekly"
                      :else "daily"))))

(defn to-safe-limit [v fallback max-value]
  (cond (finite? v) (max 1 (min (Math/floor v) max-value))
        (string? v) (let [parsed #?(:cljs (js/parseInt v 10) :clj ##NaN)]
                      (if (finite? parsed) (max 1 (min parsed max-value)) fallback))
        :else fallback))

;; ---------------------------------------------------------------------------
;; Windows

(def ^:private hour-ms (* 60 60 1000))
(def ^:private day-ms (* 24 hour-ms))

(defn bucket-start [timestamp bucket-ms] (* (Math/floor (/ timestamp bucket-ms)) bucket-ms))

(defn window-config [window now]
  (let [bucket-ms (if (= window "daily") hour-ms day-ms)
        bucket-count (case window "monthly" 30 "weekly" 7 24)]
    {:bucket-ms bucket-ms
     :bucket-count bucket-count
     :bucket-window-start (bucket-start (- now (* (dec bucket-count) bucket-ms)) bucket-ms)
     :entry-window-start (- now (* bucket-count bucket-ms))}))

;; ---------------------------------------------------------------------------
;; Entry predicates

(defn- error? [e] (rl/entry-error? e))
(defn- cache-key-use [e] (if (and (true? (get e "promptCacheKeyUsed")) (not (error? e))) 1 0))
(defn- cache-hit [e] (if (and (true? (get e "cacheHit")) (not (error? e))) 1 0))

(defn summarize-routing [entries]
  (let [peer-key (fn [e]
                   (let [label (some-> (get e "routedPeerLabel") (as-> v (when (string? v) (str/trim v))))
                         id (some-> (get e "routedPeerId") (as-> v (when (string? v) (str/trim v))))]
                     (if (truthy? label) label id)))
        {:keys [local federated bridge peers]}
        (reduce (fn [acc e]
                  (let [acc (case (let [k (get e "routeKind")] (if (nil? k) "local" k))
                              "federated" (update acc :federated inc)
                              "bridge" (update acc :bridge inc)
                              (update acc :local inc))
                        k (peer-key e)]
                    (if (truthy? k) (update acc :peers rl/okv-assoc k (inc (or (rl/okv-get (:peers acc) k) 0))) acc)))
                {:local 0 :federated 0 :bridge 0 :peers rl/empty-okv}
                entries)
        top (->> (rl/okv-entries peers)
                 (sort (fn [l r] (comparator-result (num-or (- (second r) (second l)) (locale-compare (first l) (first r))))))
                 first)]
    {"local" local "federated" federated "bridge" bridge
     "distinctPeers" (rl/okv-count peers) "topPeer" (first top)}))

;; ---------------------------------------------------------------------------
;; Account aggregates

(def ^:private agg-zeros
  {"requestCount" 0 "totalTokens" 0 "promptTokens" 0 "completionTokens" 0 "cachedPromptTokens" 0
   "imageCount" 0 "imageCostUsd" 0 "costUsd" 0 "energyJoules" 0 "waterEvaporatedMl" 0
   "cacheHitCount" 0 "cacheKeyUseCount" 0 "ttftSum" 0 "ttftCount" 0 "tpsSum" 0 "tpsCount" 0
   "endToEndTpsSum" 0 "endToEndTpsCount" 0 "lastUsedAtMs" 0})

(defn- new-account-agg [provider-id account-id auth-type]
  (merge {"accountId" account-id "providerId" provider-id "authType" auth-type} agg-zeros))

(defn- obs [a v sum cnt] (if (finite? v) (-> a (add sum v) (add cnt 1)) a))

(defn- fold-account [a e hits uses]
  (-> a
      (add "requestCount" 1)
      (add "totalTokens" (usage-count (get e "totalTokens")))
      (add "promptTokens" (usage-count (get e "promptTokens")))
      (add "completionTokens" (usage-count (get e "completionTokens")))
      (add "cachedPromptTokens" (usage-count (get e "cachedPromptTokens")))
      (add "imageCount" (usage-count (get e "imageCount")))
      (add "imageCostUsd" (usage-count (get e "imageCostUsd")))
      (add "costUsd" (usage-count (get e "costUsd")))
      (add "energyJoules" (usage-count (get e "energyJoules")))
      (add "waterEvaporatedMl" (usage-count (get e "waterEvaporatedMl")))
      (add "cacheHitCount" hits)
      (add "cacheKeyUseCount" uses)
      (obs (get e "ttftMs") "ttftSum" "ttftCount")
      (obs (get e "tps") "tpsSum" "tpsCount")
      (obs (get e "endToEndTps") "endToEndTpsSum" "endToEndTpsCount")
      (update "lastUsedAtMs" max (get e "timestamp"))))

(defn- update-okv [c k default f]
  (rl/okv-assoc c k (f (or (rl/okv-get c k) default))))

(defn- fold-short
  "Two-minute window averages per account."
  [short e now]
  (if (>= (get e "timestamp") (- now (* 2 60 1000)))
    (update-okv short (pair-key (get e "providerId") (get e "accountId"))
                {"ttftSum" 0 "ttftCount" 0 "tpsSum" 0 "tpsCount" 0}
                #(-> % (obs (get e "ttftMs") "ttftSum" "ttftCount") (obs (get e "tps") "tpsSum" "tpsCount")))
    short))

(defn- clamp01 [v] (max 0 (min 1 v)))

(defn- health [agg status short]
  (if (= status "cooldown")
    {:score 0 :debuff 1 :avg-ttft nil :avg-tps nil :avg-e2e nil}
    (let [avg (fn [sum cnt] (when (pos? (get agg cnt)) (/ (get agg sum) (get agg cnt))))
          avg-ttft (avg "ttftSum" "ttftCount")
          avg-tps (avg "tpsSum" "tpsCount")
          avg-e2e (avg "endToEndTpsSum" "endToEndTpsCount")
          recent (rl/okv-get short (pair-key (get agg "providerId") (get agg "accountId")))
          r-ttft (when (and recent (pos? (get recent "ttftCount"))) (/ (get recent "ttftSum") (get recent "ttftCount")))
          r-tps (when (and recent (pos? (get recent "tpsCount"))) (/ (get recent "tpsSum") (get recent "tpsCount")))
          debuff (max (if (and avg-ttft r-ttft (> r-ttft (* avg-ttft 1.3)))
                        (clamp01 (* (- (/ r-ttft avg-ttft) 1) 0.6)) 0)
                      (if (and avg-tps r-tps (< r-tps (* avg-tps 0.7)))
                        (clamp01 (* (- (/ avg-tps (max 1e-9 r-tps)) 1) 0.25)) 0))
          ttft-score (if avg-ttft (/ 1 (+ 1 (/ avg-ttft 800))) 0.5)
          tps-score (if avg-tps (clamp01 (/ avg-tps 50)) 0.5)
          usage-score (clamp01 (/ (Math/log10 (+ 1 (get agg "totalTokens"))) 6))]
      {:score (clamp01 (- (+ (* 0.65 ttft-score) (* 0.25 tps-score) (* 0.10 usage-score)) (* debuff 0.35)))
       :debuff debuff :avg-ttft avg-ttft :avg-tps avg-tps :avg-e2e avg-e2e})))

(defn- account-summary
  [agg status short {:keys [auth-type plan-type]}]
  (let [h (health agg status short)
        p (get agg "providerId") a (get agg "accountId")]
    (cond-> {"accountId" a "displayName" (str p "/" a) "providerId" p
             "authType" auth-type "status" status
             "requestCount" (get agg "requestCount") "totalTokens" (get agg "totalTokens")
             "promptTokens" (get agg "promptTokens") "completionTokens" (get agg "completionTokens")
             "cachedPromptTokens" (get agg "cachedPromptTokens") "imageCount" (get agg "imageCount")
             "imageCostUsd" (get agg "imageCostUsd") "costUsd" (get agg "costUsd")
             "energyJoules" (get agg "energyJoules") "waterEvaporatedMl" (get agg "waterEvaporatedMl")
             "cacheHitCount" (get agg "cacheHitCount") "cacheKeyUseCount" (get agg "cacheKeyUseCount")
             "avgDecodeTps" (:avg-tps h) "avgTtftMs" (:avg-ttft h) "avgTps" (:avg-tps h)
             "avgEndToEndTps" (:avg-e2e h) "healthScore" (:score h) "transientDebuff" (:debuff h)
             "lastUsedAt" (iso-from-timestamp (get agg "lastUsedAtMs"))}
      (some? plan-type) (assoc "planType" plan-type))))

(defn- account-comparator [sort-key]
  (let [by-tokens (fn [a b]
                    (num-or (- (get b "totalTokens") (get a "totalTokens"))
                            (- (get b "requestCount") (get a "requestCount"))
                            (locale-compare (get a "displayName") (get b "displayName"))))]
    (fn [a b]
      (comparator-result
       (case sort-key
         "tokens" (by-tokens a b)
         "requests" (if (not= (get b "requestCount") (get a "requestCount"))
                      (- (get b "requestCount") (get a "requestCount"))
                      (by-tokens a b))
         "ttft" (let [l (or (get a "avgTtftMs") ##Inf) r (or (get b "avgTtftMs") ##Inf)]
                  (if (not= l r) (- l r) (by-tokens a b)))
         ("tps" "decode-tps") (let [l (or (get a "avgTps") ##-Inf) r (or (get b "avgTps") ##-Inf)]
                                (if (not= l r) (- r l) (by-tokens a b)))
         "e2e-tps" (let [l (or (get a "avgEndToEndTps") ##-Inf) r (or (get b "avgEndToEndTps") ##-Inf)]
                     (if (not= l r) (- r l) (by-tokens a b)))
         (let [l (or (get a "healthScore") -1) r (or (get b "healthScore") -1)]
           (if (not= l r) (- r l) (by-tokens a b))))))))

(defn- sort-accounts [accounts sort]
  (let [k (str/lower-case (str/trim (if (nil? sort) "health" sort)))]
    (vec (sort-by identity (account-comparator k) accounts))))

(defn- top-by-value [okv]
  (first (reduce (fn [[best best-v] [k v]] (if (or (nil? best-v) (> v best-v)) [k v] [best best-v]))
                 [nil nil] (rl/okv-entries okv))))

;; ---------------------------------------------------------------------------
;; Overview

(def ^:private bucket-zeros
  {"requests" 0 "tokens" 0 "promptTokens" 0 "completionTokens" 0 "cachedPromptTokens" 0 "imageCount" 0
   "imageCostUsd" 0 "costUsd" 0 "energyJoules" 0 "waterEvaporatedMl" 0 "cacheHits" 0 "cacheKeyUses" 0
   "errors" 0 "fastMode" 0 "priority" 0 "standard" 0})

(defn- fold-series-bucket [b e hits uses]
  (-> b
      (add "requests" 1)
      (add "tokens" (usage-count (get e "totalTokens")))
      (add "promptTokens" (usage-count (get e "promptTokens")))
      (add "completionTokens" (usage-count (get e "completionTokens")))
      (add "cachedPromptTokens" (usage-count (get e "cachedPromptTokens")))
      (add "imageCount" (usage-count (get e "imageCount")))
      (add "imageCostUsd" (usage-count (get e "imageCostUsd")))
      (add "costUsd" (usage-count (get e "costUsd")))
      (add "energyJoules" (usage-count (get e "energyJoules")))
      (add "waterEvaporatedMl" (usage-count (get e "waterEvaporatedMl")))
      (add "cacheHits" hits)
      (add "cacheKeyUses" uses)
      (cond-> (error? e) (add "errors" 1))
      (add (cond (= (get e "serviceTierSource") "fast_mode") "fastMode"
                 (= (get e "serviceTier") "priority") "priority"
                 :else "standard")
           1)))

(defn- sum-fields [bs ks]
  (reduce (fn [acc b] (reduce (fn [a k] (add a k (get b k))) acc ks)) (zipmap ks (repeat 0)) bs))

(defn- coverage-block [window-start coverage-start-ms retained max-retained]
  {"requestedWindowStart" (iso-from-timestamp window-start)
   "coverageStart" (when (some? coverage-start-ms) (iso-from-timestamp coverage-start-ms))
   "hasFullWindowCoverage" (and (some? coverage-start-ms) (<= coverage-start-ms window-start))
   "retainedEntryCount" retained
   "maxRetainedEntries" max-retained})

(defn- series [now bucket-count bucket-ms lookup]
  (mapv (fn [i]
          (let [ts (bucket-start (- now (* (- bucket-count i 1) bucket-ms)) bucket-ms)]
            (assoc (lookup ts) "t" (iso-from-timestamp ts))))
        (range bucket-count)))

(defn- trends [points]
  {"requests" (mapv (fn [p] {"t" (get p "t") "v" (get p "requests")}) points)
   "tokens" (mapv (fn [p] {"t" (get p "t") "v" (get p "tokens")}) points)
   "errors" (mapv (fn [p] {"t" (get p "t") "v" (get p "errors")}) points)})

(defn- provider-lookup
  "okv providerId -> provider (later duplicates replace, position is first)."
  [providers]
  (reduce (fn [c p] (rl/okv-assoc c (get p "id") p)) rl/empty-okv providers))

(defn- find-status [statuses provider-id account-id]
  (some #(when (= (get % "accountId") account-id) %) (get statuses provider-id)))

(defn overview-from-entries
  "Overview of `entries` (already scoped). ctx: window now sort providers
  statuses coverage{coverageStartMs retainedEntryCount maxRetainedEntries}."
  [entries {:strs [window now sort providers statuses coverage]}]
  (let [{:keys [bucket-ms bucket-count bucket-window-start entry-window-start]} (window-config window now)
        recent (filterv #(>= (get % "timestamp") entry-window-start) entries)
        routing (summarize-routing recent)
        {:keys [buckets models provider-totals accounts short]}
        (reduce (fn [acc e]
                  (let [hits (cache-hit e) uses (cache-key-use e)
                        bk (bucket-start (get e "timestamp") bucket-ms)
                        ak (pair-key (get e "providerId") (get e "accountId"))
                        tokens (usage-count (get e "totalTokens"))]
                    (-> acc
                        (update :buckets update-okv bk bucket-zeros #(fold-series-bucket % e hits uses))
                        (update :models update-okv (get e "model") 0 #(+ % tokens))
                        (update :provider-totals update-okv (get e "providerId") 0 #(+ % tokens))
                        (update :accounts update-okv ak (new-account-agg (get e "providerId") (get e "accountId") (get e "authType"))
                                #(fold-account % e hits uses))
                        (update :short fold-short e now))))
                {:buckets rl/empty-okv :models rl/empty-okv :provider-totals rl/empty-okv
                 :accounts rl/empty-okv :short rl/empty-okv}
                recent)
        by-provider (provider-lookup providers)
        accounts (reduce (fn [c p]
                           (reduce (fn [c a]
                                     (let [k (pair-key (get p "id") (get a "id"))]
                                       (if (some? (rl/okv-get c k)) c
                                           (rl/okv-assoc c k (new-account-agg (get p "id") (get a "id") (get a "authType"))))))
                                   c (get p "accounts")))
                         accounts providers)
        stats (mapv (fn [[_ agg]]
                      (let [provider (rl/okv-get by-provider (get agg "providerId"))
                            pa (some #(when (= (get % "id") (get agg "accountId")) %) (get provider "accounts"))
                            st (find-status statuses (get agg "providerId") (get agg "accountId"))
                            status (cond (and st (not (get st "available"))) "cooldown"
                                         (pos? (get agg "requestCount")) "healthy"
                                         :else "idle")]
                        (account-summary agg status short
                                         {:auth-type (if (some? (get pa "authType")) (get pa "authType") (get agg "authType"))
                                          :plan-type (get pa "planType")})))
                    (rl/okv-entries accounts))
        points (series now bucket-count bucket-ms
                       (fn [ts] (let [b (rl/okv-get buckets ts)]
                                  {"requests" (get b "requests" 0) "tokens" (get b "tokens" 0) "errors" (get b "errors" 0)})))
        totals (sum-fields (map val (rl/okv-entries buckets)) (keys bucket-zeros))]
    {"window" window
     "generatedAt" (iso-from-timestamp now)
     "coverage" (coverage-block bucket-window-start (get coverage "coverageStartMs")
                                (get coverage "retainedEntryCount") (get coverage "maxRetainedEntries"))
     "summary" {"requests24h" (get totals "requests") "tokens24h" (get totals "tokens")
                "promptTokens24h" (get totals "promptTokens") "completionTokens24h" (get totals "completionTokens")
                "cachedPromptTokens24h" (get totals "cachedPromptTokens") "imageCount24h" (get totals "imageCount")
                "imageCostUsd24h" (get totals "imageCostUsd") "costUsd24h" (get totals "costUsd")
                "energyJoules24h" (get totals "energyJoules") "waterEvaporatedMl24h" (get totals "waterEvaporatedMl")
                "cacheKeyUses24h" (get totals "cacheKeyUses")
                "cacheHitRate24h" (if (pos? (get totals "cacheKeyUses")) (percentage (get totals "cacheHits") (get totals "cacheKeyUses")) 0)
                "errorRate24h" (percentage (get totals "errors") (get totals "requests"))
                "topModel" (top-by-value models) "topProvider" (top-by-value provider-totals)
                "activeAccounts" (count (filter #(pos? (get % "requestCount")) stats))
                "routingRequests24h" routing
                "serviceTierRequests24h" {"fastMode" (get totals "fastMode") "priority" (get totals "priority") "standard" (get totals "standard")}}
     "trends" (trends points)
     "accounts" (sort-accounts stats sort)}))

(defn overview-from-rollups
  "Overview from the ledger's persisted rollups. ctx: window now sort
  providers statuses entries buckets modelBuckets accountBuckets coverage."
  [{:strs [window now sort providers statuses entries buckets modelBuckets accountBuckets coverage]}]
  (let [{:keys [bucket-ms bucket-count bucket-window-start entry-window-start]} (window-config window now)
        recent (filterv #(>= (get % "timestamp") entry-window-start) entries)
        routing (summarize-routing recent)
        by-start (reduce (fn [m b] (assoc m (get b "startMs") b)) {} buckets)
        total (fn [k] (reduce (fn [s b] (+ s (get b k))) 0 buckets))
        accounts (if (= window "daily")
                   (reduce (fn [c e]
                             (update-okv c (pair-key (get e "providerId") (get e "accountId"))
                                         (new-account-agg (get e "providerId") (get e "accountId") (get e "authType"))
                                         #(fold-account % e (if (truthy? (get e "cacheHit")) 1 0)
                                                        (if (truthy? (get e "promptCacheKeyUsed")) 1 0))))
                           rl/empty-okv recent)
                   (reduce (fn [c b]
                             (rl/okv-assoc c (pair-key (get b "providerId") (get b "accountId"))
                                           (merge {"accountId" (get b "accountId") "providerId" (get b "providerId")
                                                   "authType" (get b "authType")}
                                                  (select-keys b ["requestCount" "totalTokens" "promptTokens" "completionTokens"
                                                                  "cachedPromptTokens" "imageCount" "imageCostUsd" "costUsd"
                                                                  "energyJoules" "waterEvaporatedMl" "cacheHitCount" "cacheKeyUseCount"
                                                                  "ttftSum" "ttftCount" "tpsSum" "tpsCount" "endToEndTpsSum"
                                                                  "endToEndTpsCount" "lastUsedAtMs"]))))
                           rl/empty-okv accountBuckets))
        [models provider-totals]
        (if (= window "daily")
          (reduce (fn [[m p] e]
                    (let [t (usage-count (get e "totalTokens"))]
                      [(update-okv m (get e "model") 0 #(+ % t)) (update-okv p (get e "providerId") 0 #(+ % t))]))
                  [rl/empty-okv rl/empty-okv] recent)
          (reduce (fn [[m p] b]
                    [(update-okv m (get b "model") 0 #(+ % (get b "totalTokens")))
                     (update-okv p (get b "providerId") 0 #(+ % (get b "totalTokens")))])
                  [rl/empty-okv rl/empty-okv] modelBuckets))
        short (reduce (fn [s e] (fold-short s e now)) rl/empty-okv recent)
        by-provider (provider-lookup providers)
        stats (into []
                    (mapcat
                     (fn [[provider-id provider]]
                       (map (fn [a]
                              (let [k (pair-key provider-id (get a "id"))
                                    agg (or (rl/okv-get accounts k) (new-account-agg provider-id (get a "id") (get a "authType")))
                                    st (find-status statuses provider-id (get a "id"))
                                    status (cond (and st (not (get st "available"))) "cooldown"
                                                 (or (pos? (get agg "requestCount")) (some? st)) "healthy"
                                                 :else "idle")]
                                [k (account-summary agg status short {:auth-type (get a "authType") :plan-type (get a "planType")})]))
                            (get provider "accounts"))))
                    (rl/okv-entries by-provider))
        stats (mapv val (rl/okv-entries (reduce (fn [c [k v]] (rl/okv-assoc c k v)) rl/empty-okv stats)))
        points (series now bucket-count bucket-ms
                       (fn [ts] (let [b (get by-start ts)]
                                  {"requests" (get b "requestCount" 0) "tokens" (get b "totalTokens" 0) "errors" (get b "errorCount" 0)})))
        relevant (if (= window "daily")
                   [(get coverage "earliestHourlyBucketAtMs") (get coverage "earliestEntryAtMs")]
                   [(get coverage "earliestDailyBucketAtMs") (get coverage "earliestModelBreakdownAtMs")
                    (get coverage "earliestAccountBreakdownAtMs")])
        coverage-start (reduce (fn [cur v] (cond (nil? v) cur (nil? cur) v :else (max cur v))) nil relevant)
        cache-key-uses (total "cacheKeyUseCount")]
    {"window" window
     "generatedAt" (iso-from-timestamp now)
     "coverage" (coverage-block bucket-window-start coverage-start (get coverage "retainedEntryCount") (get coverage "maxEntries"))
     "summary" {"requests24h" (total "requestCount") "tokens24h" (total "totalTokens")
                "promptTokens24h" (total "promptTokens") "completionTokens24h" (total "completionTokens")
                "cachedPromptTokens24h" (total "cachedPromptTokens") "imageCount24h" (total "imageCount")
                "imageCostUsd24h" (total "imageCostUsd") "costUsd24h" (total "costUsd")
                "energyJoules24h" (total "energyJoules") "waterEvaporatedMl24h" (total "waterEvaporatedMl")
                "cacheKeyUses24h" cache-key-uses
                "cacheHitRate24h" (if (pos? cache-key-uses) (percentage (total "cacheHitCount") cache-key-uses) 0)
                "errorRate24h" (percentage (total "errorCount") (total "requestCount"))
                "topModel" (top-by-value models) "topProvider" (top-by-value provider-totals)
                "activeAccounts" (count (filter #(pos? (get % "requestCount")) stats))
                "routingRequests24h" routing
                "serviceTierRequests24h" {"fastMode" (total "fastModeRequestCount") "priority" (total "priorityRequestCount")
                                          "standard" (total "standardRequestCount")}}
     "trends" (trends points)
     "accounts" (sort-accounts stats sort)}))

;; ---------------------------------------------------------------------------
;; Provider/model analytics

(def ^:private pair-zeros
  {"requestCount" 0 "errorCount" 0 "totalTokens" 0 "promptTokens" 0 "completionTokens" 0 "cachedPromptTokens" 0
   "cacheHitCount" 0 "cacheKeyUseCount" 0 "ttftSum" 0 "ttftCount" 0 "tpsSum" 0 "tpsCount" 0
   "endToEndTpsSum" 0 "endToEndTpsCount" 0 "costUsd" 0 "energyJoules" 0 "waterEvaporatedMl" 0
   "firstSeenAtMs" nil "lastSeenAtMs" nil})

(defn- new-agg [ident] (merge pair-zeros ident))

(defn- min-seen [cur v] (if (nil? cur) v (min cur v)))
(defn- max-seen [cur v] (if (nil? cur) v (max cur v)))

(defn- fold-pair-entry
  "`strict?` selects the three-part error rule and error-gated cache counts."
  [agg e strict?]
  (-> agg
      (add "requestCount" 1)
      (cond-> (if strict? (error? e) (or (>= (get e "status") 400) (string? (get e "error")))) (add "errorCount" 1))
      (add "totalTokens" (usage-count (get e "totalTokens")))
      (add "promptTokens" (usage-count (get e "promptTokens")))
      (add "completionTokens" (usage-count (get e "completionTokens")))
      (add "cachedPromptTokens" (usage-count (get e "cachedPromptTokens")))
      (add "cacheHitCount" (if strict? (cache-hit e) (if (truthy? (get e "cacheHit")) 1 0)))
      (add "cacheKeyUseCount" (if strict? (cache-key-use e) (if (truthy? (get e "promptCacheKeyUsed")) 1 0)))
      (obs (get e "ttftMs") "ttftSum" "ttftCount")
      (obs (get e "tps") "tpsSum" "tpsCount")
      (obs (get e "endToEndTps") "endToEndTpsSum" "endToEndTpsCount")
      (add "costUsd" (usage-count (get e "costUsd")))
      (add "energyJoules" (usage-count (get e "energyJoules")))
      (add "waterEvaporatedMl" (usage-count (get e "waterEvaporatedMl")))
      (update "firstSeenAtMs" min-seen (get e "timestamp"))
      (update "lastSeenAtMs" max-seen (get e "timestamp"))))

(defn- fold-pair-bucket [agg b]
  (-> agg
      (add "requestCount" (get b "requestCount")) (add "errorCount" (get b "errorCount"))
      (add "totalTokens" (get b "totalTokens")) (add "promptTokens" (get b "promptTokens"))
      (add "completionTokens" (get b "completionTokens")) (add "cachedPromptTokens" (get b "cachedPromptTokens"))
      (add "cacheHitCount" (get b "cacheHitCount")) (add "cacheKeyUseCount" (get b "cacheKeyUseCount"))
      (add "ttftSum" (get b "ttftSum")) (add "ttftCount" (get b "ttftCount"))
      (add "tpsSum" (get b "tpsSum")) (add "tpsCount" (get b "tpsCount"))
      (add "endToEndTpsSum" (get b "endToEndTpsSum")) (add "endToEndTpsCount" (get b "endToEndTpsCount"))
      (add "costUsd" (get b "costUsd")) (add "energyJoules" (get b "energyJoules"))
      (add "waterEvaporatedMl" (get b "waterEvaporatedMl"))
      (update "firstSeenAtMs" min-seen (get b "startMs"))
      (update "lastSeenAtMs" max-seen (get b "lastUsedAtMs"))))

(def ^:private additive-keys
  ["requestCount" "errorCount" "totalTokens" "promptTokens" "completionTokens" "cachedPromptTokens"
   "cacheHitCount" "cacheKeyUseCount" "ttftSum" "ttftCount" "tpsSum" "tpsCount" "endToEndTpsSum"
   "endToEndTpsCount" "costUsd" "energyJoules" "waterEvaporatedMl"])

(defn- merge-pair [row pair]
  (-> (reduce (fn [r k] (add r k (get pair k))) row additive-keys)
      (assoc "firstSeenAtMs" (if (nil? (get row "firstSeenAtMs"))
                               (get pair "firstSeenAtMs")
                               (min (get row "firstSeenAtMs") (or (get pair "firstSeenAtMs") (get row "firstSeenAtMs")))))
      (assoc "lastSeenAtMs" (if (nil? (get row "lastSeenAtMs"))
                              (get pair "lastSeenAtMs")
                              (max (get row "lastSeenAtMs") (or (get pair "lastSeenAtMs") (get row "lastSeenAtMs")))))))

(defn- confidence-score [n] (clamp01 (/ (Math/log10 (+ 1 n)) 3)))

(defn- suitability-score [agg]
  (when (> (get agg "requestCount") 0)
    (let [avg-ttft (when (pos? (get agg "ttftCount")) (/ (get agg "ttftSum") (get agg "ttftCount")))
          avg-tps (when (pos? (get agg "tpsCount")) (/ (get agg "tpsSum") (get agg "tpsCount")))
          error-rate (/ (get agg "errorCount") (get agg "requestCount"))
          cache-rate (if (pos? (get agg "cacheKeyUseCount")) (/ (get agg "cacheHitCount") (get agg "cacheKeyUseCount")) 0)
          ttft-score (if avg-ttft (/ 1 (+ 1 (/ avg-ttft 1000))) 0.5)
          tps-score (if avg-tps (clamp01 (/ avg-tps 80)) 0.5)
          success (- 1 (clamp01 error-rate))
          confidence (confidence-score (get agg "requestCount"))]
      (clamp01 (* (+ (* 0.40 ttft-score) (* 0.25 tps-score) (* 0.20 success) (* 0.15 (clamp01 cache-rate)))
                  (+ 0.5 (* 0.5 confidence)))))))

(defn- analytics-row [agg extras]
  (let [avg (fn [sum cnt] (when (pos? (get agg cnt)) (/ (get agg sum) (get agg cnt))))
        avg-tps (avg "tpsSum" "tpsCount")]
    (cond-> {"requestCount" (get agg "requestCount") "errorCount" (get agg "errorCount")
             "errorRate" (if (pos? (get agg "requestCount")) (percentage (get agg "errorCount") (get agg "requestCount")) 0)
             "totalTokens" (get agg "totalTokens") "promptTokens" (get agg "promptTokens")
             "completionTokens" (get agg "completionTokens") "cachedPromptTokens" (get agg "cachedPromptTokens")
             "cacheHitRate" (if (pos? (get agg "cacheKeyUseCount")) (percentage (get agg "cacheHitCount") (get agg "cacheKeyUseCount")) 0)
             "avgTtftMs" (avg "ttftSum" "ttftCount") "avgDecodeTps" avg-tps "avgTps" avg-tps
             "avgEndToEndTps" (avg "endToEndTpsSum" "endToEndTpsCount")
             "costUsd" (get agg "costUsd") "energyJoules" (get agg "energyJoules")
             "waterEvaporatedMl" (get agg "waterEvaporatedMl")
             "firstSeenAt" (iso-from-timestamp (get agg "firstSeenAtMs"))
             "lastSeenAt" (iso-from-timestamp (get agg "lastSeenAtMs"))
             "confidenceScore" (confidence-score (get agg "requestCount"))
             "suitabilityScore" (suitability-score agg)}
      (contains? agg "providerId") (assoc "providerId" (get agg "providerId"))
      (contains? agg "model") (assoc "model" (get agg "model"))
      (contains? extras "providerCoverageCount") (assoc "providerCoverageCount" (get extras "providerCoverageCount"))
      (contains? extras "modelCoverageCount") (assoc "modelCoverageCount" (get extras "modelCoverageCount")))))

(defn- sort-rows [rows sort]
  (let [k (if (string? sort) (str/lower-case (str/trim sort)) "suitability")
        fallback (fn [l r] (locale-compare (or (get l "model") (get l "providerId") "") (or (get r "model") (get r "providerId") "")))
        tok (fn [l r] (- (get r "totalTokens") (get l "totalTokens")))
        cmp (fn [l r]
              (case k
                "requests" (num-or (- (get r "requestCount") (get l "requestCount")) (tok l r) (fallback l r))
                "tokens" (num-or (tok l r) (- (get r "requestCount") (get l "requestCount")) (fallback l r))
                "ttft" (num-or (- (or (get l "avgTtftMs") ##Inf) (or (get r "avgTtftMs") ##Inf)) (tok l r) (fallback l r))
                ("tps" "decode-tps") (num-or (- (or (get r "avgTps") ##-Inf) (or (get l "avgTps") ##-Inf)) (tok l r) (fallback l r))
                "e2e-tps" (num-or (- (or (get r "avgEndToEndTps") ##-Inf) (or (get l "avgEndToEndTps") ##-Inf)) (tok l r) (fallback l r))
                ("errors" "error-rate") (num-or (- (get l "errorRate") (get r "errorRate")) (tok l r) (fallback l r))
                "cost" (num-or (- (get l "costUsd") (get r "costUsd")) (tok l r) (fallback l r))
                (num-or (- (or (get r "suitabilityScore") -1) (or (get l "suitabilityScore") -1)) (tok l r) (fallback l r))))]
    (vec (sort-by identity (fn [l r] (comparator-result (cmp l r))) rows))))

(defn- finish-analytics [pairs window sort now window-start coverage-block*]
  (let [{:keys [models providers model-cov provider-cov]}
        (reduce (fn [acc pair]
                  (let [model-id (if (nil? (get pair "model")) "unknown" (get pair "model"))
                        provider-id (if (nil? (get pair "providerId")) "unknown" (get pair "providerId"))
                        acc (update acc :models update-okv model-id (new-agg {"model" model-id}) #(merge-pair % pair))
                        acc (update acc :model-cov update model-id (fnil conj #{}) provider-id)
                        acc (update acc :providers update-okv provider-id (new-agg {"providerId" provider-id}) #(merge-pair % pair))]
                    (update acc :provider-cov update provider-id (fnil conj #{}) model-id)))
                {:models rl/empty-okv :providers rl/empty-okv :model-cov {} :provider-cov {}}
                pairs)]
    {"window" window
     "generatedAt" (iso-from-timestamp now)
     "coverage" coverage-block*
     "models" (sort-rows (mapv (fn [[id agg]] (analytics-row agg {"providerCoverageCount" (count (get model-cov id))}))
                               (rl/okv-entries models)) sort)
     "providers" (sort-rows (mapv (fn [[id agg]] (analytics-row agg {"modelCoverageCount" (count (get provider-cov id))}))
                                  (rl/okv-entries providers)) sort)
     "providerModels" (sort-rows (mapv #(analytics-row % {}) pairs) sort)}))

(defn analytics-from-entries
  "Provider/model analytics from entries. ctx: window sort now coverage."
  [entries {:strs [window sort now coverage]}]
  (let [{:keys [bucket-window-start entry-window-start]} (window-config window now)
        pairs (->> entries
                   (filter #(>= (get % "timestamp") entry-window-start))
                   (reduce (fn [c e]
                             (update-okv c (pair-key (get e "providerId") (get e "model"))
                                         (new-agg {"providerId" (get e "providerId") "model" (get e "model")})
                                         #(fold-pair-entry % e true)))
                           rl/empty-okv)
                   rl/okv-entries (mapv val))]
    (finish-analytics pairs window sort now bucket-window-start
                      (coverage-block bucket-window-start (get coverage "coverageStartMs")
                                      (get coverage "retainedEntryCount") (get coverage "maxRetainedEntries")))))

(defn analytics-from-rollups
  "Provider/model analytics from model rollups (and, for daily, the raw
  entries with the legacy error rule). ctx: window sort now entries
  modelBuckets coverage (store coverage)."
  [{:strs [window sort now entries modelBuckets coverage]}]
  (let [{:keys [bucket-window-start entry-window-start]} (window-config window now)
        pairs (->> (if (= window "daily")
                     (->> entries (filter #(>= (get % "timestamp") entry-window-start))
                          (reduce (fn [c e]
                                    (update-okv c (pair-key (get e "providerId") (get e "model"))
                                                (new-agg {"providerId" (get e "providerId") "model" (get e "model")})
                                                #(fold-pair-entry % e false)))
                                  rl/empty-okv))
                     (reduce (fn [c b]
                               (update-okv c (pair-key (get b "providerId") (get b "model"))
                                           (new-agg {"providerId" (get b "providerId") "model" (get b "model")})
                                           #(fold-pair-bucket % b)))
                             rl/empty-okv modelBuckets))
                   rl/okv-entries (mapv val))
        relevant (if (= window "daily")
                   [(get coverage "earliestEntryAtMs")]
                   [(get coverage "earliestDailyBucketAtMs") (get coverage "earliestModelBreakdownAtMs")])
        coverage-start (reduce (fn [cur v] (cond (nil? v) cur (nil? cur) v :else (max cur v))) nil relevant)]
    (finish-analytics pairs window sort now bucket-window-start
                      (coverage-block bucket-window-start coverage-start
                                      (get coverage "retainedEntryCount") (get coverage "maxEntries")))))

(defn scope-active? [scope]
  (boolean (or (truthy? (get scope "tenantId")) (truthy? (get scope "issuer")) (truthy? (get scope "keyId")))))

(defn entry-matches-scope? [e scope]
  (or (nil? scope)
      (every? (fn [k] (or (not (truthy? (get scope k))) (= (get e k) (get scope k))))
              ["tenantId" "issuer" "keyId"])))
