(ns proxx.credentials.health
  "Account health as an immutable value: scoring, failure streaks, growing
  cooldowns, quota exhaustion, and the aggregation of pending outcome writes
  into batched SQL. Time is a `now-ms` argument; the edge owns the atom, the
  timer and the database.

  State is {key health} with key \"<provider>\\u0000<account>\" and health
  {:provider-id :account-id :success-count :failure-count :last-success-at
  :last-failure-at :last-error :last-status :quota-exhausted-at
  :quota-used-percent :failure-streak :last-cooldown-until} (nil for absent)."
  (:require [proxx.oauth.flow :as flow]))

(def max-cooldown-ms (* 30 60 1000))
(def cooldown-growth-factor 2)
(def default-quota-cooldown-ms 300000)

(defn health-key [provider-id account-id] (str provider-id "\u0000" account-id))

(def ^:private hour-ms (* 1000 60 60))

(defn- truthy-number? [x] (and (number? x) (not (zero? x)) (= x x)))

(defn- int-or-zero [raw] (let [n (flow/parse-int raw)] (if (and n (not (zero? n))) n 0)))

(defn- int-or-nil [raw] (when (seq raw) (flow/parse-int raw)))

(defn parse-health-row
  "A health value from an `account_health` row (counts arrive as bigint strings)."
  [row]
  {:provider-id (get row "provider_id") :account-id (get row "account_id")
   :success-count (int-or-zero (get row "success_count"))
   :failure-count (int-or-zero (get row "failure_count"))
   :last-success-at (int-or-nil (get row "last_success_at"))
   :last-failure-at (int-or-nil (get row "last_failure_at"))
   :last-error (get row "last_error")
   :last-status (int-or-nil (get row "last_status"))
   :quota-exhausted-at nil :quota-used-percent nil :failure-streak 0 :last-cooldown-until nil})

(defn- blank-health [provider-id account-id]
  {:provider-id provider-id :account-id account-id :success-count 0 :failure-count 0
   :last-success-at nil :last-failure-at nil :last-error nil :last-status nil
   :quota-exhausted-at nil :quota-used-percent nil :failure-streak 0 :last-cooldown-until nil})

(defn compute-score
  "Health in [0,1]: success rate, plus recency/sample bonuses, minus recent
  failure and quota penalties; an expired credential scores 0.1."
  [health now-ms expires-at]
  (if (and (truthy-number? expires-at) (<= expires-at now-ms))
    0.1
    (let [{:keys [quota-exhausted-at success-count failure-count last-success-at last-failure-at]} health
          quota-penalty (if (truthy-number? quota-exhausted-at)
                          (let [h (/ (- now-ms quota-exhausted-at) hour-ms)]
                            (cond (< h 1) 0.5 (< h 6) 0.3 (< h 24) 0.15 :else 0))
                          0)
          total (+ success-count failure-count)]
      (if (zero? total)
        (max 0 (- 0.5 quota-penalty))
        (let [success-rate (/ success-count total)
              recency-bonus (if (truthy-number? last-success-at)
                              (let [h (/ (- now-ms last-success-at) hour-ms)]
                                (cond (< h 1) 0.1 (< h 24) 0.05 :else 0))
                              0)
              failure-penalty (if (truthy-number? last-failure-at)
                                (let [h (/ (- now-ms last-failure-at) hour-ms)]
                                  (cond (< h 1) 0.2 (< h 6) 0.1 :else 0))
                                0)
              sample-bonus (min (/ total 100) 0.05)]
          (max 0 (min 1 (+ (- (- (+ success-rate recency-bonus) failure-penalty) quota-penalty) sample-bonus))))))))

(defn health-score
  "Unknown accounts are presumed healthy (1) unless their credential expired."
  [state provider-id account-id now-ms expires-at]
  (if-let [health (get state (health-key provider-id account-id))]
    (compute-score health now-ms expires-at)
    (if (and (truthy-number? expires-at) (<= expires-at now-ms)) 0.1 1)))

(defn record-success [state provider-id account-id status now-ms]
  (update state (health-key provider-id account-id)
          (fn [h] (assoc (or h (blank-health provider-id account-id))
                         :success-count (inc (:success-count (or h {:success-count 0})))
                         :last-success-at now-ms :last-status status :failure-streak 0))))

