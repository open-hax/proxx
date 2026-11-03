;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.policy.model-availability-test
  (:require #?(:clj [clojure.test :refer [deftest is]]
               :cljs [cljs.test :refer [deftest is]])
            [proxx.policy.model-availability :as availability]))

(def baseline
  {:provider-id "coding" :endpoint "https://provider.example/models"
   :scope "membership-profile" :source-kind :provider-catalog
   :status :ok :authoritative? true :complete? true :observed-at-ms 1000
   :models {"alias" {:target-id "version-1"
                     :capabilities {:context 262144 :reasoning false
                                    :input #{:text :image}}}}})

(def options {:now-ms 2000 :max-age-ms 1000})

(defn assess [current]
  (availability/assess-model baseline current "alias" options))

(deftest absence-is-not-always-delisting
  (is (= :delisted (:availability (assess (assoc baseline :models {} :observed-at-ms 2000)))))
  (is (= :unlisted (:availability
                   (availability/assess-model nil (assoc baseline :models {} :observed-at-ms 2000)
                                              "alias" options))))
  (doseq [snapshot [(assoc baseline :status :http-error :http-status 401 :models {})
                    (assoc baseline :status :http-error :http-status 429 :models {})
                    (assoc baseline :status :transport-error :models {})
                    (assoc baseline :complete? false :models {})
                    (assoc baseline :authoritative? false :models {})
                    (assoc baseline :observed-at-ms 999 :models {})
                    (assoc baseline :observed-at-ms 2001 :models {})
                    (assoc baseline :stale? true :models {})
                    (dissoc baseline :models)
                    nil]]
    (is (= :unknown (:availability (assess snapshot))))))

(deftest listing-is-not-execution-proof
  (let [result (assess (assoc baseline :observed-at-ms 2000 :complete? false))]
    (is (= :listed (:availability result)))
    (is (= :catalog-only (:assurance result)))
    (is (not (contains? result :registered?)))
    (is (nil? (:executed-model result)))
    (is (= 2000 (get-in result [:evidence :current :observed-at-ms])))))

(deftest scope-and-order-protect-removal-evidence
  (doseq [snapshot [(assoc baseline :scope "another-profile" :models {} :observed-at-ms 2000)
                    (assoc baseline :provider-id "another-provider" :models {} :observed-at-ms 2000)
                    (assoc baseline :endpoint "https://other.example/models" :models {} :observed-at-ms 2000)
                    (assoc baseline :observed-at-ms 999 :models {})]]
    (is (not= :delisted (:availability (assess snapshot))))))

(deftest fingerprints-detect-same-alias-capability-change
  (let [current (-> baseline
                    (assoc :observed-at-ms 2000)
                    (assoc-in [:models "alias" :capabilities :context] 1048576))
        result (assess current)]
    (is (= :listed (:availability result)))
    (is (= #{:capabilities-changed} (:drift result)))
    (is (not= (:baseline-fingerprint result) (:current-fingerprint result))))
  (is (= #{:alias-target-changed}
         (:drift (assess (-> baseline (assoc :observed-at-ms 2000)
                             (assoc-in [:models "alias" :target-id] "version-2")))))))

(deftest fingerprints-are-portable-order-independent-and-tristate
  (is (= (availability/capability-fingerprint {:capabilities {:a 1 :b #{:text :image}}})
         (availability/capability-fingerprint {:capabilities {:b #{:image :text} :a 1}})))
  (is (not= (availability/capability-fingerprint {:capabilities {:reasoning false}})
            (availability/capability-fingerprint {:capabilities {:reasoning nil}})))
  (is (nil? (availability/capability-fingerprint {})))
  (is (= #{:capability-evidence-lost}
         (:drift (assess (assoc-in (assoc baseline :observed-at-ms 2000)
                                  [:models "alias"] {}))))))

(deftest failed-observations-do-not-overwrite-last-good-baseline
  (is (= baseline (availability/advance-baseline baseline (assoc baseline :status :http-error) options)))
  (is (= baseline (availability/advance-baseline baseline (assoc baseline :complete? false) options)))
  (is (= baseline (availability/advance-baseline baseline (assoc baseline :scope "other") options)))
  (is (= baseline (availability/advance-baseline baseline (assoc baseline :observed-at-ms 999) options)))
  (let [empty-success (assoc baseline :observed-at-ms 2000 :models {})]
    (is (= empty-success (availability/advance-baseline baseline empty-success options)))))

(deftest invalid-clock-and-schema-remain-unknown
  (doseq [opts [{:now-ms 2000 :max-age-ms 0} {:now-ms nil :max-age-ms 1000}]
          :let [result (availability/assess-model baseline baseline "alias" opts)]]
    (is (= :unknown (:availability result))))
  (is (= :unknown (:availability (assess (assoc baseline :models {"alias" nil}))))))

(deftest collection-provenance-is-not-interchangeable
  (let [live (assoc baseline :collection-mode :authenticated-get)
        supplied (assoc live :collection-mode :supplied :observed-at-ms 2000 :models {})]
    (is (not= :delisted (:availability (availability/assess-model live supplied "alias" options))))
    (is (= live (availability/advance-baseline live supplied options)))))
