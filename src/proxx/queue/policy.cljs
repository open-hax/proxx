(ns proxx.queue.policy
  "Pure request queue policy functions. No I/O, no mutable runtime state."
  (:require [clojure.string :as str]
            [proxx.policy.contracts :as contracts]))

(def queue-policy-keys
  [:queue/status
   :queue/concurrency-limit
   :queue/max-queue-size
   :queue/overflow-policy
   :queue/attempt-timeout-ms
   :queue/total-timeout-ms
   :queue/max-retries
   :queue/retry-backoff
   :queue/fail-fast?
   :queue/jitter-factor
   :queue/base-interval-ms
   :queue/retry-after-respect?
   :queue/stream-timeout-ms])

(defn- template-by-id [compiled template-id]
  (get-in compiled [:index :by-id template-id]))

(defn- request-kind [ctx]
  (let [kind (:request-kind ctx)]
    (if (string? kind) (keyword kind) kind)))

(defn- instance-matches?
  "Return true when a queue instance's scope binding applies to ctx."
  [instance ctx]
  (let [{:queue/keys [tenant-id provider-id]} instance
        match-family (:match/family instance)
        match-kind (:match/request-kind instance)]
    (and
     (or (nil? tenant-id) (= tenant-id (:tenant-id ctx)))
     (or (nil? provider-id) (= provider-id (:provider-id ctx)))
     (or (nil? match-family) (= match-family (:model-family ctx)))
     (or (nil? match-kind) (= match-kind (request-kind ctx))))))

(defn queue-templates
  "Return all :request-queue-template contracts from the compiled index."
  [compiled]
  (->> (get-in compiled [:index :contracts] [])
       (filterv #(= :request-queue-template (:contract/kind %)))))

(defn queue-instances
  "Return all :request-queue-instance contracts from the compiled index."
  [compiled]
  (->> (get-in compiled [:index :contracts] [])
       (filterv #(= :request-queue-instance (:contract/kind %)))))

(defn resolve-queue-policy
  "Return the merged effective queue policy for ctx, or nil when no instance matches.

  Template values provide defaults. Instance values win, except nil instance
  overrides are removed so they transparently inherit from the template."
  [compiled ctx]
  (when-let [instance (first (filter #(instance-matches? % ctx)
                                     (queue-instances compiled)))]
    (when-let [template (template-by-id compiled (:queue/template-id instance))]
      (merge (select-keys template queue-policy-keys)
             (into {}
                   (remove (comp nil? val))
                   (select-keys instance queue-policy-keys))))))

(defn- jitter [base factor]
  (* base factor (js/Math.random)))

(defn backoff-ms
  "Compute delay before zero-indexed attempt. Attempt 0 is immediate."
  [{:queue/keys [retry-backoff base-interval-ms jitter-factor]
    :or {retry-backoff :fixed base-interval-ms 1000 jitter-factor 0.2}}
   attempt]
  (if (zero? attempt)
    0
    (let [base (or base-interval-ms 1000)
          factor (or jitter-factor 0.2)
          jitter-ms #(jitter base factor)
          raw (case retry-backoff
                :immediate 0
                :fixed (+ base (jitter-ms))
                :incremental (+ (* base attempt) (jitter-ms))
                :exponential (+ (min (* base (js/Math.pow 2 (dec attempt))) 60000)
                                (jitter-ms))
                (+ base (jitter-ms)))]
      (js/Math.round raw))))

(defn drain-estimate-ms
  "Estimate milliseconds until a slot is available for Retry-After."
  [{:queue/keys [concurrency-limit attempt-timeout-ms]} active-count]
  (let [limit (max 1 (or concurrency-limit 1))
        timeout-ms (or attempt-timeout-ms 30000)]
    (if (< active-count limit)
      0
      (js/Math.ceil (/ timeout-ms limit)))))

(defn retryable-status? [status]
  (contains? #{408 409 425 429 500 502 503 504} status))

(defn parse-retry-after-ms [value]
  (cond
    (nil? value) nil
    (number? value) (* 1000 value)
    (string? value) (let [trimmed (str/trim value)
                          seconds (js/Number trimmed)]
                      (if (js/Number.isNaN seconds)
                        (let [date-ms (js/Date.parse trimmed)]
                          (when-not (js/Number.isNaN date-ms)
                            (max 0 (- date-ms (js/Date.now)))))
                        (* 1000 seconds)))
    :else nil))

(defn classify-rate-limit
  "Classify a rate-limit response based on provider-specific EDN contracts.
   Returns :rate-limit/volume, :rate-limit/concurrency, or nil when no contract matches."
  [compiled provider-id status retry-after-ms]
  (when-let [contract (first
                        (filter
                          (fn [c]
                            (and
                              (= provider-id (:match/provider-id c))
                              (or (nil? (:classify/status c))
                                  (= status (:classify/status c)))
                              (let [max-ms (get-in c [:classify/retry-after-ms :max])]
                                (or (nil? max-ms)
                                    (and (number? retry-after-ms)
                                         (<= retry-after-ms max-ms))))))
                          (contracts/rate-limit-classifications (:index compiled))))]
    (:classify/result contract)))
