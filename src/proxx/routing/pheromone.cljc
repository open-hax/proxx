(ns proxx.routing.pheromone
  "Route pheromones: the per provider/model reinforcement signal behind ant-colony
  provider ordering (the decision half of src/lib/provider-route-pheromone-store.ts).
  Records are string-keyed wire maps, exactly the persisted JSON; time is an
  argument. Persistence and write scheduling stay at the edge."
  (:require [clojure.string :as str]))

(def baseline 0.5)
(def ^:private decay 0.02)
(def ^:private reinforcement 0.15)
(def ^:private penalty 0.3)

(defn- clamp [x] (Math/min 1 (Math/max 0 x)))

(defn- finite? [x] (and (number? x) (== x x) (not (infinite? x))))

(defn normalize-key-part [s] (str/lower-case (str/trim s)))

(defn- record-key [provider-id model] [(normalize-key-part provider-id) (normalize-key-part model)])

(defn key-valid?
  "Do these identifiers survive normalisation (neither is blank)?"
  [provider-id model]
  (and (seq (normalize-key-part provider-id)) (seq (normalize-key-part model))))

(defn- normalize-pheromone [x] (if (finite? x) (clamp x) baseline))

(defn- count-of [x] (if (finite? x) (Math/max 0 (Math/floor x)) 0))

(defn hydrate-record
  "A well-formed record from a persisted entry, or nil when it lacks a provider id or model.
  Missing counts are 0, a missing timestamp is `now-ms`."
  [raw now-ms]
  (when (map? raw)
    (let [provider-id (if (string? (get raw "providerId")) (normalize-key-part (get raw "providerId")) "")
          model (if (string? (get raw "model")) (normalize-key-part (get raw "model")) "")]
      (when (and (seq provider-id) (seq model))
        {"providerId" provider-id
         "model" model
         "pheromone" (normalize-pheromone (get raw "pheromone"))
         "successCount" (count-of (get raw "successCount"))
         "failureCount" (count-of (get raw "failureCount"))
         "updatedAt" (if (finite? (get raw "updatedAt")) (get raw "updatedAt") now-ms)}))))

(defn hydrate-db
  "The records of a persisted document (an empty list for anything else)."
  [raw now-ms]
  (if (and (map? raw) (sequential? (get raw "records")))
    (into [] (keep #(hydrate-record % now-ms)) (get raw "records"))
    []))

(defn- find-index [records provider-id model]
  (let [k (record-key provider-id model)]
    (first (keep-indexed (fn [i r] (when (= k (record-key (get r "providerId") (get r "model"))) i)) records))))

(defn pheromone
  "The pheromone for a provider/model (the baseline when nothing is recorded)."
  [records provider-id model]
  (if-let [i (find-index records provider-id model)]
    (let [p (get-in records [i "pheromone"])] (if (some? p) p baseline))
    baseline))

(defn- decayed [current] (+ baseline (* (- current baseline) (- 1 decay))))

(defn next-on-success [current quality]
  (clamp (+ (decayed current) (* reinforcement (clamp quality)))))

(defn next-on-failure [current]
  (clamp (- (decayed current) penalty)))

(defn- upsert [records provider-id model now-ms update-record]
  (let [pid (normalize-key-part provider-id) m (normalize-key-part model)
        i (find-index records pid m)
        existing (when i (nth records i))
        next-record (update-record existing {"providerId" pid "model" m "updatedAt" now-ms})]
    (if i (assoc (vec records) i next-record) (conj (vec records) next-record))))

(defn note-success
  "Records after a success of quality 0..1 (a new record is appended, an existing one replaced)."
  [records provider-id model quality now-ms]
  (upsert records provider-id model now-ms
          (fn [existing base]
            (assoc base
                   "pheromone" (next-on-success (get existing "pheromone" baseline) quality)
                   "successCount" (inc (get existing "successCount" 0))
                   "failureCount" (get existing "failureCount" 0)))))

(defn note-failure
  "Records after a failure."
  [records provider-id model now-ms]
  (upsert records provider-id model now-ms
          (fn [existing base]
            (assoc base
                   "pheromone" (next-on-failure (get existing "pheromone" baseline))
                   "successCount" (get existing "successCount" 0)
                   "failureCount" (inc (get existing "failureCount" 0))))))
