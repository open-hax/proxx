(ns proxx.budget.law-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.budget.law :as law]))

(def limits {:daily-microusd 500000 :monthly-microusd 5000000})

(deftest reservation-rounds-up-and-rejects-unknown-pricing
  (is (= 1 (law/reservation-microusd 1 1 0.13 0.38)))
  (is (= 510000 (law/reservation-microusd 1000000 1000000 0.13 0.38)))
  (doseq [args [[1 1 nil 0.38] [1 1 0.13 nil] [-1 1 0.13 0.38]
                [1 1 js/NaN 0.38] [1 js/Infinity 0.13 0.38]]]
    (is (nil? (apply law/reservation-microusd args)))))

(deftest both-caps-include-reservations
  (is (= :admit (law/admission limits {:daily-microusd 499999 :monthly-microusd 4999999} 1)))
  (is (= :daily-limit (law/admission limits {:daily-microusd 499999 :monthly-microusd 0} 2)))
  (is (= :monthly-limit (law/admission limits {:daily-microusd 0 :monthly-microusd 4999999} 2)))
  (is (= :daily-limit (law/admission limits {:daily-microusd 500000 :monthly-microusd 5000000} 1))))

(deftest incomplete-budget-state-fails-closed
  (doseq [usage [nil {} {:daily-microusd -1 :monthly-microusd 0}]]
    (is (= :unavailable (law/admission limits usage 1))))
  (is (= :unavailable (law/admission {} {:daily-microusd 0 :monthly-microusd 0} 1)))
  (is (= :unavailable (law/admission limits {:daily-microusd 0 :monthly-microusd 0} nil))))

(deftest unknown-usage-does-not-release-a-reservation
  (is (= 100 (law/settled-charge 100 nil)))
  (is (= 100 (law/settled-charge 100 -1)))
  (is (= 40 (law/settled-charge 100 40)))
  ;; Record an unexpected overrun truthfully; do not conceal it by clamping cost.
  (is (= 120 (law/settled-charge 100 120))))
