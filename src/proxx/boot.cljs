(ns proxx.boot
  (:require
   [proxx.pipeline      :as pl]
   [proxx.store.hot     :as hot]
   [proxx.store.redis   :as redis]
   [proxx.store.lmdb    :as lmdb]
   [proxx.store.postgres :as pg]
   [proxx.store.seed    :as seed]
   [proxx.store.protocol :refer [IStore store-close]]
   [proxx.processor     :as proc]
   [proxx.schema        :as schema]
   [cljs.core.async     :refer [go <!]]
   [cljs.core.async.interop :refer-macros [<p!]]))

;; ---------------------------------------------------------------------------
;; State
;; ---------------------------------------------------------------------------

(defonce ^:private state
  (atom {:pipeline nil
         :stores   []}))

;; ---------------------------------------------------------------------------
;; Seed sources
;; The four sources map 1-to-1 with app.ts seedFrom* calls.
;; Each source fn receives config and returns a seq of raw records (or nil).
;; ---------------------------------------------------------------------------

(defn- seed-source-hash
  "Cheap change-detection fingerprint over a raw record seq."
  [records]
  (hash (mapv #(select-keys % [:id :provider-id :account-id :updated-at]) records)))

(defonce ^:private seed-hashes (atom {}))

(defn- changed? [source-key records]
  (let [h (seed-source-hash records)]
    (when (not= h (get @seed-hashes source-key))
      (swap! seed-hashes assoc source-key h)
      true)))

(defn- ingest-source!
  "Run records through pipeline/ingest! only when content has changed."
  [pipeline source-key entity-type records]
  (when (and (seq records) (changed? source-key records))
    (doseq [r records]
      (pl/ingest! pipeline entity-type r {:source source-key}))))

;; ---------------------------------------------------------------------------
;; Public seed entry points (called by boot! and exposed for testing)
;; ---------------------------------------------------------------------------

(defn seed-from-value!
  "Ingest a parsed JSON value (seq of provider/account maps) into the pipeline."
  [pipeline raw-value]
  (let [records (js->clj raw-value :keywordize-keys true)]
    (ingest-source! pipeline :env-json :provider-credential records)))

(defn seed-from-models!
  "Ingest a parsed models JSON array into the pipeline."
  [pipeline models-value]
  (let [records (js->clj models-value :keywordize-keys true)]
    (ingest-source! pipeline :models-file :provider-model records)))

(defn seed-from-env-api-keys!
  "Read PROVIDER_API_KEY-style env vars and ingest as provider-credential records."
  [pipeline]
  (let [env    (js->clj (.-env js/process) :keywordize-keys true)
        prefix "PROVIDER_API_KEY_"
        records (->> env
                     (filter (fn [[k _]] (.startsWith (name k) prefix)))
                     (mapv (fn [[k v]]
                             (let [provider-id (-> (name k)
                                                   (subs (count prefix))
                                                   (.toLowerCase)
                                                   (.replace #"_" "-"))]
                               {:id          (str provider-id ":env")
                                :provider-id provider-id
                                :auth-type   "api_key"
                                :secret      v
                                :source      "env"}))))]
    (ingest-source! pipeline :env-api-keys :provider-credential records)))

(defn seed-static!
  "Ingest the built-in seed/seed.cljs data (dev / test fixture layer)."
  [pipeline]
  (let [records (seed/all-records)]
    (doseq [[entity-type recs] records]
      (ingest-source! pipeline entity-type entity-type recs))))

;; ---------------------------------------------------------------------------
;; Store construction helpers
;; ---------------------------------------------------------------------------

(defn- build-stores
  "Open and return ordered store stack: [hot redis lmdb postgres].
  Each may be nil if the corresponding config key is absent."
  [config]
  (let [hot-store  (hot/->HotStore (atom {}))
        redis-store  (when (:redis-url config)
                       (redis/open! (:redis-url config)))
        lmdb-store   (when (:lmdb-path config)
                       (lmdb/open! (:lmdb-path config)))
        pg-store     (when (:database-url config)
                       (pg/open! (:database-url config)))]
    (filterv some? [hot-store redis-store lmdb-store pg-store])))

(defn- build-pipeline [stores]
  {:hot   (first stores)
   :cold  (rest  stores)
   :stores stores})

;; ---------------------------------------------------------------------------
;; boot! / halt!
;; ---------------------------------------------------------------------------

(defn boot!
  "Open store stack, seed all sources, return the live pipeline map.
  Idempotent: calling boot! again while live returns the existing pipeline."
  [config]
  (if-let [existing (:pipeline @state)]
    existing
    (let [stores   (build-stores config)
          pipeline (build-pipeline stores)]
      (swap! state assoc :pipeline pipeline :stores stores)
      ;; Seed in priority order: static < env-api-keys < env-json < models
      (seed-static!        pipeline)
      (seed-from-env-api-keys! pipeline)
      (when-let [kj (or (aget js/process.env "PROXY_KEYS_JSON")
                        (aget js/process.env "UPSTREAM_KEYS_JSON"))]
        (when (and kj (pos? (.-length (.trim kj))))
          (seed-from-value! pipeline (js/JSON.parse kj))))
      (when-let [mf (:models-value config)]
        (seed-from-models! pipeline mf))
      pipeline)))

(defn halt!
  "Close all open stores in reverse order. Resets state atom."
  []
  (let [{:keys [stores]} @state]
    (doseq [s (reverse stores)]
      (store-close s nil))
    (reset! state {:pipeline nil :stores []})
    :halted))

(defn pipeline
  "Return the live pipeline, or nil if not booted."
  []
  (:pipeline @state))