(defn record-failure [state provider-id account-id status error now-ms]
  (update state (health-key provider-id account-id)
          (fn [h] (let [h (or h (blank-health provider-id account-id))]
                    (assoc h :failure-count (inc (:failure-count h)) :last-failure-at now-ms
                             :last-error (if (some? error) error nil) :last-status status
                             :failure-streak (inc (or (:failure-streak h) 0)))))))

(defn record-quota-exhausted [state provider-id account-id used-percent now-ms]
  (update state (health-key provider-id account-id)
          #(assoc (or % (blank-health provider-id account-id)) :quota-exhausted-at now-ms :quota-used-percent used-percent)))

(defn quota-status [state provider-id account-id]
  (let [h (get state (health-key provider-id account-id))]
    {:exhausted-at (:quota-exhausted-at h) :used-percent (:quota-used-percent h)}))

(defn reset-quota-exhausted [state provider-id account-id]
  (let [k (health-key provider-id account-id)]
    (if (contains? state k) (update state k assoc :quota-exhausted-at nil :quota-used-percent nil) state)))

(defn quota-exhausted?
  "[exhausted? state']: an exhaustion older than `cooldown-ms` is forgotten."
  [state provider-id account-id cooldown-ms now-ms]
  (let [{:keys [exhausted-at]} (quota-status state provider-id account-id)]
    (cond
      (not (truthy-number? exhausted-at)) [false state]
      (> (+ exhausted-at cooldown-ms) now-ms) [true state]
      :else [false (reset-quota-exhausted state provider-id account-id)])))

(defn growing-cooldown
  "[cooldown-ms state']: the base cooldown doubles per consecutive failure up
  to 30 minutes, and never shortens an unexpired cooldown already handed out."
  [state provider-id account-id base-cooldown-ms now-ms]
  (let [k (health-key provider-id account-id)
        health (get state k)
        streak (or (:failure-streak health) 0)]
    (if (or (nil? health) (zero? streak))
      [base-cooldown-ms state]
      (let [grown (min (* base-cooldown-ms (Math/pow cooldown-growth-factor (dec streak))) max-cooldown-ms)
            until (:last-cooldown-until health)]
        (if (and (truthy-number? until) (> until now-ms))
          [(max grown (- until now-ms)) state]
          [grown (assoc-in state [k :last-cooldown-until] (+ now-ms grown))])))))

(defn all-scores
  "Scores of every known account, best first (stable among equals)."
  [state now-ms]
  (->> (vals state)
       (map (fn [h] {:provider-id (:provider-id h) :account-id (:account-id h)
                     :score (compute-score h now-ms nil)
                     :success-count (:success-count h) :failure-count (:failure-count h)}))
       (sort-by :score >)
       vec))

;; ---------------------------------------------------------------------------
;; Pending writes -> batched upserts
;; ---------------------------------------------------------------------------

(def batch-size 200)

(defn aggregate-writes
  "Collapse pending outcome writes (maps with :type :provider-id :account-id
  :timestamp :status :error) per account. Returns {:successes [...] :failures
  [...] :last-type} where the aggregates keep first-seen order and the latest
  write wins `last-*`; :last-type is the type of the newest write."
  [writes]
  (let [step (fn [{:keys [successes failures last-type last-ts order-s order-f]} {:keys [type timestamp] :as w}]
               (let [k (health-key (:provider-id w) (:account-id w))
                     newest? (>= timestamp last-ts)
                     base {:last-type (if newest? type last-type) :last-ts (if newest? timestamp last-ts)}]
                 (if (= type :success)
                   (let [cur (get successes k)]
                     (merge {:failures failures :order-f order-f} base
                            {:order-s (if cur order-s (conj order-s k))
                             :successes (assoc successes k
                                               (if cur
                                                 (cond-> (update cur :count inc)
                                                   (>= timestamp (:last-success-at cur))
                                                   (assoc :last-success-at timestamp :last-status (:status w)))
                                                 {:provider-id (:provider-id w) :account-id (:account-id w) :count 1
                                                  :last-success-at timestamp :last-status (:status w)}))}))
                   (let [cur (get failures k)]
                     (merge {:successes successes :order-s order-s} base
                            {:order-f (if cur order-f (conj order-f k))
                             :failures (assoc failures k
                                              (if cur
                                                (cond-> (update cur :count inc)
                                                  (>= timestamp (:last-failure-at cur))
                                                  (assoc :last-failure-at timestamp :last-error (if (some? (:error w)) (:error w) nil)
                                                         :last-status (:status w)))
                                                {:provider-id (:provider-id w) :account-id (:account-id w) :count 1
                                                 :last-failure-at timestamp
                                                 :last-error (if (some? (:error w)) (:error w) nil)
                                                 :last-status (:status w)}))})))))
        {:keys [successes failures order-s order-f last-type]}
        (reduce step {:successes {} :failures {} :order-s [] :order-f [] :last-type :success :last-ts 0} writes)]
    {:successes (mapv successes order-s) :failures (mapv failures order-f) :last-type last-type}))

(defn- placeholders [n width]
  (apply str (interpose ", "
                        (for [i (range n)]
                          (str "(" (apply str (interpose ", " (for [j (range width)] (str "$" (+ (* i width) j 1))))) ")")))))

(defn success-chunk-query
  "[sql-text values] for one chunk of success aggregates (persisted contract:
  the text is byte-for-byte what the legacy store sent)."
  [chunk updated-at]
  [(str "\nWITH input(provider_id, account_id, success_count, last_success_at, last_status, updated_at) AS (\n"
        "  VALUES " (placeholders (count chunk) 6) "\n"
        ")\n"
        "INSERT INTO account_health (provider_id, account_id, success_count, last_success_at, last_status, updated_at)\n"
        "SELECT\n"
        "  input.provider_id,\n"
        "  input.account_id,\n"
        "  input.success_count::bigint,\n"
        "  input.last_success_at::bigint,\n"
        "  input.last_status::integer,\n"
        "  input.updated_at::bigint\n"
        "FROM input\n"
        "WHERE EXISTS (\n"
        "  SELECT 1 FROM accounts\n"
        "  WHERE accounts.id = input.account_id AND accounts.provider_id = input.provider_id\n"
        ")\n"
        "ON CONFLICT (provider_id, account_id) DO UPDATE SET\n"
        "  success_count = account_health.success_count + EXCLUDED.success_count,\n"
        "  last_success_at = EXCLUDED.last_success_at,\n"
        "  last_status = EXCLUDED.last_status,\n"
        "  updated_at = EXCLUDED.updated_at;\n")
   (vec (mapcat (fn [r] [(:provider-id r) (:account-id r) (:count r) (:last-success-at r) (:last-status r) updated-at]) chunk))])

