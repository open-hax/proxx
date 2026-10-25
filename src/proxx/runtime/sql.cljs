(ns proxx.runtime.sql
  "JS edge for the SQL stores' pure mapping (rows in, views/params out).
  Rows are plain objects from the postgres driver; results are plain JS
  objects/arrays. Statement execution and transactions stay in TypeScript."
  (:require [proxx.credentials.sql :as sql]))

(defn- parse-json [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))

(defn- in [x] (js->clj x))
(defn- out [x] (clj->js x))

(defn normalize-auth-type-js [raw] (sql/normalize-auth-type raw))
(defn provider-credential-js [row auth-type] (out (sql/provider-credential (in row) auth-type)))
(defn legacy-openai-duplicate-ids-js [rows] (to-array (sql/legacy-openai-duplicate-ids (in rows))))
(defn user-view-js [row] (out (sql/user-view (in row))))
(defn membership-view-js [row] (out (sql/membership-view (in row))))
(defn user-upsert-params-js [new-uuid input] (to-array (sql/user-upsert-params new-uuid (in input))))

(defn resolve-ui-session-js [user memberships active-tenant-id default-tenant-id]
  (out (sql/resolve-ui-session (in user) (in memberships) active-tenant-id default-tenant-id)))

(defn bootstrap-role-js [existing-memberships default-tenant-id count-row]
  (let [{:keys [role create?]} (sql/bootstrap-role (in existing-memberships) default-tenant-id (in count-row))]
    #js {"role" role "create" create?}))

(defn api-key-scopes-js [scopes] (to-array (sql/api-key-scopes (in scopes))))
(defn normalized-api-key-label-js [label] (sql/normalized-label label))
(defn tenant-api-key-view-js [row] (out (sql/tenant-api-key-view (in row) parse-json)))
(defn tenant-api-key-match-js [row] (out (sql/tenant-api-key-match (in row) parse-json)))

(defn credential-provider-views-js [provider-rows account-rows reveal-secrets derive-oauth-metadata]
  (let [derive (fn [token]
                 (let [^js m (derive-oauth-metadata token)]
                   (cond-> {}
                     (some? (.-chatgptAccountId m)) (assoc :chatgpt-account-id (.-chatgptAccountId m))
                     (some? (.-email m)) (assoc :email (.-email m))
                     (some? (.-subject m)) (assoc :subject (.-subject m))
                     (some? (.-planType m)) (assoc :plan-type (.-planType m)))))]
    (out (sql/credential-provider-views (in provider-rows) (in account-rows) (boolean reveal-secrets) derive))))

(defn cooldown-entries-js [rows]
  (to-array (map to-array (sql/cooldown-entries (in rows)))))
