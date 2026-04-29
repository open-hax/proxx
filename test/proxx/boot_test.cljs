(ns proxx.boot-test
  (:require
   [cljs.test            :refer [deftest is testing]]
   [proxx.boot           :as boot]
   [proxx.store.protocol :refer [store-get]]))

;; ---------------------------------------------------------------------------
;; Fixtures
;; provider-model must satisfy ProviderModel schema:
;;   :provider-id :model-id :context-tokens :streaming :vision
;; provider-credential must satisfy the schema used by seed ingestion.
;; ---------------------------------------------------------------------------

(def ^:private no-external-config
  {:redis-url    nil
   :lmdb-path    nil
   :database-url nil})

(def ^:private fixture-map
  {:provider-model
   [{:id             "gpt-4"
     :provider-id    "openai"
     :model-id       "gpt-4"
     :context-tokens 8192
     :streaming      true
     :vision         false}]})

;; ---------------------------------------------------------------------------
;; Tests
;; ---------------------------------------------------------------------------

(deftest boot-returns-pipeline
  (testing "boot! with no external stores returns a pipeline map"
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
  (testing "fixture-map passed to boot! is readable from the hot store"
    (boot/halt!)
    (let [pl        (boot/boot! (assoc no-external-config :fixture-map fixture-map))
          hot-store (get-in pl [:stores :hot])]
      (is (some? (store-get hot-store :provider-model "gpt-4"))))))

(deftest seed-static-idempotent
  (testing "calling seed-static! twice with the same data does not throw"
    (boot/halt!)
    (let [pl (boot/boot! no-external-config)]
      (boot/seed-static! pl fixture-map)
      (boot/seed-static! pl fixture-map)
      (is (map? pl)))))

(deftest seed-from-value-ingests-record
  (testing "seed-from-value! makes a credential readable from the hot store"
    (boot/halt!)
    (let [pl  (boot/boot! no-external-config)
          raw (clj->js [{:id          "openai:test"
                         :provider-id "openai"
                         :auth-type   "api_key"
                         :secret      "sk-test"}])]
      (boot/seed-from-value! pl raw)
      (let [hot-store (get-in pl [:stores :hot])]
        (is (some? (store-get hot-store :provider-credential "openai:test")))))))
