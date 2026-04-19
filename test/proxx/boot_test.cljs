(ns proxx.boot-test
  (:require
   [cljs.test          :refer [deftest is testing]]
   [proxx.boot         :as boot]
   [proxx.store.hot    :as hot]
   [proxx.store.protocol :refer [store-get store-put]]))

;; ---------------------------------------------------------------------------
;; Fixtures
;; ---------------------------------------------------------------------------

(def ^:private no-external-config
  {:redis-url    nil
   :lmdb-path    nil
   :database-url nil})

(def ^:private fixture-map
  {:provider-model
   [{:id "gpt-4" :provider-id "openai" :name "GPT-4"}]
   :provider-credential
   [{:id "openai:fixture" :provider-id "openai" :auth-type "api_key" :secret "sk-fixture"}]})

;; ---------------------------------------------------------------------------
;; Tests
;; ---------------------------------------------------------------------------

(deftest boot-returns-pipeline
  (testing "boot! with no external stores returns a pipeline map with :stores key"
    (boot/halt!)
    (let [pl (boot/boot! no-external-config)]
      (is (map? pl))
      (is (contains? pl :stores)))))

(deftest boot-idempotent
  (testing "calling boot! twice returns the identical pipeline object"
    (boot/halt!)
    (let [pl1 (boot/boot! no-external-config)
          pl2 (boot/boot! no-external-config)]
      (is (identical? pl1 pl2)))))

(deftest halt-clears-state
  (testing "halt! resets state so (pipeline) returns nil"
    (boot/halt!)
    (boot/boot! no-external-config)
    (boot/halt!)
    (is (nil? (boot/pipeline)))))

(deftest halt-returns-keyword
  (testing "halt! returns :halted"
    (boot/halt!)
    (boot/boot! no-external-config)
    (is (= :halted (boot/halt!)))))

(deftest seed-static-ingests-fixture
  (testing "seed-static! writes fixture records into the hot store"
    (boot/halt!)
    (let [pl (boot/boot! (assoc no-external-config :fixture-map fixture-map))
          hot-store (get-in pl [:stores :hot])]
      ;; fixture-map was seeded during boot!
      (is (some? (store-get hot-store :provider-model "gpt-4"))))))

(deftest seed-static-idempotent
  (testing "seeding the same fixture twice does not throw"
    (boot/halt!)
    (let [pl (boot/boot! no-external-config)]
      (boot/seed-static! pl fixture-map)
      (boot/seed-static! pl fixture-map)
      (is (map? pl)))))

(deftest seed-from-value-ingests-record
  (testing "seed-from-value! writes a credential into the hot store"
    (boot/halt!)
    (let [pl  (boot/boot! no-external-config)
          raw (clj->js [{:id          "openai:test"
                         :provider-id "openai"
                         :auth-type   "api_key"
                         :secret      "sk-test"}])]
      (boot/seed-from-value! pl raw)
      (let [hot-store (get-in pl [:stores :hot])]
        (is (some? (store-get hot-store :provider-credential "openai:test")))))))
