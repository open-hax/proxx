(ns proxx.pipeline
  (:require [proxx.cache-policy :as cp]
            [proxx.store.protocol :refer [store-get store-put]]
            [proxx.processor :as proc]
            [proxx.schema :as schema]))

;; ══════════════════════════════════════════════════════════════
;; Construction
;; ══════════════════════════════════════════════════════════════

(defn make-pipeline
  "Returns a pipeline map given named store drivers.

   Accepted keys: :hot :redis :lmdb :postgres
   All are optional; missing stores are silently skipped during
   route! and fetch!. At minimum supply :hot and :postgres."
  [{:keys [hot redis lmdb postgres]}]
  {:stores {:hot      hot
            :redis    redis
            :lmdb     lmdb
            :postgres postgres}})

;; ══════════════════════════════════════════════════════════════
;; Secret redaction
;; ══════════════════════════════════════════════════════════════

(def ^:private sensitive-keys
  #{:secret :api-key :password :token :refresh-token
    :access-token :client-secret :private-key})

(defn- safe-record-context
  "Returns a diagnostic map safe to include in ex-info.
   Includes the record id (if derivable) and present key names;
   never includes values for sensitive keys."
  [record]
  {:record-id (or (:id record)
                  (:prompt-cache-key record)
                  (:provider-id record)
                  :unknown)
   :keys      (vec (keys record))})

;; ══════════════════════════════════════════════════════════════
;; Internals
;; ══════════════════════════════════════════════════════════════

(defn- store-for
  "Look up a named store from a pipeline. Returns nil if not present."
  [pipeline store-key]
  (get-in pipeline [:stores store-key]))

(defn- record-key
  "Derive the canonical key from a record.
   Checks :id, :prompt-cache-key, :provider-id in order."
  [record]
  (or (:id record)
      (:prompt-cache-key record)
      (:provider-id record)
      (throw (ex-info "Cannot derive key from record"
                      (safe-record-context record)))))

;; ══════════════════════════════════════════════════════════════
;; route! — chain-of-custody write
;; ══════════════════════════════════════════════════════════════

(defn route!
  "Write a validated, provenance-stamped record through the
   write-through chain declared in cache-policy.

   Always writes to :hot first (sync).
   Then follows policy :write-through chain.

   Returns the record."
  [pipeline entity-type record]
  (let [policy      (get cp/policies entity-type)
        write-chain (:write-through policy [:postgres])
        k           (record-key record)]
    ;; :hot is always first and synchronous
    (when-let [hot (store-for pipeline :hot)]
      (store-put hot entity-type k record))
    ;; follow declared chain
    (doseq [store-key write-chain]
      (when-let [s (store-for pipeline store-key)]
        (store-put s entity-type k record)))
    record))

;; ══════════════════════════════════════════════════════════════
;; fetch! — read-order traversal with backfill
;; ══════════════════════════════════════════════════════════════

(defn fetch!
  "Read a record through the read-order chain from cache-policy.
   :hot is always prepended as the first candidate.

   On hit: back-fills all layers that sit in front of the
   layer where the record was found.

   On miss: returns nil."
  [pipeline entity-type k]
  (let [policy     (get cp/policies entity-type)
        read-chain (into [:hot] (:read-order policy [:postgres]))
        stores     (keep (fn [sk]
                           (when-let [s (store-for pipeline sk)]
                             [sk s]))
                         read-chain)]
    (loop [remaining stores
           checked   []]
      (if-let [[sk s] (first remaining)]
        (let [record (store-get s entity-type k)]
          (if (some? record)
            (do
              ;; back-fill all layers checked before this one
              (doseq [[_ bs] checked]
                (store-put bs entity-type k record))
              record)
            (recur (rest remaining)
                   (conj checked [sk s]))))
        nil))))

;; ══════════════════════════════════════════════════════════════
;; ingest! — normalise → stamp → validate → route!
;; ══════════════════════════════════════════════════════════════

(defn ingest!
  "Full ingestion pipeline for a single raw record.
   Normalises keys, stamps provenance, validates schema,
   then routes to the write-through chain.

   Throws ex-info on schema failure. The exception data never
   includes raw record values; only key names and the entity-type
   are exposed for diagnostics.

   source: :rest | :ws | :seed
   opts: {:request-id string} | {:seed-hash string}"
  [pipeline entity-type raw-record source & [opts]]
  (let [normalised (proc/normalize-keys raw-record)
        stamped    (proc/stamp-provenance normalised source opts)
        [status r] (schema/validate entity-type stamped)]
    (if (= :ok status)
      (route! pipeline entity-type r)
      (throw (ex-info "Ingest validation failed"
                      {:entity-type entity-type
                       :source      source
                       :errors      r
                       :input-keys  (vec (keys raw-record))})))))
