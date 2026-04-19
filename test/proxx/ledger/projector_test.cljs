(ns proxx.ledger.projector-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [proxx.ledger.projector :as proj]))

;; ── Helpers ──────────────────────────────────────────────────────────────────

(def base-tuple
  {:session-id  "S1"
   :provider-id "openai"
   :account-id  "A1"
   :model-id    "gpt-4o"})

(defn mk-ev
  "Minimal ledger event merged over base-tuple fields."
  [overrides]
  (merge {:event-id   (str (random-uuid))
          :event-type :routing-attempt
          :ts         0
          :session-id  "S1"
          :provider-id "openai"
          :account-id  "A1"
          :model-id    "gpt-4o"}
         overrides))

;; ── Epoch ────────────────────────────────────────────────────────────────────

(deftest epoch-0-when-no-failures
  (testing "epoch is sentinel when no failure events exist"
    (let [ledger [(mk-ev {:outcome :success :ts 1000})
                  (mk-ev {:outcome :success :ts 2000})]
          epoch  (proj/current-epoch ledger base-tuple)]
      (is (= ::proj/epoch-0 epoch)))))

(deftest epoch-derived-from-last-failure
  (testing "epoch-id is a string derived from the failure event"
    (let [fail-ev (mk-ev {:event-id   "fail-1"
                          :event-type :account-cooldown-initiated
                          :ts         3000})
          ledger  [(mk-ev {:outcome :success :ts 1000})
                   (mk-ev {:outcome :success :ts 2000})
                   fail-ev]
          epoch   (proj/current-epoch ledger base-tuple)]
      (is (not= ::proj/epoch-0 epoch))
      (is (string? epoch)))))

(deftest epoch-unchanged-with-same-ledger
  (testing "epoch-unchanged? true when no new failures"
    (let [fail-ev  (mk-ev {:event-id "fail-1" :event-type :account-cooldown-initiated :ts 3000})
          ledger   [(mk-ev {:outcome :success :ts 1000}) fail-ev]
          epoch-id (proj/current-epoch ledger base-tuple)]
      (is (proj/epoch-unchanged? epoch-id ledger base-tuple)))))

(deftest epoch-changes-after-new-failure
  (testing "epoch-unchanged? false after a second failure"
    (let [fail1   (mk-ev {:event-id "fail-1" :event-type :account-cooldown-initiated :ts 2000})
          ledger1 [(mk-ev {:outcome :success :ts 1000}) fail1]
          epoch1  (proj/current-epoch ledger1 base-tuple)
          fail2   (mk-ev {:event-id "fail-2" :event-type :account-cooldown-initiated :ts 4000})
          ledger2 (conj ledger1 fail2)]
      (is (not (proj/epoch-unchanged? epoch1 ledger2 base-tuple))))))

;; ── Cache recoverability ─────────────────────────────────────────────────────
;;
;; OpenAI provider-cache-config:
;;   :cache-ttl-ms          24h = 86_400_000 ms
;;   :short-quota-window-ms  5h = 18_000_000 ms
;;
;; For cache-recoverable? to return true:
;;   (< (- now success-ts) 86_400_000)   → now must be within 24h of last success
;;   (>= (- now failure-ts) 18_000_000)  → now must be ≥5h after last failure

(deftest cache-not-recoverable-without-success
  (testing "cache-recoverable? false when no success events"
    (let [ledger [(mk-ev {:event-type :account-cooldown-initiated :ts 1000})]
          now    (+ 1000 (* 6 60 60 1000))]
      (is (not (proj/cache-recoverable? ledger base-tuple "openai" now))))))

(deftest cache-recoverable-within-ttl-after-short-reset
  (testing "cache-recoverable? true: within 24h of success, ≥5h after failure"
    (let [t-success 0
          t-fail    (* 1 60 60 1000)    ;; fail at  1h
          t-now     (* 6 60 60 1000)    ;; check at 6h → 5h after failure ✓, 6h after success (< 24h) ✓
          ledger    [(mk-ev {:outcome :success :ts t-success})
                     (mk-ev {:event-type :account-cooldown-initiated :ts t-fail})]]
      (is (proj/cache-recoverable? ledger base-tuple "openai" t-now)))))

(deftest cache-expired-beyond-ttl
  (testing "cache-recoverable? false when beyond 24h TTL since last success"
    (let [t-success 0
          t-fail    (* 1  60 60 1000)   ;; fail at  1h
          t-now     (* 25 60 60 1000)   ;; check at 25h → beyond 24h TTL
          ledger    [(mk-ev {:outcome :success :ts t-success})
                     (mk-ev {:event-type :account-cooldown-initiated :ts t-fail})]]
      (is (not (proj/cache-recoverable? ledger base-tuple "openai" t-now))))))

(deftest cache-not-recoverable-short-window-not-elapsed
  (testing "cache-recoverable? false when < 5h since failure"
    (let [t-success 0
          t-fail    (* 1 60 60 1000)    ;; fail at 1h
          t-now     (* 2 60 60 1000)    ;; check at 2h → only 1h after failure, need 5h
          ledger    [(mk-ev {:outcome :success :ts t-success})
                     (mk-ev {:event-type :account-cooldown-initiated :ts t-fail})]]
      (is (not (proj/cache-recoverable? ledger base-tuple "openai" t-now))))))

(deftest cache-not-recoverable-after-churn
  (testing "cache-recoverable? false if churn occurred after last success"
    (let [t-success 0
          t-churn   (* 1 60 60 1000)
          t-fail    (* 2 60 60 1000)
          t-now     (* 8 60 60 1000)   ;; 6h after failure, within 24h TTL — would pass without churn
          ledger    [(mk-ev {:outcome :success      :ts t-success})
                     (mk-ev {:event-type :session-churn-detected       :ts t-churn})
                     (mk-ev {:event-type :account-cooldown-initiated    :ts t-fail})]]
      (is (not (proj/cache-recoverable? ledger base-tuple "openai" t-now))))))

;; ── Prefix similarity ────────────────────────────────────────────────────────

(deftest prefix-similarity-identical
  (testing "1.0 when counts are equal"
    (is (= 1.0 (proj/prefix-similarity 10 10)))))

(deftest prefix-similarity-half
  (testing "0.5 when current is half original"
    (is (= 0.5 (proj/prefix-similarity 10 5)))))

(deftest prefix-similarity-zero-guard
  (testing "0.0 when original count is zero or nil"
    (is (= 0.0 (proj/prefix-similarity 0 10)))
    (is (= 0.0 (proj/prefix-similarity nil 10)))))
