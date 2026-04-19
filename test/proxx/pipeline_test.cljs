(ns proxx.pipeline-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.pipeline :as pl]
            [proxx.store.hot :as hot]))

;; ══════════════════════════════════════════════════════════════
;; Helpers
;; ══════════════════════════════════════════════════════════════

(defn hot-pipeline
  "Builds a pipeline with two independent HotCache stores so we can
   test back-fill across 'layers' without needing Redis or Postgres."
  []
  {:stores {:hot   (hot/->HotCache (atom {}))
            :redis (hot/->HotCache (atom {}))  ;; simulated second layer
            :lmdb  nil
            :postgres nil}})

(defn provider-record [id]
  {:id id :display-name "Test" :enabled true
   :provenance {:source :rest :ingested-at 1713484800000 :request-id "req-1"}})

;; ══════════════════════════════════════════════════════════════
;; route! tests
;; ══════════════════════════════════════════════════════════════

(deftest route-writes-hot-and-declared-chain
  (let [pipeline (hot-pipeline)
        rec      (provider-record "openai")]
    (pl/route! pipeline :provider rec)
    ;; hot was written
    (is (some? (get-in @(-> pipeline :stores :hot :state-atom)
                       [:provider "openai"])))
    ;; declared write-through chain for :provider includes :redis
    (is (some? (get-in @(-> pipeline :stores :redis :state-atom)
                       [:provider "openai"])))))

(deftest route-returns-record
  (let [pipeline (hot-pipeline)
        rec      (provider-record "anthropic")]
    (is (= rec (pl/route! pipeline :provider rec)))))

;; ══════════════════════════════════════════════════════════════
;; fetch! tests
;; ══════════════════════════════════════════════════════════════

(deftest fetch-returns-nil-on-miss
  (let [pipeline (hot-pipeline)]
    (is (nil? (pl/fetch! pipeline :provider "does-not-exist")))))

(deftest fetch-returns-record-from-hot
  (let [pipeline (hot-pipeline)
        rec      (provider-record "openai")]
    (pl/route! pipeline :provider rec)
    (is (= rec (pl/fetch! pipeline :provider "openai")))))

(deftest fetch-backfills-hot-from-downstream
  ;; Seed a record only in the 'redis' layer (second layer);
  ;; hot cache is empty. fetch! should find it in redis,
  ;; back-fill hot, and return the record.
  (let [pl    (hot-pipeline)
        rec   (provider-record "ollama")
        redis (get-in pl [:stores :redis])]
    (require '[proxx.store.protocol :refer [store-put]])
    ((resolve 'proxx.store.protocol/store-put) redis :provider "ollama" rec)
    (let [result (pl/fetch! pl :provider "ollama")]
      (is (= rec result))
      ;; back-fill: hot should now contain it
      (is (some? (get-in @(-> pl :stores :hot :state-atom)
                         [:provider "ollama"]))))))

;; ══════════════════════════════════════════════════════════════
;; record-key derivation
;; ══════════════════════════════════════════════════════════════

(deftest route-throws-on-unkeyed-record
  (let [pipeline (hot-pipeline)]
    (is (thrown-with-msg?
          js/Error #"Cannot derive key from record"
          (pl/route! pipeline :provider {:display-name "No ID"})))))
