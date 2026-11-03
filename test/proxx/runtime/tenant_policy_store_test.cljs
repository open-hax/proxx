(ns proxx.runtime.tenant-policy-store-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials.tenant-policy :as tp]
            [proxx.runtime.tenant-policy-store :as store]))

(set! *warn-on-infer* false)

(defn- fake-sql [calls rows]
  #js {"unsafe" (fn [text values]
                  (swap! calls conj [text (some-> values vec)])
                  (js/Promise.resolve (to-array rows)))})

(deftest list-query-shapes
  (is (= "SELECT 1;" (tp/list-query "SELECT 1;" [])) "no filters: the statement untouched")
  (is (= "SELECT 1 WHERE a = $1 AND b = $2 ORDER BY owner_subject, subject_did, provider_id"
         (tp/list-query "SELECT 1;" ["a = $1" "b = $2"]))))

(deftest statement-params-json-encode-models
  (is (= ["d" "p" "peer_proxx" "o" "deny" "less_trusted" "[\"a\"]" nil nil false nil nil]
         (tp/statement-params {"subjectDid" "d" "providerId" "p" "providerKind" "peer_proxx" "ownerSubject" "o"
                               "shareMode" "deny" "trustTier" "less_trusted" "allowedModels" ["a"]
                               "encryptedChannelRequired" false}
                              #(js/JSON.stringify (to-array %))))))

(deftest ^:async upsert-and-list-run-the-statements
  (let [calls (atom [])
        ^js s (store/create-sql-tenant-provider-policy-store-js
               (fake-sql calls [#js {"subject_did" "d" "provider_id" "p" "provider_kind" "peer_proxx" "owner_subject" "o"
                                     "share_mode" "deny" "trust_tier" "less_trusted" "allowed_models" "[\"a\"]"
                                     "encrypted_channel_required" false "created_at" "c" "updated_at" "u"}]))
        ^js record (await (.upsertPolicy s #js {"subjectDid" " d " "providerId" "P" "ownerSubject" "o" "allowedModels" #js ["a" " a "]}))]
    (is (= ["a"] (vec (.-allowedModels record))))
    (let [[_ params] (first @calls)]
      (is (= ["d" "p" "local_upstream" "o" "deny" "less_trusted" "[\"a\"]"] (subvec params 0 7))))
    (await (.listPolicies s #js {"ownerSubject" " o "}))
    (let [[text values] (second @calls)]
      (is (.endsWith text " WHERE owner_subject = $1 ORDER BY owner_subject, subject_did, provider_id"))
      (is (= ["o"] values)))))

(deftest ^:async invalid-input-is-a-plain-error
  (let [^js s (store/create-sql-tenant-provider-policy-store-js (fake-sql (atom []) []))]
    (try
      (await (.upsertPolicy s #js {"subjectDid" "" "providerId" "p" "ownerSubject" "o"}))
      (is false "should reject")
      (catch :default e
        (is (instance? js/Error e))
        (is (nil? (ex-data e)))))))

;; --- Ported from src/tests/sql-tenant-provider-policy-store.test.ts ------------

(defn- normalize-sql [query] (-> query (.replace (js/RegExp. "\\s+" "g") " ") .trim))

(defn- create-mock-sql
  "An in-memory stand-in for the policy table: answers the statements the store
  issues (create, upsert, get, filtered list) and rejects anything else."
  []
  (let [rows (atom {})]
    #js {:unsafe
         (fn [query values]
           (let [normalized (normalize-sql query)
                 values (vec (array-seq (or values #js [])))
                 row-key #(str (nth values 0) "\u0000" (nth values 1))]
             (cond
               (or (.startsWith normalized "CREATE TABLE IF NOT EXISTS tenant_provider_policies")
                   (.startsWith normalized "CREATE INDEX IF NOT EXISTS idx_tenant_provider_policies_owner_subject"))
               (js/Promise.resolve #js [])

               (.startsWith normalized "INSERT INTO tenant_provider_policies")
               (let [now (.toISOString (js/Date.))
                     existing (get @rows (row-key))
                     row #js {:subject_did (str (nth values 0))
                              :provider_id (str (nth values 1))
                              :provider_kind (nth values 2)
                              :owner_subject (str (nth values 3))
                              :share_mode (nth values 4)
                              :trust_tier (nth values 5)
                              :allowed_models (js/JSON.parse (str (nth values 6)))
                              :max_requests_per_minute (nth values 7)
                              :max_concurrent_requests (nth values 8)
                              :encrypted_channel_required (boolean (nth values 9))
                              :warm_import_threshold (nth values 10)
                              :notes (nth values 11)
                              :created_at (if existing (.-created_at ^js existing) now)
                              :updated_at now}]
                 (swap! rows assoc (row-key) row)
                 (js/Promise.resolve #js [row]))

               (.includes normalized "FROM tenant_provider_policies WHERE subject_did = $1 AND provider_id = $2")
               (js/Promise.resolve (if-let [row (get @rows (row-key))] #js [row] #js []))

               (.includes normalized "FROM tenant_provider_policies")
               (let [pred (fn [^js row]
                            (and (or (not (.includes normalized "WHERE subject_did = $1")) (not (first values))
                                     (= (.-subject_did row) (str (first values))))
                                 (or (not (.includes normalized "WHERE owner_subject = $1")) (not (first values))
                                     (= (.-owner_subject row) (str (first values))))
                                 (or (not (.includes normalized "subject_did = $1 AND owner_subject = $2"))
                                     (and (= (.-subject_did row) (str (nth values 0))) (= (.-owner_subject row) (str (nth values 1)))))
                                 (or (not (.includes normalized "owner_subject = $1 AND subject_did = $2"))
                                     (and (= (.-owner_subject row) (str (nth values 0))) (= (.-subject_did row) (str (nth values 1)))))))
                     listed (->> (vals @rows)
                                 (filter pred)
                                 (sort (fn [^js l ^js r]
                                         (let [c (.localeCompare (.-owner_subject l) (.-owner_subject r))]
                                           (if (not= 0 c)
                                             c
                                             (let [c (.localeCompare (.-subject_did l) (.-subject_did r))]
                                               (if (not= 0 c) c (.localeCompare (.-provider_id l) (.-provider_id r))))))))
                                 to-array)]
                 (js/Promise.resolve listed))

               :else (js/Promise.reject
                      (js/Error. (str "Unsupported SQL query in tenant-provider-policy test: " normalized))))))}))

(deftest ^:async sql-tenant-provider-policy-store-upserts-and-lists-policies
  (let [^js s (store/create-sql-tenant-provider-policy-store-js (create-mock-sql))
        _ (await (.init s))
        ^js first-policy (await (.upsertPolicy
                                 s #js {:subjectDid "did:web:big.ussy.promethean.rest"
                                        :providerId "openai"
                                        :ownerSubject "did:plc:z72i7hdynmk6r22z27h6tvur"
                                        :shareMode "project_credentials"
                                        :trustTier "owned_administered"
                                        :allowedModels #js ["gpt-5.4" "gpt-5.3-codex"]
                                        :warmImportThreshold 3}))]
    (is (= "openai" (.-providerId first-policy)))
    (is (= "project_credentials" (.-shareMode first-policy)))
    (is (= "owned_administered" (.-trustTier first-policy)))
    (is (= ["gpt-5.4" "gpt-5.3-codex"] (vec (array-seq (.-allowedModels first-policy)))))
    (let [^js fetched (await (.getPolicy s "did:web:big.ussy.promethean.rest" "openai"))]
      (is (some? fetched))
      (is (= "project_credentials" (.-shareMode fetched))))
    (let [listed (await (.listPolicies s #js {:ownerSubject "did:plc:z72i7hdynmk6r22z27h6tvur"}))]
      (is (= 1 (.-length listed)))
      (is (= "did:web:big.ussy.promethean.rest" (.-subjectDid ^js (aget listed 0)))))))
