(ns proxx.credentials.health-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials.health :as h]))

(def now 1700000000000)
(def hour 3600000)

(deftest scoring
  (is (= 1 (h/health-score {} "p" "a" now nil)) "unknown accounts are presumed healthy")
  (is (= 0.1 (h/health-score {} "p" "a" now (- now 1))) "expired credential")
  (let [s (h/record-success {} "p" "a" 200 now)]
    (is (= 1 (h/health-score s "p" "a" now nil)) "1.0 + bonuses, clamped")
    (is (= 0.1 (h/health-score s "p" "a" now now)) "expires exactly now"))
  (let [s (-> {} (h/record-failure "p" "a" 500 "e" now))]
    (is (< (h/health-score s "p" "a" now nil) 0.1) "all failures, recent: rate 0 - 0.2 -> 0 floor")
    (is (zero? (h/health-score s "p" "a" now nil))))
  (let [s (h/record-quota-exhausted {} "p" "a" 100 now)]
    (is (= 0.0 (h/health-score s "p" "a" now nil)) "0.5 - 0.5")
    (is (= 0.2 (h/health-score s "p" "a" (+ now (* 2 hour)) nil)) "0.5 - 0.3")
    (is (= 0.5 (h/health-score s "p" "a" (+ now (* 30 hour)) nil)))))

(deftest quota-exhaustion-expires
  (let [s (h/record-quota-exhausted {} "p" "a" 90 now)]
    (is (= [true s] (h/quota-exhausted? s "p" "a" 1000 (+ now 999))))
    (let [[exhausted? s'] (h/quota-exhausted? s "p" "a" 1000 (+ now 1000))]
      (is (false? exhausted?))
      (is (= {:exhausted-at nil :used-percent nil} (h/quota-status s' "p" "a")) "the stale exhaustion is forgotten"))))

(deftest growing-cooldown
  (let [s0 (-> {} (h/record-failure "p" "a" 500 nil now) (h/record-failure "p" "a" 500 nil now) (h/record-failure "p" "a" 500 nil now))
        [c1 s1] (h/growing-cooldown s0 "p" "a" 1000 now)]
    (is (= 4000 c1) "base * 2^(streak-1)")
    (is (= [4000 s1] (h/growing-cooldown s1 "p" "a" 1000 now)) "an unexpired cooldown is not recomputed")
    (is (= [3000 s1] (h/growing-cooldown s1 "p" "a" 1 (+ now 1000))) "never shorter than what remains")
    (is (= [1000 {}] (h/growing-cooldown {} "p" "a" 1000 now)))
    (let [[c _] (h/growing-cooldown (h/record-success s0 "p" "a" 200 now) "p" "a" 1000 now)]
      (is (= 1000 c) "success resets the streak"))
    (is (= h/max-cooldown-ms (first (h/growing-cooldown s0 "p" "a" 1e9 now))))))

(deftest flush-aggregation-and-order
  (let [w (fn [t k ts] {:type t :provider-id "p" :account-id k :timestamp ts :status 200 :error (when (= t :failure) "e")})
        writes [(w :success "a" 5) (w :failure "b" 6) (w :success "a" 7) (w :success "a" 4)]
        {:keys [successes failures last-type]} (h/aggregate-writes writes)]
    (is (= [{:provider-id "p" :account-id "a" :count 3 :last-success-at 7 :last-status 200}] successes)
        "the newest timestamp wins last-*; the count covers all")
    (is (= 1 (count failures)))
    (is (= :success last-type) "timestamp 7 is the newest write")
    (is (= [:failure :success] (map first (h/flush-plan writes))) "the newest kind is flushed last"))
  (is (= [] (h/flush-plan [])))
  (is (= 3 (count (h/flush-plan (for [i (range 401)] {:type :success :provider-id "p" :account-id (str i) :timestamp i :status 200}))))
      "200 rows per statement"))

(deftest chunk-queries
  (let [[text values] (h/success-chunk-query [{:provider-id "p" :account-id "a" :count 2 :last-success-at 5 :last-status 200}
                                              {:provider-id "p" :account-id "b" :count 1 :last-success-at 6 :last-status 201}] 99)]
    (is (.includes text "VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)"))
    (is (= ["p" "a" 2 5 200 99 "p" "b" 1 6 201 99] values))
    (is (.startsWith text "\nWITH input(")))
  (is (= 7 (count (second (h/failure-chunk-query [{:provider-id "p" :account-id "a" :count 1 :last-failure-at 1 :last-error nil :last-status 500}] 9))))))

(deftest row-parsing
  (let [row (h/parse-health-row {"provider_id" "p" "account_id" "a" "success_count" "x" "failure_count" "7"
                                 "last_success_at" "" "last_failure_at" "123" "last_error" nil "last_status" "429"})]
    (is (= 0 (:success-count row)))
    (is (= 7 (:failure-count row)))
    (is (nil? (:last-success-at row)))
    (is (= 123 (:last-failure-at row)))
    (is (= 429 (:last-status row)))))
