(ns proxx.keypool.pool
  "Account-rotation state as an immutable value.

  The pool is one map; every operation is a function from a state (plus an
  explicit `now`) to the next state, and operations that may choose randomly
  also thread an explicit PRNG. Persistence, telemetry, file/env reads and
  token refresh are effects for the edge: transitions return the facts the edge
  needs (a cooldown deadline, cleared ids) instead of performing them.

    {:providers   {provider-id {:auth-type :accounts [credential ...] :next-offset n}}
     :cooldowns   {[provider-id account-id] until-ms}
     :unsupported {[provider-id account-id model] until-ms}
     :in-flight   {[provider-id account-id] n}
     :streaks     {[provider-id account-id] consecutive-failures}
     :disabled    #{[provider-id account-id] ...}
     :rng         seed-number | tape-vector}

  Convention: an operation that yields a value and a next state returns
  [value state'] (as `next-double` and `weighted-shuffle` do).

  Credential shape: see `proxx.keypool.credentials`."
  (:require [clojure.string :as str]
            [proxx.epoch :as epoch]
            [proxx.keypool.credentials :as credentials]))

(def empty-state
  {:providers {} :cooldowns {} :unsupported {} :in-flight {} :streaks {} :disabled #{} :rng 1})

(def default-expiry-buffer-ms 60000)
(def default-jitter-factor 0.4)
(def min-cooldown-ms 1000)

;; ---------------------------------------------------------------------------
;; Randomness: explicit and replayable
;; ---------------------------------------------------------------------------

(def ^:private park-miller-modulus 2147483647)

(defn next-double
  "[x rng'] with x in (0,1). `rng` is a seed number (Park-Miller, portable and
  good enough for jitter and shuffling), a vector of fixed draws consumed front
  to back (a replay tape for tests), or a nullary function returning draws
  (an impure source that edge adapters may opt into)."
  [rng]
  (cond
    (number? rng) (let [seed (mod (* 48271 rng) park-miller-modulus)]
                    [(/ seed (double park-miller-modulus)) seed])
    (fn? rng) [(rng) rng]                    ; an effectful source, opted into by edge adapters
    (seq rng) [(first rng) (vec (rest rng))]
    :else (throw (ex-info "Random tape exhausted" {:error/type :keypool/rng-exhausted}))))

(defn seed-from
  "A valid seed from a uniform sample in [0,1)."
  [sample]
  (inc (long (* sample (- park-miller-modulus 2)))))

(defn- thread
  "Map `f` ([x rng] -> [y rng']) over `coll`, threading the PRNG."
  [f coll rng]
  (reduce (fn [[ys rng] x] (let [[y rng'] (f x rng)] [(conj ys y) rng']))
          [[] rng] coll))

(defn weighted-shuffle
  "A random permutation where every item draws a weight in [0.5, 1.5): items
  are picked one at a time with probability proportional to weight, so the
  order is random but no account is starved. Returns [items' rng']."
  [items rng]
  (if (<= (count items) 1)
    [(vec items) rng]
    (let [[weights rng] (thread (fn [_ rng] (let [[r rng'] (next-double rng)] [(+ 0.5 r) rng'])) items rng)]
      (loop [remaining (mapv vector items weights) picked [] rng rng]
        (if (empty? remaining)
          [picked rng]
          (let [[r rng] (next-double rng)
                total (reduce + (map second remaining))
                target (* r total)
                index (or (first (keep-indexed (fn [i cumulative] (when (<= target cumulative) i))
                                               (reductions + (map second remaining))))
                          0)]
            (recur (into (subvec remaining 0 index) (subvec remaining (inc index)))
                   (conj picked (first (nth remaining index)))
                   rng)))))))

(defn- jitter-cooldown
  "Where a cooldown that ends at `until` ends once jittered; 0 when it is over."
  [until now factor rng]
  (let [remaining (- until now)]
    (if (or (<= until 0) (<= remaining 0))
      [0 rng]
      (let [[r rng'] (next-double rng)]
        [(+ until (* remaining factor (- r 0.5) 2)) rng']))))

(defn- jittered-duration [base-ms factor rng]
  (let [[r rng'] (next-double rng)]
    [(max min-cooldown-ms (+ base-ms (* (- r 0.5) 2 base-ms factor))) rng']))

;; ---------------------------------------------------------------------------
;; Keys and facts
;; ---------------------------------------------------------------------------

(defn account-key [{:keys [provider-id account-id]}] [provider-id account-id])

(defn normalize-model-id [model-id] (str/lower-case (str/trim model-id)))

(defn key->string
  "The `provider\\0account` form persisted by cooldown/disabled stores."
  [[provider-id account-id]] (str provider-id "\u0000" account-id))

(defn string->key [s]
  (let [[provider-id account-id] (str/split s #"\u0000" 2)]
    (when (and (seq provider-id) (seq account-id)) [provider-id account-id])))

(defn- expired? [{:keys [expires-at]} now buffer-ms]
  (and (number? expires-at) (<= expires-at (+ now buffer-ms))))

(defn account-facts
  "Everything the pool knows about one account at `now`."
  [state credential now buffer-ms]
  (let [k (account-key credential)
        until (get-in state [:cooldowns k])]
    {:disabled? (contains? (:disabled state) k)
     :expired? (boolean (expired? credential now buffer-ms))
     :cooldown-until until
     :cooling? (> (or until 0) now)
     :in-flight? (pos? (get-in state [:in-flight k] 0))}))

(defn- opts-buffer [opts] (let [b (:expiry-buffer-ms opts)] (if (number? b) (max b 0) default-expiry-buffer-ms)))
(defn- opts-jitter [opts] (or (:jitter-factor opts) default-jitter-factor))

(defn- provider-accounts [state provider-id]
  (get-in state [:providers (credentials/normalize-provider-id provider-id) :accounts]))

(defn- require-accounts [state provider-id]
  (let [pid (credentials/normalize-provider-id provider-id)]
    (if (seq (get-in state [:providers pid :accounts]))
      pid
      (throw (ex-info (str "No accounts configured for provider: " pid)
                      {:error/type :keypool/no-accounts :provider-id pid})))))

;; ---------------------------------------------------------------------------
;; Loading
;; ---------------------------------------------------------------------------

(defn replace-providers
  "Install freshly loaded provider states. Round-robin offsets carry over per
  provider (wrapped to the new account count), and per-account state for
  accounts that no longer exist, plus elapsed unsupported-model marks, is dropped."
  [state providers now]
  (let [providers (reduce-kv (fn [m pid {:keys [accounts] :as pstate}]
                               (assoc m pid (assoc pstate :next-offset
                                                   (if (seq accounts)
                                                     (mod (get-in state [:providers pid :next-offset] 0) (count accounts))
                                                     0))))
                             {} providers)
        active (into #{} (comp (mapcat :accounts) (map account-key)) (vals providers))
        keep-active (fn [m] (into {} (filter (fn [[k _]] (contains? active k))) m))]
    (-> state
        (assoc :providers providers)
        (update :cooldowns keep-active)
        (update :in-flight keep-active)
        (update :streaks keep-active)
        (update :unsupported #(into {} (filter (fn [[[pid aid _] until]] (and (contains? active [pid aid]) (> until now)))) %)))))

(defn restore-cooldowns
  "Merge persisted cooldowns (string-keyed) that are still in the future."
  [state persisted now]
  (reduce-kv (fn [s key-string until]
               (if-let [k (and (> until now) (string->key key-string))]
                 (assoc-in s [:cooldowns k] until)
                 s))
             state persisted))

(defn restore-disabled [state key-strings]
  (update state :disabled into (keep string->key) key-strings))

;; ---------------------------------------------------------------------------
;; Ordering
;; ---------------------------------------------------------------------------

(defn- random-walk-order
  "Idle and busy accounts shuffled; cooling accounts follow only if their
  jittered deadline has already passed, earliest first."
  [{:keys [idle busy cooling]} state now factor]
  (let [rng (:rng state)
        [idle rng] (weighted-shuffle idle rng)
        [busy rng] (weighted-shuffle busy rng)
        [jittered rng] (thread (fn [cred rng]
                                 (let [[until rng'] (jitter-cooldown (get-in state [:cooldowns (account-key cred)] 0) now factor rng)]
                                   [[cred until] rng']))
                               cooling rng)
        ready (->> jittered (sort-by second) (filter #(<= (second %) now)) (map first))]
    [(-> (into idle busy) (into ready)) rng]))

(defn- order-result [groups state' now opts]
  (if (:random-walk? opts)
    (let [[order rng] (random-walk-order groups state' now (opts-jitter opts))]
      [order (assoc state' :rng rng)])
    [(into (:idle groups []) (:busy groups [])) state']))

(defn request-order
  "[credentials state']: the accounts to try for a request, best first. The
  provider's round-robin offset advances so successive calls start elsewhere.
  Throws when the provider has no accounts."
  [state provider-id now opts]
  (let [pid (require-accounts state provider-id)
        accounts (provider-accounts state pid)
        n (count accounts)
        start (mod (get-in state [:providers pid :next-offset]) n)
        buffer (opts-buffer opts)
        groups (group-by (fn [cred]
                           (let [{:keys [disabled? expired? cooling? in-flight?]} (account-facts state cred now buffer)]
                             (cond (or disabled? expired?) nil
                                   cooling? :cooling
                                   in-flight? :busy
                                   :else :idle)))
                         (concat (drop start accounts) (take start accounts)))]
    (order-result groups (assoc-in state [:providers pid :next-offset] (mod (inc start) n)) now opts)))

(defn refresh-plan
  "[{:ready [credentials] :refresh [credentials]} state']: like `request-order`
  but without rotating, and expired accounts that hold a refresh token are
  returned for the caller to refresh (cooling accounts are not worth refreshing).
  The caller appends successfully refreshed credentials to `:ready`."
  [state provider-id now opts]
  (let [pid (require-accounts state provider-id)
        buffer (opts-buffer opts)
        groups (group-by (fn [cred]
                           (let [{:keys [disabled? expired? cooling? in-flight?]} (account-facts state cred now buffer)]
                             (cond disabled? nil
                                   cooling? :cooling
                                   expired? (when (:refresh-token cred) :refresh)
                                   in-flight? :busy
                                   :else :idle)))
                         (provider-accounts state pid))
        [ready state'] (order-result groups state now opts)]
    [{:ready ready :refresh (get groups :refresh [])} state']))

;; ---------------------------------------------------------------------------
;; Outcomes
;; ---------------------------------------------------------------------------

(defn mark-in-flight [state credential]
  (update-in state [:in-flight (account-key credential)] (fnil inc 0)))

(defn release-in-flight [state credential]
  (let [k (account-key credential)
        remaining (dec (get-in state [:in-flight k] 1))]
    (if (pos? remaining)
      (assoc-in state [:in-flight k] remaining)
      (update state :in-flight dissoc k))))

(defn- cooldown-deadline [state now retry-after-ms {:keys [default-cooldown-ms] :as opts}]
  (let [base (max (if (some? retry-after-ms) retry-after-ms default-cooldown-ms) min-cooldown-ms)
        [duration rng] (jittered-duration base (opts-jitter opts) (:rng state))]
    [(or (epoch/normalize-epoch-ms (+ now duration)) 0) (assoc state :rng rng)]))

(defn mark-rate-limited
  "[cooldown-until state']: cool the account down (honouring `retry-after-ms`
  when given) and extend its failure streak."
  [state credential retry-after-ms now opts]
  (let [[until state] (cooldown-deadline state now retry-after-ms opts)
        k (account-key credential)]
    [until
     (-> state (assoc-in [:cooldowns k] until) (update-in [:streaks k] (fnil inc 0)))]))

(defn mark-model-unsupported
  "[until state'] ([nil state] for a blank model): remember that this account
  cannot serve `model-id` for a while."
  [state credential model-id retry-after-ms now opts]
  (let [model (normalize-model-id model-id)]
    (if (empty? model)
      [nil state]
      (let [[until state] (cooldown-deadline state now retry-after-ms opts)]
        [until (assoc-in state [:unsupported (conj (account-key credential) model)] until)]))))

(defn model-unsupported? [state provider-id account-id model-id now]
  (let [model (normalize-model-id model-id)]
    (and (seq model)
         (> (get-in state [:unsupported [(credentials/normalize-provider-id provider-id) account-id model]] 0) now))))

(defn clear-model-unsupported [state provider-id account-id model-id]
  (let [model (normalize-model-id model-id)]
    (cond-> state
      (seq model) (update :unsupported dissoc [(credentials/normalize-provider-id provider-id) account-id model]))))

(defn set-account-cooldown-until
  "[persisted-until state']: a future deadline is recorded; a past or invalid
  one clears the cooldown (persisted-until 0)."
  [state provider-id account-id until now]
  (let [k [(credentials/normalize-provider-id provider-id) account-id]
        normalized (or (epoch/normalize-epoch-ms until) 0)]
    (if (<= normalized now)
      [0 (update state :cooldowns dissoc k)]
      [normalized (assoc-in state [:cooldowns k] normalized)])))

(defn clear-account-cooldown [state provider-id account-id]
  (let [k [(credentials/normalize-provider-id provider-id) account-id]]
    (-> state (update :cooldowns dissoc k) (update :streaks dissoc k))))

(defn clear-provider-cooldowns
  "[account-ids state']: end every cooldown of a provider, reporting which
  accounts were cleared so the edge can clear their persisted deadlines."
  [state provider-id]
  (let [pid (credentials/normalize-provider-id provider-id)
        cleared (filterv (fn [[p _]] (= p pid)) (keys (:cooldowns state)))]
    [(mapv second cleared)
     (reduce (fn [s k] (-> s (update :cooldowns dissoc k) (update :streaks dissoc k))) state cleared)]))

(defn disable-account [state provider-id account-id]
  (update state :disabled conj [(credentials/normalize-provider-id provider-id) account-id]))

(defn enable-account [state provider-id account-id]
  (update state :disabled disj [(credentials/normalize-provider-id provider-id) account-id]))

(defn account-disabled? [state provider-id account-id]
  (contains? (:disabled state) [(credentials/normalize-provider-id provider-id) account-id]))

(defn update-account-credential
  "Swap `new-credential` in for the account matching `old-credential`."
  [state provider-id old-credential new-credential]
  (let [pid (credentials/normalize-provider-id provider-id)]
    (if-let [accounts (get-in state [:providers pid :accounts])]
      (if-let [index (first (keep-indexed (fn [i c] (when (and (= (:account-id c) (:account-id old-credential))
                                                               (= (:provider-id c) (:provider-id old-credential)))
                                                       i))
                                          accounts))]
        (assoc-in state [:providers pid :accounts index] new-credential)
        state)
      state)))

;; ---------------------------------------------------------------------------
;; Queries
;; ---------------------------------------------------------------------------

(defn credential-expired?
  "Past its expiry (no safety buffer)."
  [{:keys [expires-at]} now]
  (and (number? expires-at) (>= now expires-at)))

(defn- refreshable [{:keys [refresh-token]}] (seq refresh-token))

(defn- all-accounts [state] (mapcat :accounts (vals (:providers state))))

(defn expired-with-refresh-tokens
  "Accounts of one provider already expired and refreshable."
  [state provider-id now]
  (filterv (fn [{:keys [expires-at] :as c}] (and (number? expires-at) (<= expires-at now) (refreshable c)))
           (provider-accounts state provider-id)))

(defn all-expired-with-refresh-tokens [state now]
  (filterv (fn [{:keys [expires-at] :as c}] (and (number? expires-at) (<= expires-at now) (refreshable c)))
           (all-accounts state)))

(defn expiring-accounts
  "Refreshable accounts, across providers, that expire within `window-ms`."
  [state now window-ms]
  (filterv (fn [{:keys [expires-at] :as c}]
             (and (number? expires-at) (> expires-at now) (<= expires-at (+ now window-ms)) (refreshable c)))
           (all-accounts state)))

(defn provider-status
  "Counts and the time until an account is next usable."
  [state provider-id now opts]
  (let [pid (credentials/normalize-provider-id provider-id)
        pstate (get-in state [:providers pid])
        buffer (opts-buffer opts)]
    (if-not pstate
      {:provider-id pid :auth-type :unknown :total-accounts 0 :available-accounts 0 :cooldown-accounts 0
       :disabled-accounts 0 :expired-accounts 0 :in-flight-accounts 0 :next-ready-in-ms 0}
      (let [tally (reduce (fn [acc cred]
                            (let [{:keys [disabled? expired? cooling? in-flight? cooldown-until]} (account-facts state cred now buffer)]
                              (cond
                                disabled? (update acc :disabled-accounts inc)
                                expired? (update acc :expired-accounts inc)
                                :else (cond-> acc
                                        in-flight? (update :in-flight-accounts inc)
                                        (not cooling?) (update :available-accounts inc)
                                        cooling? (-> (update :cooldown-accounts inc)
                                                     (update :min-delay (fnil min ##Inf) (- cooldown-until now)))))))
                          {:available-accounts 0 :cooldown-accounts 0 :disabled-accounts 0 :expired-accounts 0 :in-flight-accounts 0}
                          (:accounts pstate))]
        (-> tally
            (assoc :provider-id pid :auth-type (:auth-type pstate) :total-accounts (count (:accounts pstate))
                   :next-ready-in-ms (if (or (pos? (:available-accounts tally)) (nil? (:min-delay tally)))
                                       0
                                       (max (:min-delay tally) 0)))
            (dissoc :min-delay))))))

(defn account-statuses
  "Per-account status for every provider, as {provider-id [status ...]}."
  [state now opts]
  (let [buffer (opts-buffer opts)]
    (into {}
          (map (fn [[pid {:keys [accounts]}]]
                 [pid (mapv (fn [cred]
                              (let [{:keys [disabled? expired? cooling? in-flight? cooldown-until]} (account-facts state cred now buffer)
                                    available? (not cooling?)]
                                (cond-> {:provider-id pid :account-id (:account-id cred) :auth-type (:auth-type cred)
                                         :available? available? :disabled? disabled? :expired? expired? :in-flight? in-flight?
                                         :next-ready-in-ms (if (or available? (nil? cooldown-until)) 0 (max (- cooldown-until now) 0))}
                                  cooldown-until (assoc :cooldown-until cooldown-until)
                                  (:expires-at cred) (assoc :expires-at (:expires-at cred)))))
                            accounts)]))
          (:providers state))))
