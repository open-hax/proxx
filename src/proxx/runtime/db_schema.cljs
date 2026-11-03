(ns proxx.runtime.db-schema
  "Edge for the database schema (src/lib/db/schema.ts, src/lib/db/index.ts): reads
  the persisted contract `resources/db/schema.edn`, serves statement texts to the
  stores, runs the startup migrations and builds the Postgres client. What to run
  is decided by `proxx.db.schema`."
  (:require ["node:fs" :as fs]
            ["postgres" :as postgres]
            [cljs.reader :as reader]
            [proxx.db.schema :as schema]))

(def default-resource "resources/db/schema.edn")

(defonce ^:private loaded (atom {}))

(defn load-schema!
  "The parsed schema resource at `path` (read once)."
  ([] (load-schema! default-resource))
  ([path]
   (or (get @loaded path)
       (let [parsed (reader/read-string (.readFileSync fs path "utf8"))
             broken (schema/problems parsed)]
         (when (seq broken)
           (throw (js/Error. (str "Invalid database schema resource " path ": " (pr-str broken)))))
         (swap! loaded assoc path parsed)
         parsed))))

(defn sql-statement-js [id] (schema/statement (load-schema!) id))

(defn schema-version-js [] (schema/schema-version (load-schema!)))

(defn all-migrations-js
  "Array of {version, sql}, in apply order."
  []
  (to-array (map (fn [{:keys [version sql]}] #js {"version" version "sql" sql})
                 (schema/migrations (load-schema!)))))

(defn pending-migrations-js [current-version]
  (to-array (map (fn [{:keys [version sql]}] #js {"version" version "sql" sql})
                 (schema/pending (load-schema!) current-version))))

(defn ^:async run-migrations-js
  "Run the startup plan on `sql` (a postgres.js client): every migration, then
  record the declared version if absent."
  [^js sql]
  (let [{:keys [migrations version-check version-insert]} (schema/startup-plan (load-schema!))]
    (doseq [text migrations]
      (await (.unsafe sql text)))
    (let [rows (await (.unsafe sql (:sql version-check) (to-array (:params version-check))))]
      (when-not (schema/version-recorded? (.-length rows))
        (await (.unsafe sql (:sql version-insert) (to-array (:params version-insert))))))
    js/undefined))

(defn create-sql-connection-js
  "A postgres.js client for `{connectionString, maxConnections?, idleTimeoutSeconds?,
  connectionTimeoutSeconds?, prepare?}`; defaults as before the port."
  [^js config]
  (let [connect (or (aget postgres "default") postgres)
        or-default (fn [v d] (if (nil? v) d v))]
    (connect (.-connectionString config)
             #js {"max" (or-default (.-maxConnections config) 10)
                  "idle_timeout" (or-default (.-idleTimeoutSeconds config) 30)
                  "connect_timeout" (or-default (.-connectionTimeoutSeconds config) 10)
                  "prepare" (or-default (.-prepare config) false)})))

(defn ^:async close-connection-js [^js sql]
  (await (.end sql))
  js/undefined)
