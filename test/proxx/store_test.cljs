(ns proxx.store-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.store.protocol :refer [store-get store-put store-delete store-list store-close]]
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
  (let [s (seed/->SeedStore {:provider [{:id "foo"} {:id "bar"}]})]
    (is (= [{:id "foo"} {:id "bar"}] (store-list s :provider)))
    (is (= {:id "foo"} (store-get s :provider "foo")))
    (store-put s :provider "k" {:id "baz"})
    (is (= [{:id "foo"} {:id "bar"}] (store-list s :provider)))))
