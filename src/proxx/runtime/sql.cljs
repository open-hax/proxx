(ns proxx.runtime.sql
  "JS edge for the SQL stores' pure mapping (rows in, views/params out).
  Rows are plain objects from the postgres driver; results are plain JS
  objects/arrays. Statement execution and transactions stay in TypeScript."
  (:require [proxx.auth.persistence :as ap]
            [proxx.credentials.federation :as fed]
            [proxx.credentials.sql :as sql]
            [proxx.credentials.tenant-policy :as tp]))

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

;; ---------------------------------------------------------------------------
;; Federation store rows
;; ---------------------------------------------------------------------------

(defn- fed-parse [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))

;; JSON object columns that arrive already parsed (objects) are returned as the
;; very same JS object, so nothing is lost or reordered: only text is parsed.
(defn- with-objects
  "Convert `row`, replacing JSON columns that are objects by a placeholder key
  so they can be restored untouched after mapping."
  [^js row cols out-keys build]
  (let [clj-row (js->clj row)
        record (clj->js (build clj-row))]
    (doseq [[col out-key] (map vector cols out-keys)]
      (let [v (aget row col)]
        (when (and (some? v) (not (string? v)) (= "object" (goog/typeOf v)))
          (aset record out-key v))))
    record))

(defn federation-peer-record-js [row]
  (with-objects row ["auth_json" "capabilities"] ["auth" "capabilities"] #(fed/peer-record % fed-parse)))
(defn federation-diff-event-record-js [row]
  (with-objects row ["payload"] ["payload"] #(fed/diff-event-record % fed-parse)))
(defn federation-projected-account-record-js [row]
  (with-objects row ["metadata"] ["metadata"] #(fed/projected-account-record % fed-parse)))
(defn federation-sync-state-record-js [row] (out (fed/sync-state-record (in row))))
(defn federation-warm-import-threshold-js [raw] (fed/warm-import-threshold raw))
(defn federation-should-warm-import-js [count threshold] (fed/should-warm-import? count threshold))
(defn federation-sanitize-limit-js [limit fallback] (fed/sanitize-limit limit fallback))
(defn federation-peer-base-url-input-js [value] (fed/peer-base-url-input value))
(defn federation-base-url-conflict-js [^js error]
  (and (some? error) (= "object" (goog/typeOf error))
       (fed/base-url-conflict? {:code (.-code error) :constraint (.-constraint error) :message (.-message error)})))

;; ---------------------------------------------------------------------------
;; Tenant provider policies
;; ---------------------------------------------------------------------------

(defn tenant-policy-kind-js [v] (tp/normalize-kind v))
(defn tenant-policy-share-mode-js [v] (tp/normalize-share-mode v))
(defn tenant-policy-trust-tier-js [v] (tp/normalize-trust-tier v))
(defn tenant-policy-normalize-input-js
  "JSON null in a limit field is an error (undefined means absent): mark it so
  the pure validation rejects it as before."
  [^js input]
  (let [copy (js/Object.assign #js {} input)]
    (doseq [k ["maxRequestsPerMinute" "maxConcurrentRequests" "warmImportThreshold"]]
      (when (nil? (aget input k))
        (when (and (js/Object.prototype.hasOwnProperty.call input k) (not (undefined? (aget input k))))
          (aset copy k "null"))))
    (out (tp/normalize-input (in copy)))))
(defn tenant-policy-upsert-params-js [normalized] (to-array (map #(if (vector? %) (to-array %) %) (tp/upsert-params (in normalized)))))
(defn tenant-policy-record-js [row] (out (tp/policy-record (in row) parse-json)))
(defn tenant-policy-list-filters-js [filters]
  (let [[clauses values] (tp/list-filters (in filters))] #js {"clauses" (to-array clauses) "values" (to-array values)}))

;; ---------------------------------------------------------------------------
;; OAuth session tables
;; ---------------------------------------------------------------------------

(defn- parse-or-nil [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))

(defn- with-extra
  "Attach the parsed `extra` document of `row` (JS), or leave it undefined."
  [^js row record]
  (let [raw (aget row "extra")]
    (when (seq raw)
      (let [parsed (try (js/JSON.parse raw) (catch :default _ js/undefined))]
        (when-not (undefined? parsed) (aset record "extra" parsed))))
    record))

(defn auth-token-view-js [row] (with-extra row (clj->js (ap/token-view (in row) parse-or-nil))))

(defn auth-session-view-js [row]
  (with-extra row (clj->js (ap/session-view (in row) parse-or-nil
                                            (js/Math.floor (/ (.getTime (js/Date. (aget row "created_at"))) 1000))))))

(defn auth-client-view-js [row] (clj->js (ap/client-view (in row) parse-or-nil)))
