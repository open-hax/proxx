(ns proxx.store-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.store.protocol :refer [IStore store-get store-put store-delete store-list store-close]]
            [proxx.store.hot :as hot]
            [proxx.store.seed :as seed]))

(deftest hot-cache-roundtrip
  (let [s   (hot/->HotCache (atom {}))
        key "k1"
        rec {:id "foo"}]
    (store-put s :provider key rec)
    (is (= rec (store-get s :provider key)))
    (is (= [rec] (store-list s :provider)))
    (store-delete s :provider key)
    (is (nil? (store-get s :provider key)))
    (store-close s)
    (is (empty? (store-list s :provider)))))

(deftest seed-store-read-only
  (let [s (seed/->SeedStore {:provider [{:id "foo"}]})]
    (is (= [{:id "foo"}] (store-list s :provider)))
    (is (= [{:id "foo"}] (store-get s :provider nil)))
    (store-put s :provider "k" {:id "bar"})
    (is (= [{:id "foo"}] (store-list s :provider)))))
