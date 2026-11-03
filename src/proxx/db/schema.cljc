(ns proxx.db.schema
  "The database schema as data and the decisions about applying it
  (formerly src/lib/db/schema.ts). The persisted contract is the EDN resource
  `resources/db/schema.edn`: statement texts are byte-for-byte what runs against
  deployed databases, so they live there and are pinned by test, never rewritten
  here. This namespace is pure: it names statements, resolves migrations and
  plans which to run; reading the resource and talking to the database are the
  edge's job (`proxx.runtime.db-schema`).

  `schema` is the parsed resource:
    :schema-version  the highest migration version
    :statements      {name sql}
    :migrations      [{:version n :statement name} | {:version n :sql text}], in apply order")

(defn statement
  "The SQL text of the statement named `id`."
  [schema id]
  (or (get-in schema [:statements id])
      (throw (ex-info (str "Unknown SQL statement " id) {:statement id}))))

(defn migrations
  "Every migration as {:version n :sql text}, in apply order."
  [schema]
  (mapv (fn [{:keys [version sql] :as m}]
          {:version version
           :sql (if (some? sql) sql (statement schema (:statement m)))})
        (:migrations schema)))

(defn schema-version [schema] (:schema-version schema))

(defn problems
  "Violated invariants of `schema` (empty when well-formed): the declared version is
  the highest migration version, versions never decrease, statements are
  non-empty, and every CREATE TABLE / ADD COLUMN is idempotent."
  [schema]
  (let [ms (migrations schema)
        versions (map :version ms)
        upper (fn [s] (.toUpperCase ^String (str s)))]
    (cond-> []
      (not= (schema-version schema) (when (seq versions) (apply max versions)))
      (conj :version-not-highest)

      (some (fn [[a b]] (< b a)) (partition 2 1 versions))
      (conj :versions-decrease)

      (some (fn [{:keys [sql]}] (empty? (.trim ^String (str sql)))) ms)
      (conj :empty-migration)

      (some (fn [{:keys [sql]}]
              (let [u (upper sql)]
                (and (or (.includes ^String u "CREATE TABLE")
                         (and (.includes ^String u "ALTER TABLE") (.includes ^String u "ADD COLUMN")))
                     (not (.includes ^String u "IF NOT EXISTS")))))
            ms)
      (conj :not-idempotent))))

(defn pending
  "The migrations newer than `current-version`, in apply order."
  [schema current-version]
  (filterv (fn [{:keys [version]}] (> version (or current-version 0))) (migrations schema)))

(defn startup-plan
  "What the credential store does at startup: every migration is idempotent, so all
  of them are re-run, then the declared version is recorded if absent.
    :migrations      the SQL texts to execute in order
    :version-check   {:sql :params} a query returning a row when the version is recorded
    :version-insert  {:sql :params} the statement that records it"
  [schema]
  (let [v (schema-version schema)]
    {:migrations (mapv :sql (migrations schema))
     :version-check {:sql (statement schema "CHECK_VERSION_EXISTS") :params [v]}
     :version-insert {:sql (statement schema "INSERT_VERSION") :params [v]}}))

(defn version-recorded?
  "Did the version check return a row?"
  [row-count]
  (pos? row-count))
