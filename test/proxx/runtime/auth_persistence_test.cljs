(ns proxx.runtime.auth-persistence-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.runtime.auth-persistence :as ap]))

(defn- fake-sql
  "Records tagged-template calls as [:tpl strings values] and `.unsafe` as [:unsafe text values]."
  [calls rows]
  (let [sql (fn [strings & values] (swap! calls conj [:tpl (vec strings) (vec values)])
              (let [r (to-array rows)] (aset r "count" 2) (js/Promise.resolve r)))]
    (aset sql "unsafe" (fn [text values] (swap! calls conj [:unsafe text (some-> values vec)])
                         (js/Promise.resolve (to-array rows))))
    sql))

(deftest session-roundtrip-statements
  (async done
    (let [calls (atom [])
          ^js store (ap/create-sql-auth-persistence-js (fake-sql calls []))]
      (-> (.setSession store #js {:id "s" :subject "u" :clientId "c" :scopes #js ["a"] :extra #js {:k 1} :expiresAt 9})
          (.then (fn [_] (.setAccessToken store #js {:token "t" :clientId "c" :subject "u" :scopes #js [] :extra 0 :resource "r" :expiresAt 1})))
          (.then (fn [_]
                   (let [[[_ strings values] [_ _ token-values]] @calls]
                     (is (= "\n      INSERT INTO sessions (id, subject, client_id, scopes, resource, extra, expires_at)\n      VALUES (\n        " (first strings)))
                     (is (= 8 (count strings)))
                     (is (= ["s" "u" "c" "[\"a\"]" nil "{\"k\":1}" 9] values) "absent resource is null, extra is JSON")
                     (is (= ["t" "c" "u" "[]" "r" nil 1] token-values) "a falsy extra (0) is stored as NULL, as in TS"))
                   (done)))))))

(deftest reads-and-cleanup
  (async done
    (let [calls (atom [])
          ^js store (ap/create-sql-auth-persistence-js (fake-sql calls []))]
      (-> (.getSession store "x")
          (.then (fn [session]
                   (is (undefined? session) "no row -> undefined")
                   (.updateRefreshTokenExtra store "t" #js {:a 1})))
          (.then (fn [updated?]
                   (is (false? updated?))
                   (.cleanup store)))
          (.then (fn [n]
                   (is (= 6 n) "three deletes, each reporting count 2")
                   (is (= [:unsafe "UPDATE refresh_tokens SET extra = $2::jsonb WHERE token = $1 RETURNING token" ["t" "{\"a\":1}"]]
                          (nth @calls 1)))
                   (done)))))))
