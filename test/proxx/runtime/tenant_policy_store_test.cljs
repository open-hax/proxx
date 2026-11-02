(ns proxx.runtime.tenant-policy-store-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.credentials.tenant-policy :as tp]
            [proxx.runtime.tenant-policy-store :as store]))

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

(deftest upsert-and-list-run-the-statements
  (async done
    (let [calls (atom [])
          ^js s (store/create-sql-tenant-provider-policy-store-js
                 (fake-sql calls [#js {"subject_did" "d" "provider_id" "p" "provider_kind" "peer_proxx" "owner_subject" "o"
                                       "share_mode" "deny" "trust_tier" "less_trusted" "allowed_models" "[\"a\"]"
                                       "encrypted_channel_required" false "created_at" "c" "updated_at" "u"}]))]
      (-> (.upsertPolicy s #js {"subjectDid" " d " "providerId" "P" "ownerSubject" "o" "allowedModels" #js ["a" " a "]})
          (.then (fn [^js record]
                   (is (= ["a"] (vec (.-allowedModels record))))
                   (let [[_ params] (first @calls)]
                     (is (= ["d" "p" "local_upstream" "o" "deny" "less_trusted" "[\"a\"]"] (subvec params 0 7))))
                   (.listPolicies s #js {"ownerSubject" " o "})))
          (.then (fn [_]
                   (let [[text values] (second @calls)]
                     (is (.endsWith text " WHERE owner_subject = $1 ORDER BY owner_subject, subject_did, provider_id"))
                     (is (= ["o"] values)))
                   (done)))))))

(deftest invalid-input-is-a-plain-error
  (async done
    (let [^js s (store/create-sql-tenant-provider-policy-store-js (fake-sql (atom []) []))]
      (-> (.upsertPolicy s #js {"subjectDid" "" "providerId" "p" "ownerSubject" "o"})
          (.then (fn [_] (is false "should reject") (done))
                 (fn [e]
                   (is (instance? js/Error e))
                   (is (nil? (ex-data e)))
                   (done)))))))
