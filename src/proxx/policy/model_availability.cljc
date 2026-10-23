;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.policy.model-availability
  "Pure catalog evidence decisions. A listing never proves successful execution.")

(defn- nonblank-string? [value]
  (and (string? value) (boolean (re-find #"\S" value))))

(defn- valid-time? [value]
  (and (integer? value) (<= 0 value)))

(defn- identity-of [snapshot]
  (select-keys snapshot [:provider-id :endpoint :scope :source-kind :collection-mode]))

(defn- valid-snapshot? [snapshot]
  (and (map? snapshot)
       (every? nonblank-string? (map snapshot [:provider-id :endpoint :scope]))
       (keyword? (:source-kind snapshot))
       (valid-time? (:observed-at-ms snapshot))
       (map? (:models snapshot))
       (every? (fn [[id descriptor]] (and (nonblank-string? id) (map? descriptor)))
               (:models snapshot))))

(defn- fresh? [snapshot {:keys [now-ms max-age-ms]}]
  (and (valid-time? now-ms) (valid-time? max-age-ms) (pos? max-age-ms)
       (valid-snapshot? snapshot)
       (not (:stale? snapshot))
       (<= 0 (- now-ms (:observed-at-ms snapshot)) max-age-ms)))

(defn- successful? [snapshot]
  (and (valid-snapshot? snapshot) (= :ok (:status snapshot))
       (not (:stale? snapshot))))

(defn- comparable? [baseline current]
  (and (successful? baseline) (successful? current)
       (= (identity-of baseline) (identity-of current))
       ;; Repeated timestamps cannot establish a new change.
       (< (:observed-at-ms baseline) (:observed-at-ms current))))

(defn- canonical [value]
  (cond
    (map? value) [:map (->> value
                           (map (fn [[key item]] [(canonical key) (canonical item)]))
                           (sort-by (comp pr-str first)) vec)]
    (set? value) [:set (vec (sort-by pr-str (map canonical value)))]
    (sequential? value) [:seq (mapv canonical value)]
    :else value))

(defn capability-fingerprint
  "Versioned canonical EDN identity, not a host-dependent hash or auth digest.
  Adapters supply only public capability fields. Missing metadata stays unknown;
  nil and false remain distinct. Map/set ordering does not change the identity."
  [descriptor]
  (when (and (map? (:capabilities descriptor)) (seq (:capabilities descriptor)))
    (pr-str [:capabilities-v1 (canonical (:capabilities descriptor))])))

(defn- drift [before after]
  (let [previous (capability-fingerprint before)
        current (capability-fingerprint after)]
    (cond-> #{}
      (and (:target-id before) (:target-id after)
           (not= (:target-id before) (:target-id after)))
      (conj :alias-target-changed)
      (and previous current (not= previous current)) (conj :capabilities-changed)
      (and previous (nil? current)) (conj :capability-evidence-lost)
      (and (nil? previous) current) (conj :capability-evidence-gained))))

(defn- evidence-of [snapshot]
  (select-keys snapshot [:provider-id :endpoint :scope :source-kind :observed-at-ms
                         :observed-at :status :http-status :complete? :authoritative? :collection-mode]))

(defn assess-model
  "Compare one literal model/alias ID in two scoped observations.

  Removal requires a fresh, successful, complete authoritative catalog and a
  prior authoritative listing in the same provider/endpoint/account scope.
  Transport/auth/quota errors, stale caches, pagination gaps and missing local
  registrations cannot establish delisting. No substring or family guessing.
  Inject clock/TTL; callers retain the timestamped evidence and own baseline I/O."
  [baseline current model-id options]
  (let [usable? (and (fresh? current options) (= :ok (:status current)))
        listed? (and usable? (contains? (:models current) model-id))
        authoritative? (true? (:authoritative? current))
        comparable (and usable? (comparable? baseline current))
        previously-listed? (and comparable
                                (true? (:authoritative? baseline))
                                (contains? (:models baseline) model-id))
        availability (cond
                       (not (nonblank-string? model-id)) :unknown
                       (not (and usable? authoritative?)) :unknown
                       listed? :listed
                       (not (true? (:complete? current))) :unknown
                       previously-listed? :delisted
                       :else :unlisted)
        before (when comparable (get-in baseline [:models model-id]))
        after (when listed? (get-in current [:models model-id]))]
    {:model-id model-id
     :availability availability
     :assurance :catalog-only
     :observed-present? (when usable? (contains? (:models current) model-id))
     :baseline-fingerprint (capability-fingerprint before)
     :current-fingerprint (capability-fingerprint after)
     :drift (cond
              (= :delisted availability) #{:delisted}
              (and before after) (drift before after)
              :else #{})
     :evidence {:baseline (evidence-of baseline) :current (evidence-of current)}}))

(defn advance-baseline
  "Return the new complete, fresh, authoritative observation only when its scope
  matches and time advances. Errors never erase the last good listing. Persist
  returned observations separately; this function writes nothing."
  [baseline current options]
  (if (and (fresh? current options) (= :ok (:status current))
           (true? (:complete? current)) (true? (:authoritative? current))
           (or (nil? baseline) (comparable? baseline current)))
    current
    baseline))
