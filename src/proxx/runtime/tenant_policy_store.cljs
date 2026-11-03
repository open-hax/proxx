(ns proxx.runtime.tenant-policy-store
  "Edge of the tenant provider policy table (`src/lib/db/sql-tenant-provider-policy-store.ts`):
  normalization, parameters and the listing query are pure
  (`proxx.credentials.tenant-policy`); this runs the statements."
  (:require [proxx.credentials.tenant-policy :as tp]
            [proxx.runtime.db-schema :as db-schema]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.sql :as views]
            [proxx.runtime.sql-util :as u]))

(defn- statement [id] (db-schema/sql-statement-js id))

(defn- rethrow-as-error [e]
  (throw (if (some? (ex-data e)) (js/Error. (ex-message e)) e)))

(defn- normalize [input]
  (try (views/tenant-policy-normalize-input-js input) (catch :default e (rethrow-as-error e))))

(defn create-sql-tenant-provider-policy-store-js
  "The facade `SqlTenantProviderPolicyStore` forwards to."
  [^js sql]
  #js {"init" (fn ^:async init []
                (await (.unsafe sql (statement "CREATE_TENANT_PROVIDER_POLICIES_TABLE")))
                (await (.unsafe sql (statement "CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX")))
                js/undefined)

       "upsertPolicy" (fn ^:async upsert-policy [input]
                        (let [normalized (interop/js->data (normalize input))
                              params (tp/statement-params normalized #(js/JSON.stringify (to-array %)))
                              rows (await (u/unsafe sql (statement "UPSERT_TENANT_PROVIDER_POLICY") params))
                              row (u/first-row rows)]
                          (when-not row (throw (js/Error. "failed to upsert tenant provider policy")))
                          (views/tenant-policy-record-js row)))

       "getPolicy" (fn ^:async get-policy [subject-did provider-id]
                     (let [normalized (interop/js->data
                                       (normalize #js {"subjectDid" subject-did "providerId" provider-id
                                                       "ownerSubject" "placeholder"}))
                           rows (await (u/unsafe sql (statement "SELECT_TENANT_PROVIDER_POLICY")
                                                 [(get normalized "subjectDid") (get normalized "providerId")]))
                           row (u/first-row rows)]
                       (if row (views/tenant-policy-record-js row) js/undefined)))

       "listPolicies" (fn ^:async list-policies [filters]
                        (let [^js f (views/tenant-policy-list-filters-js (or filters #js {}))
                              query (tp/list-query (statement "SELECT_TENANT_PROVIDER_POLICIES") (vec (.-clauses f)))
                              rows (await (u/unsafe sql query (vec (.-values f))))]
                          (.map rows (fn [row] (views/tenant-policy-record-js row)))))})
