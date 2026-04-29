(ns proxx.processor
  (:require [clojure.string :as str]
            [proxx.schema :as s]))

;; ══════════════════════════════════════════════════════════════
;; Key normalization
;; ══════════════════════════════════════════════════════════════

(defn- normalize-key* [k]
  (-> (name k)
      (str/replace #"([A-Z])" "-$1")
      (str/replace #"_" "-")
      (str/lower-case)
      keyword))

(defn normalize-keys
  "Recursively converts string/camelCase/snake_case keys to kebab-case
   keywords. Maps in, maps out; sequences preserved as-is."
  [m]
  (cond
    (map? m)
    (reduce-kv
      (fn [acc k v]
        (assoc acc (normalize-key* k) (normalize-keys v)))
      {}
      m)

    (sequential? m)
    (mapv normalize-keys m)

    :else m))

;; ══════════════════════════════════════════════════════════════
;; Provenance stamping
;; ══════════════════════════════════════════════════════════════

(defn stamp-provenance
  "Attach provenance to a record. Source is one of
   #{:seed :rest :ws :redis :lmdb :postgres}.

   Extra opts:
   - :seed-hash   (for :seed)
   - :request-id  (for :rest/:ws)

   Returns record with :provenance map."
  [record source & [{:keys [seed-hash request-id]}]]
  (let [base {:source      source
              :ingested-at (.now js/Date)}
        prov (cond-> base
               seed-hash  (assoc :seed-hash seed-hash)
               request-id (assoc :request-id request-id))]
    (assoc record :provenance prov)))

(defn validate
  "Thin pass-through to proxx.schema/validate so callers only
   depend on this ns when doing ingestion work."
  [schema-key record]
  (s/validate schema-key record))

;; ══════════════════════════════════════════════════════════════
;; Affinity state machine (pure)
;; ══════════════════════════════════════════════════════════════

(defn apply-affinity-event
  "Pure state transition for prompt affinity.

   Inputs:
   - state  ::PromptAffinityRecord | nil
   - event  {:type :delete | :upsert | :note-success
             :prompt-cache-key string
             :provider-id string
             :account-id string}
   - opts   {:promotion-threshold int >= 1}

   Returns next PromptAffinityRecord or nil (delete).
   Does not touch provenance; caller stamps it."
  [state event {:keys [promotion-threshold]}]
  (let [{:keys [type provider-id account-id prompt-cache-key]} event
        now (.now js/Date)]
    (case type
      :delete nil

      :upsert
      {:prompt-cache-key (or (:prompt-cache-key state) prompt-cache-key)
       :provider-id      provider-id
       :account-id       account-id
       :updated-at       now}

      :note-success
      (cond
        (nil? state)
        {:prompt-cache-key prompt-cache-key
         :provider-id      provider-id
         :account-id       account-id
         :updated-at       now}

        (and (= (:provider-id state) provider-id)
             (= (:account-id state) account-id))
        (-> state
            (dissoc :provisional-provider-id
                    :provisional-account-id
                    :provisional-success-count)
            (assoc :updated-at now))

        :else
        (let [same-provisional? (and (= (:provisional-provider-id state) provider-id)
                                     (= (:provisional-account-id state) account-id))
              new-count         (if same-provisional?
                                  (inc (or (:provisional-success-count state) 1))
                                  1)]
          (if (>= new-count promotion-threshold)
            {:prompt-cache-key (:prompt-cache-key state)
             :provider-id      provider-id
             :account-id       account-id
             :updated-at       now}
            (-> state
                (assoc :provisional-provider-id   provider-id
                       :provisional-account-id    account-id
                       :provisional-success-count new-count
                       :updated-at                now))))))))

;; ══════════════════════════════════════════════════════════════
;; Pheromone projection (pure)
;; ══════════════════════════════════════════════════════════════

(defn project-pheromone
  "Compute current pheromone score from a seq of recent events.

   events: [{:ts epoch-ms :outcome :success|:failure} ...]

   decay-half-life-ms: time for score to halve.
   outcome weighting: success -> +1.0, failure -> -0.5.

   Returns numeric score clamped to the PheromoneState schema range
   of -10.0..10.0."
  [events {:keys [decay-half-life-ms]
           :or   {decay-half-life-ms 60000}}]
  (let [now (.now js/Date)
        score (reduce (fn [acc {:keys [ts outcome]}]
                        (let [age          (- now ts)
                              decay-factor (Math/pow 0.5 (/ age decay-half-life-ms))
                              signal       (case outcome
                                             :success  1.0
                                             :failure -0.5
                                             0.0)]
                          (+ acc (* signal decay-factor))))
                      0.0
                      events)]
    (-> score
        (max -10.0)
        (min 10.0))))

;; ══════════════════════════════════════════════════════════════
;; Scoring (pure)
;; ══════════════════════════════════════════════════════════════

(defn apply-weight-transform
  "Transform a metric value according to a ScoringWeight transform.

   :invert uses 1/(1+value), so larger non-negative values such as
   latency become smaller scores without going negative. Inputs below
   zero are treated as zero before inversion."
  [value transform]
  (case transform
    :linear    value
    :invert    (/ 1.0 (+ 1.0 (max 0.0 value)))
    :normalize value  ;; true normalization needs population stats
    value))

(defn compute-score
  "Compute scalar score from a metrics map and a collection of
   ScoringWeight records.

   metrics is a nested map keyed by dot-path segments, e.g.
   {:latency {:p95 300} :success-rate 0.98}.

   weights is a seq of {:metric-key \"latency.p95\" :weight 0.4 ...}."
  [metrics weights]
  (reduce (fn [score {:keys [metric-key weight transform]}]
            (let [path  (mapv keyword (str/split metric-key #"\."))
                  value (get-in metrics path 0.0)]
              (+ score (* weight (apply-weight-transform value transform)))))
          0.0
          weights))

(defn score-candidates
  "Attach :score to each candidate {:provider-id :model-id ...}
   using a metrics map keyed by [provider-id model-id] and a
   collection of ScoringWeight records."
  [candidates metrics-map weights]
  (mapv (fn [c]
          (let [k       [(:provider-id c) (:model-id c)]
                metrics (get metrics-map k {})]
            (assoc c :score (compute-score metrics weights))))
        candidates))
