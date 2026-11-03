(ns proxx.runtime.federation-store-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.federation-store :as store]))

(defn- fake-sql [calls rows]
  (let [sql (fn [strings & values] (swap! calls conj [:tpl (count strings) (vec values)]) (js/Promise.resolve (to-array rows)))]
    (aset sql "unsafe" (fn [text values] (swap! calls conj [:unsafe text (some-> values vec)]) (js/Promise.resolve (to-array rows))))
    (aset sql "json" (fn [v] #js {"json" v}))
    (aset sql "begin" (fn [f] (f #js {"unsafe" (fn [text values]
                                                 (swap! calls conj [:tx text (some-> values vec)])
                                                 (js/Promise.resolve #js [#js {"locked" false}]))})))
    sql))

(deftest ^:async upsert-peer-rejects-empty-credential-before-touching-sql
  (let [calls (atom [])
        ^js s (store/create-sql-federation-store-js (fake-sql calls []))]
    (try
      (await (.upsertPeer s #js {"ownerCredential" "  " "label" "L" "baseUrl" "https://a.example"}))
      (is false "expected rejection")
      (catch :default e
        (is (= "owner credential must not be empty" (.-message e)))
        (is (empty? @calls))))))

(deftest ^:async base-url-conflict-is-reported-with-the-normalized-url
  (let [conflict (doto (js/Error. "dup") (aset "code" "23505") (aset "constraint" "federation_peers_base_url_key"))
        sql (fake-sql (atom []) [])]
    (aset sql "unsafe" (fn [_ _] (js/Promise.reject conflict)))
    (let [^js s (store/create-sql-federation-store-js sql)]
      (try
        (await (.upsertPeer s #js {"ownerCredential" "admin-secret" "label" "L" "baseUrl" "https://A.example/"}))
        (is false "expected rejection")
        (catch :default e
          (is (= "federation peer base_url already in use: https://a.example" (.-message e))))))))

(deftest ^:async import-lock-skips-the-callback-when-not-acquired
  (let [calls (atom [])
        ran (atom false)
        ^js s (store/create-sql-federation-store-js (fake-sql calls []))
        result (await (.withProjectedAccountImportLock s #js {"sourcePeerId" "p" "providerId" "OpenAI" "accountId" "a"}
                                                       (fn [_] (reset! ran true) (js/Promise.resolve "ran"))))]
    (is (undefined? result))
    (is (false? @ran))
    (is (= [[:tx "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked" ["p|openai|a"]]] @calls))))
