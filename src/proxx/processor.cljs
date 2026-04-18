(ns proxx.processor
  (:require [clojure.string :as str]
            [malli.core :as m]
            [proxx.schema :as s]))

(defn normalize-keys
  "Recursively converts string / camelCase / snake_case keys to kebab-case keywords."
  [m]
  (reduce-kv
    (fn [acc k v]
      (let [kw (-> (name k)
                   (str/replace #"([A-Z])" "-$1")
                   (str/replace #"_" "-")
                   (str/lower-case)
                   keyword)]
        (assoc acc kw (if (map? v) (normalize-keys v) v))))
    {}
    m))

(defn stamp-provenance
  [record source & [{:keys [seed-hash request-id]}]]
  (assoc record :provenance
         (cond-> {:source      source
                  :ingested-at (System/currentTimeMillis)}
           seed-hash  (assoc :seed-hash seed-hash)
           request-id (assoc :request-id request-id))))

(defn validate
  "Returns [:ok record] or [:error explain-data]."
  [schema-key record]
  (let [schema (get s/registry schema-key)]
    (if (m/validate schema record)
      [:ok record]
      [:error (m/explain schema record)])))

;; Prompt affinity state transition

(defn apply-affinity-event
  "Pure state transition for prompt affinity.
   state  - existing PromptAffinityRecord map or nil
   event  - {:type :note-success|:upsert|:delete, :prompt-cache-key .. :provider-id .. :account-id ..}
   opts   - {:promotion-threshold int}"
  [state {:keys [type prompt-cache-key provider-id account-id] :as event} {:keys [promotion-threshold]}]
  (let [now (System/currentTimeMillis)]
    (case type
      :delete nil
      :upsert {:prompt-cache-key (or (:prompt-cache-key state) prompt-cache-key)
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
            (dissoc :provisional-provider-id :provisional-account-id :provisional-success-count)
            (assoc :updated-at now))

        :else
        (let [same-prov? (and (= (:provisional-provider-id state) provider-id)
                              (= (:provisional-account-id state) account-id))
              new-count  (if same-prov?
                           (inc (or (:provisional-success-count state) 1))
                           1)]
          (if (>= new-count promotion-threshold)
            {:prompt-cache-key (:prompt-cache-key state)
             :provider-id      provider-id
             :account-id       account-id
             :updated-at       now}
            (assoc state
                   :provisional-provider-id   provider-id
                   :provisional-account-id    account-id
                   :provisional-success-count new-count
                   :updated-at                now)))))))

;; Pheromone projection

(defn project-pheromone
  "Compute current pheromone score from a seq of {:ts epoch-ms :outcome :success|:failure|...}.
   decay-half-life-ms is the time for the contribution to halve."
  [events {:keys [decay-half-life-ms] :or {decay-half-life-ms 60000}}]
  (let [now (System/currentTimeMillis)]
    (reduce (fn [acc {:keys [ts outcome]}]
              (let [age          (- now ts)
                    decay-factor (Math/pow 0.5 (/ age decay-half-life-ms))
                    signal       (if (= outcome :success) 1.0 -0.5)]
                (+ acc (* signal decay-factor))))
            0.0
            events)))

;; Scoring helpers

(defn apply-weight-transform [value transform]
  (case transform
    :linear    value
    :invert    (- 1.0 value)
    :normalize value
    value))

(defn compute-score [metrics weights]
  (reduce
    (fn [score {:keys [metric-key weight transform]}]
      (let [path  (mapv keyword (str/split metric-key #"\."))
            value (get-in metrics path 0.0)]
        (+ score (* weight (apply-weight-transform value transform))))
      )
    0.0
    weights))

(defn score-candidates
  "Attach :score to each candidate given a metrics-map and scoring weights.
   metrics-map keyed by [provider-id model-id] -> metric map."
  [candidates metrics-map weights]
  (mapv (fn [c]
          (let [k       [(:provider-id c) (:model-id c)]
                metrics (get metrics-map k {})]
            (assoc c :score (compute-score metrics weights))))
        candidates))
