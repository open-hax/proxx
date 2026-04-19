(ns proxx.boot
  (:require
   [proxx.pipeline        :as pl]
   [proxx.store.hot       :as hot]
   [proxx.store.redis     :as redis]
   [proxx.store.lmdb      :as lmdb]
   [proxx.store.postgres  :as pg]
   [proxx.store.protocol  :refer [store-close store-put]]))

;; ---------------------------------------------------------------------------
;; State
;; ---------------------------------------------------------------------------

(defonce ^:private state
  (atom {:pipeline nil
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
  "Ingest records through pipeline only when content hash has changed."
  [pipeline source-key entity-type records]
  (when (and (seq records) (changed? source-key records))
    (doseq [r records]
      (pl/ingest! pipeline entity-type r source-key))))

;; ---------------------------------------------------------------------------
;; Public seed entry points
;; ---------------------------------------------------------------------------

(defn seed-from-value!
  "Ingest a parsed JS array of provider/account objects (PROXY_KEYS_JSON etc.)."
  [pipeline raw-js-value]
  (let [records (js->clj raw-js-value :keywordize-keys true)]
    (ingest-source! pipeline :env-json :provider-credential records)))

(defn seed-from-models!
  "Ingest a parsed JS models array."
  [pipeline models-js-value]
  (let [records (js->clj models-js-value :keywordize-keys true)]
    (ingest-source! pipeline :models-file :provider-model records)))

(defn seed-from-env-api-keys!
  "Ingest PROVIDER_API_KEY_<NAME>=<val> env vars as :provider-credential records."
  [pipeline]
  (let [env    (js->clj (.-env js/process) :keywordize-keys true)
        prefix "PROVIDER_API_KEY_"
        records (->> env
                     (filter (fn [[k _]] (.startsWith (name k) prefix)))
                     (mapv (fn [[k v]]
                             (let [pid (-> (name k)
                                           (subs (count prefix))
                                           .toLowerCase
                                           (.replace "_" "-"))]
                               {:id          (str pid ":env")
                                :provider-id pid
                                :auth-type   "api_key"
                                :secret      v}))))]
    (ingest-source! pipeline :env-api-keys :provider-credential records)))

(defn seed-static!
  "Ingest built-in fixture data (used in dev / test). Pass an EDN map of
  {entity-type [records...]}."
  [pipeline fixture-map]
  (doseq [[entity-type records] fixture-map]
    (ingest-source! pipeline (keyword "static" (name entity-type))
                    entity-type records)))

;; ---------------------------------------------------------------------------
;; Store construction
;; ---------------------------------------------------------------------------

(defn- make-hot-store []
  (hot/->HotCache (atom {})))

(defn- make-redis-store [redis-url]
  (let [Redis  (js/require "ioredis")
        client (Redis. redis-url)]
    (redis/->RedisStore client)))

(defn- make-lmdb-store [lmdb-path]
  (let [lmdb-mod (js/require "lmdb")
        env      (.open lmdb-mod #js {:path lmdb-path})
        dbs      (atom {})]
    (lmdb/->LmdbStore env dbs)))

(defn- make-pg-store [database-url query-registry]
  (let [postgres (js/require "postgres")
        sql      (postgres database-url)]
    (pg/->PostgresStore sql query-registry)))

;; ---------------------------------------------------------------------------
;; boot! / halt!
;; ---------------------------------------------------------------------------

(defn boot!
  "Open the store stack, run seed sources, return the live pipeline.

  config keys:
    :redis-url      — ioredis connection string (optional)
    :lmdb-path      — filesystem path for LMDB env (optional)
    :database-url   — postgres connection string (optional)
    :query-registry — entity-type query map required when :database-url set
    :fixture-map    — EDN map {entity-type [records]} for static seed (optional)
    :models-value   — parsed JS models array (optional)

  Idempotent: returns existing pipeline if already booted."
  [{:keys [redis-url lmdb-path database-url query-registry
           fixture-map models-value] :as _config}]
  (if-let [existing (:pipeline @state)]
    existing
    (let [hot-store  (make-hot-store)
          redis-store  (when redis-url    (make-redis-store redis-url))
          lmdb-store   (when lmdb-path    (make-lmdb-store lmdb-path))
          pg-store     (when database-url (make-pg-store database-url
                                                          (or query-registry {})))
          stores       (filterv some? [hot-store redis-store lmdb-store pg-store])
          pipeline     (pl/make-pipeline
                        {:hot      hot-store
                         :redis    redis-store
                         :lmdb     lmdb-store
                         :postgres pg-store})]
      (swap! state assoc :pipeline pipeline :stores stores)
      ;; Seed in priority order — static/fixtures first, env overrides last
      (when fixture-map
        (seed-static! pipeline fixture-map))
      (seed-from-env-api-keys! pipeline)
      (let [kj (or (aget js/process.env "PROXY_KEYS_JSON")
                   (aget js/process.env "UPSTREAM_KEYS_JSON"))]
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
  (reset! state {:pipeline nil :stores []})
  :halted)

(defn pipeline
  "Return the live pipeline map, or nil if not booted."
  []
  (:pipeline @state))
