(ns proxx.ledger.projector-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [proxx.ledger.projector :as proj]))

;; ── Helpers ───────────────────────────────────────────────────────────────────

(def base-tuple
  {:session-id  "S1"
   :provider-id "openai"
   :account-id  "A1"
   :model-id    "gpt-4o"})

(defn ev [overrides]
  (merge {:event-id   (str (random-uuid))
          :event-type :routing-attempt
          :ts         (js/Date.now)
          :session-id  "S1"
          :provider-id "openai"
          :account-id  "A1"
          :model-id    "gpt-4o"}
         overrides))

;; ── Epoch tests ───────────────────────────────────────────────────────────────

(deftest epoch-0-when-no-failures
  (testing "epoch is sentinel when no failure events exist"
    (let [ledger [(ev {:outcome :success :ts 1000})
                  (ev {:outcome :success :ts 2000})]
          epoch  (proj/current-epoch ledger base-tuple)]
      (is (= ::proj/epoch-0 epoch)))))

(deftest epoch-derived-from-last-failure
  (testing "epoch-id changes when a failure event is added"
    (let [failure-ev (ev {:event-id   "fail-1"
                          :event-type :account-cooldown-initiated
                          :outcome    :quota-exhausted
                          :ts         3000})
          ledger     [(ev {:outcome :success :ts 1000})
                      (ev {:outcome :success :ts 2000})
                      failure-ev]
          epoch      (proj/current-epoch ledger base-tuple)]
      (is (not= ::proj/epoch-0 epoch))
      (is (string? epoch)))))

(deftest epoch-unchanged-with-same-ledger
  (testing "epoch-unchanged? returns true when no new failures"
    (let [failure-ev (ev {:event-id   "fail-1"
                          :event-type :account-cooldown-initiated
                          :ts         3000})
          ledger     [(ev {:outcome :success :ts 1000})
                      failure-ev]
          epoch-id   (proj/current-epoch ledger base-tuple)]
      (is (proj/epoch-unchanged? epoch-id ledger base-tuple)))))

(deftest epoch-changes-after-new-failure
  (testing "epoch-unchanged? returns false after a second failure arrives"
    (let [fail1   (ev {:event-id "fail-1" :event-type :account-cooldown-initiated :ts 2000})
          ledger1 [(ev {:outcome :success :ts 1000}) fail1]
          epoch1  (proj/current-epoch ledger1 base-tuple)
          fail2   (ev {:event-id "fail-2" :event-type :account-cooldown-initiated :ts 4000})
          ledger2 (conj ledger1 fail2)]
      (is (not (proj/epoch-unchanged? epoch1 ledger2 base-tuple))))))

;; ── Cache recoverability ──────────────────────────────────────────────────────

(deftest cache-not-recoverable-without-success
  (testing "cache-recoverable? is false when no success events exist"
    (let [ledger [(ev {:event-type :account-cooldown-initiated :ts 1000})]
          now    (+ 1000 (* 6 60 60 1000))]
      (is (not (proj/cache-recoverable? ledger base-tuple "openai" now))))))

(deftest cache-recoverable-within-ttl-after-short-reset
  (testing "cache-recoverable? is true when within 24h and 5h short window elapsed"
    (let [t0       0
          t-fail   (* 5 60 60 1000)      ;; fail at 5h
          t-now    (* 6 60 60 1000)      ;; check at 6h (5h after failure, inside 24h TTL)
          ledger   [(ev {:outcome :success :ts t0})
                    (ev {:event-type :account-cooldown-initiated :ts t-fail})]]
      (is (proj/cache-recoverable? ledger base-tuple "openai" t-now)))))

(deftest cache-not-recoverable-after-churn
  (testing "cache-recoverable? is false if churn happened after last success"
    (let [t0      0
          t-churn 1000
          t-fail  (* 5 60 60 1000)
          t-now   (* 6 60 60 1000)
          ledger  [(ev {:outcome :success :ts t0})
                   (ev {:event-type :session-churn-detected :ts t-churn})
                   (ev {:event-type :account-cooldown-initiated :ts t-fail})]]
      (is (not (proj/cache-recoverable? ledger base-tuple "openai" t-now))))))

;; ── Prefix similarity ─────────────────────────────────────────────────────────

(deftest prefix-similarity-identical
  (testing "prefix-similarity is 1.0 when counts are equal"
    (is (= 1.0 (proj/prefix-similarity 10 10)))))

(deftest prefix-similarity-half
  (testing "prefix-similarity is 0.5 when current is half original"
    (is (= 0.5 (proj/prefix-similarity 10 5)))))

(deftest prefix-similarity-zero-guard
  (testing "prefix-similarity returns 0.0 when original count is zero or nil"
    (is (= 0.0 (proj/prefix-similarity 0 10)))
    (is (= 0.0 (proj/prefix-similarity nil 10)))))
