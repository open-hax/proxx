(ns proxx.boot
  (:require
   [clojure.string        :as str]
   [goog.object           :as gobj]
   [proxx.pipeline        :as pl]
   [proxx.policy.loader   :as policy-loader]
   [proxx.store.hot       :as hot]
   [proxx.store.redis     :as redis]
   [proxx.store.lmdb      :as lmdb]
   [proxx.store.postgres  :as pg]
   [proxx.store.protocol  :refer [store-close]]))

;; ---------------------------------------------------------------------------
;; State
;; ---------------------------------------------------------------------------

(defonce ^:private state
  (atom {:pipeline nil
         :policies []
         :stores   []}))

;; ---------------------------------------------------------------------------
;; Hash-based idempotency guard
;; ---------------------------------------------------------------------------

(defonce ^:private seed-hashes (atom {}))

(defn- seed-fingerprint [records]
  (hash (mapv #(select-keys % [:id :provider-id :account-id :updated-at]) records)))

(defn- changed? [source-key records]
  (let [h (seed-fingerprint records)]
    (when (not= h (get @seed-hashes source-key))
      (swap! seed-hashes assoc source-key h)
      true)))

;; ---------------------------------------------------------------------------
;; Seed helpers
;; ---------------------------------------------------------------------------

(defn- ingest-source!
  "Ingest records through pipeline only when content hash has changed.
   source must be a valid Provenance :source enum value."
  [pipeline source-key entity-type records]
  (when (and (seq records) (changed? source-key records))
    (doseq [r records]
      (pl/ingest! pipeline entity-type r source-key))))

;; ---------------------------------------------------------------------------
;; Public seed entry points
;; ---------------------------------------------------------------------------

(defn seed-from-value!
  "Ingest a parsed JS array of provider/account objects (PROXY_KEYS_JSON etc.).
   Records are ingested with :seed provenance source."
  [pipeline raw-js-value]
  (let [records (js->clj raw-js-value :keywordize-keys true)]
    (ingest-source! pipeline :seed :provider-credential records)))

(defn seed-from-models!
  "Ingest a parsed JS models array with :seed provenance."
  [pipeline models-js-value]
  (let [records (js->clj models-js-value :keywordize-keys true)]
    (ingest-source! pipeline :seed :provider-model records)))

(defn seed-from-env-api-keys!
  "Ingest PROVIDER_API_KEY_<NAME>=<val> env vars as :provider-credential records."
  [pipeline]
  (let [prefix  "PROVIDER_API_KEY_"
        records (->> (array-seq (js/Object.entries (.-env js/process)))
                     (keep (fn [entry]
                             (let [k (aget entry 0)
                                   v (aget entry 1)]
                               (when (.startsWith k prefix)
                                 (let [pid (-> k
                                               (subs (count prefix))
                                               str/lower-case
                                               (str/replace "_" "-"))]
                                   {:id          (str pid ":env")
                                    :provider-id pid
                                    :auth-type   "api_key"
                                    :secret      v})))))
                     vec)]
    (ingest-source! pipeline :seed :provider-credential records)))

(defn seed-static!
  "Ingest built-in fixture data. fixture-map is {entity-type [records...]}.
   All records are stamped with :seed provenance."
  [pipeline fixture-map]
  (doseq [[entity-type records] fixture-map]
    (ingest-source! pipeline :seed entity-type records)))

;; ---------------------------------------------------------------------------
;; Store construction
;; ---------------------------------------------------------------------------

(defn- make-hot-store []
  (hot/->HotCache (atom {})))

(defn- make-redis-store [redis-url]
  (let [Redis  (js/require "ioredis")
        client (new Redis redis-url)]
    (redis/->RedisStore client)))

(defn- make-lmdb-store [lmdb-path]
  (let [lmdb-mod (js/require "lmdb")
        env      (.open lmdb-mod #js {:path lmdb-path})
        dbs      (atom {})]
    (lmdb/->LmdbStore env dbs)))

(defn- make-pg-store [database-url query-registry]
  (let [postgres (js/require "postgres")
        sql      (new postgres database-url)]
    (pg/->PostgresStore sql query-registry)))

;; ---------------------------------------------------------------------------
;; boot! / halt!
;; ---------------------------------------------------------------------------

(defn boot!
  "Open store stack, run seed sources, return the live pipeline.

  config keys:
    :redis-url      — ioredis connection string (optional)
    :lmdb-path      — filesystem path for LMDB env (optional)
    :database-url   — postgres connection string (optional)
    :query-registry — entity-type query map (required when :database-url set)
    :fixture-map    — {entity-type [records]} for static seed (optional)
    :models-value   — parsed JS models array (optional)
    :policy-path    — EDN policy file path (optional)

  Idempotent: returns existing pipeline when already booted."
  [{:keys [redis-url lmdb-path database-url query-registry
           fixture-map models-value policy-path]}]
  (if-let [existing (:pipeline @state)]
    existing
    (let [hot-store   (make-hot-store)
          redis-store (when redis-url    (make-redis-store redis-url))
          lmdb-store  (when lmdb-path    (make-lmdb-store lmdb-path))
          pg-store    (when database-url (make-pg-store database-url
                                                        (or query-registry {})))
          stores      (filterv some? [hot-store redis-store lmdb-store pg-store])
          pipeline    (pl/make-pipeline
                       {:hot      hot-store
                        :redis    redis-store
                        :lmdb     lmdb-store
                        :postgres pg-store})
          policies    (if policy-path
                        (policy-loader/load-policies! policy-path)
                        [])]
      (swap! state assoc :pipeline pipeline :policies policies :stores stores)
      ;; Seed priority: static < env-api-keys < inline-json < models
      (when fixture-map
        (seed-static! pipeline fixture-map))
      (seed-from-env-api-keys! pipeline)
      (let [proc-env (.-env js/process)
            kj       (or (gobj/get proc-env "PROXY_KEYS_JSON")
                         (gobj/get proc-env "UPSTREAM_KEYS_JSON"))]
        (when (and kj (pos? (.-length (.trim kj))))
          (seed-from-value! pipeline (js/JSON.parse kj))))
      (when models-value
        (seed-from-models! pipeline models-value))
      pipeline)))

(defn halt!
  "Close all open stores in reverse order and reset state. Returns :halted."
  []
  (doseq [s (reverse (:stores @state))]
    (store-close s))
  (reset! state {:pipeline nil :policies [] :stores []})
  :halted)

(defn pipeline
  "Return the live pipeline map, or nil if not booted."
  []
  (:pipeline @state))

(defn policies
  "Return the loaded policy vector."
  []
  (:policies @state))