(defn failure-chunk-query [chunk updated-at]
  [(str "\nWITH input(provider_id, account_id, failure_count, last_failure_at, last_error, last_status, updated_at) AS (\n"
        "  VALUES " (placeholders (count chunk) 7) "\n"
        ")\n"
        "INSERT INTO account_health (provider_id, account_id, failure_count, last_failure_at, last_error, last_status, updated_at)\n"
        "SELECT\n"
        "  input.provider_id,\n"
        "  input.account_id,\n"
        "  input.failure_count::bigint,\n"
        "  input.last_failure_at::bigint,\n"
        "  input.last_error,\n"
        "  input.last_status::integer,\n"
        "  input.updated_at::bigint\n"
        "FROM input\n"
        "WHERE EXISTS (\n"
        "  SELECT 1 FROM accounts\n"
        "  WHERE accounts.id = input.account_id AND accounts.provider_id = input.provider_id\n"
        ")\n"
        "ON CONFLICT (provider_id, account_id) DO UPDATE SET\n"
        "  failure_count = account_health.failure_count + EXCLUDED.failure_count,\n"
        "  last_failure_at = EXCLUDED.last_failure_at,\n"
        "  last_error = EXCLUDED.last_error,\n"
        "  last_status = EXCLUDED.last_status,\n"
        "  updated_at = EXCLUDED.updated_at;\n")
   (vec (mapcat (fn [r] [(:provider-id r) (:account-id r) (:count r) (:last-failure-at r) (:last-error r) (:last-status r) updated-at]) chunk))])

(defn flush-plan
  "The ordered chunks to send: [[:success chunk] [:failure chunk] ...]. The
  kind of the newest write goes last, so its `last_status` wins."
  [writes]
  (let [{:keys [successes failures last-type]} (aggregate-writes writes)
        chunks (fn [kind aggregates] (mapv (fn [c] [kind c]) (partition-all batch-size aggregates)))
        s (chunks :success successes)
        f (chunks :failure failures)]
    (if (= last-type :success) (into f s) (into s f))))
