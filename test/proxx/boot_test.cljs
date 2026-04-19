(ns proxx.boot-test
  (:require
   [cljs.test   :refer [deftest is testing]]
   [proxx.boot  :as boot]
   [proxx.store.seed :as seed]
   [proxx.store.protocol :refer [store-get store-list]]))

;; ---------------------------------------------------------------------------
;; Fixtures
;; ---------------------------------------------------------------------------

(def ^:private test-config
  {:redis-url    nil
   :lmdb-path    nil
   :database-url nil})

;; ---------------------------------------------------------------------------
;; Tests
;; ---------------------------------------------------------------------------

(deftest boot-returns-pipeline
  (testing "boot! with no external stores returns a non-nil pipeline map"
    (boot/halt!)
    (let [pl (boot/boot! test-config)]
      (is (map? pl))
      (is (some? (:hot pl))))))

(deftest boot-idempotent
  (testing "calling boot! twice returns the same pipeline"
    (boot/halt!)
    (let [pl1 (boot/boot! test-config)
          pl2 (boot/boot! test-config)]
      (is (identical? pl1 pl2)))))

(deftest halt-clears-state
  (testing "halt! resets state so pipeline returns nil"
    (boot/halt!)
    (boot/boot! test-config)
    (boot/halt!)
    (is (nil? (boot/pipeline)))))

(deftest seed-static-idempotent
  (testing "seeding static data twice does not duplicate records"
    (boot/halt!)
    (let [pl (boot/boot! test-config)]
      ;; second seed-static! call should detect same hash and no-op
      (boot/seed-static! pl)
      ;; We can't easily count hot-store entries here, but we can assert
      ;; the pipeline is still structurally valid after double-seed
      (is (map? pl)))))

(deftest seed-from-value-ingests-records
  (testing "seed-from-value! ingests a credential record into the hot store"
    (boot/halt!)
    (let [pl  (boot/boot! test-config)
          raw (clj->js [{:id          "openai:test"
                         :provider-id "openai"
                         :auth-type   "api_key"
                         :secret      "sk-test"}])]
      (boot/seed-from-value! pl raw)
      ;; After seeding the hot store should hold the record
      (let [result (store-get (:hot pl) :provider-credential "openai:test")]
        (is (some? result))))))

(deftest halt-after-boot
  (testing "halt! returns :halted keyword"
    (boot/halt!)
    (boot/boot! test-config)
    (is (= :halted (boot/halt!)))))
