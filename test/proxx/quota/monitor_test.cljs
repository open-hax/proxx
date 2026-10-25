(ns proxx.quota.monitor-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.quota.monitor :as m]))

(def now 1700000000000)
(def cfg {:provider-id "openai" :warning-threshold 90})

(defn- snap
  ([id used] (snap id used nil))
  ([id used rate-limit]
   {:account-id id :five-hour (when used {:used-percent used :reset-after-seconds 3600}) :weekly nil :rate-limit rate-limit}))

(deftest exhaustion-trusts-only-explicit-signals
  (is (false? (:exhausted? (m/quota-status (snap "a" 99) cfg))) "low remaining quota is still usable")
  (is (true? (:exhausted? (m/quota-status (snap "a" 10 {:limit-reached true}) cfg))))
  (is (true? (:exhausted? (m/quota-status (snap "a" 10 {:allowed false}) cfg))))
  (is (false? (:exhausted? (m/quota-status (snap "a" 10 {:allowed nil :limit-reached false}) cfg)))))

(deftest warnings
  (is (true? (:warning? (m/quota-status (snap "a" 90) cfg))))
  (is (false? (:warning? (m/quota-status (snap "a" 89.9) cfg))))
  (is (false? (:warning? (m/quota-status (snap "a" 99 {:limit-reached true}) cfg))) "exhausted accounts are not merely warned")
  (testing "a missing window borrows the other's usage"
    (is (= [40 40] ((juxt :five-hour-used-percent :weekly-used-percent)
                    (m/quota-status {:weekly {:used-percent 40}} cfg))))))

(deftest cooldown-from-quota
  (let [rec {:five-hour-reset-after-seconds 7200 :weekly-reset-after-seconds 60}]
    (is (= 7200000 (m/cooldown-ms rec now)) "the five-hour window wins")
    (is (= 60000 (m/cooldown-ms (dissoc rec :five-hour-reset-after-seconds) now))))
  (is (= 5000 (m/cooldown-ms {:five-hour-resets-at "2023-11-14T22:13:25.000Z"} now)) "absolute reset: time left")
  (is (nil? (m/cooldown-ms {:five-hour-resets-at "2020-01-01T00:00:00Z"} now)) "a reset in the past says nothing")
  (is (= 0 (m/cooldown-ms {:five-hour-reset-after-seconds 0 :weekly-reset-after-seconds 60} now))
      "a relative reset of 0 is an answer; it does not fall through to the weekly window")
  (testing "healthy accounts carry reset windows too and must not yield a cooldown"
    (is (nil? (m/exhausted-cooldown-ms {:exhausted? false :five-hour-reset-after-seconds 168463} now)))
    (is (= 5400000 (m/exhausted-cooldown-ms {:exhausted? true :five-hour-reset-after-seconds 5400} now)))))

(deftest snapshots-drive-effects
  (let [{:keys [state effects record]} (m/apply-snapshot m/empty-state (snap "a" 100 {:limit-reached true}) cfg now)]
    (is (contains? (:exhausted state) "a"))
    (is (= [[:quota-exhausted "openai" "a" 100] [:set-cooldown "openai" "a" (+ now 3600000)]] effects))
    (is (= now (:fetched-at record)))
    (testing "a later healthy snapshot is a reset"
      (let [r (m/apply-snapshot state (snap "a" 5) cfg (+ now 1000))]
        (is (not (contains? (:exhausted (:state r)) "a")))
        (is (= [[:quota-reset "openai" "a"] [:clear-cooldown "openai" "a"] [:log-reset "a" 5]] (:effects r)))))
    (testing "no wait, no cooldown effect (a relative reset of 0 seconds)"
      (let [s (assoc-in (snap "b" 100 {:limit-reached true}) [:five-hour :reset-after-seconds] 0)]
        (is (= [[:quota-exhausted "openai" "b" 100]] (:effects (m/apply-snapshot m/empty-state s cfg now))))))
    (testing "the log distinguishes a window without usage (null) from no window (undefined)"
      (let [exhausted (:state (m/apply-snapshot m/empty-state (snap "c" 100 {:limit-reached true}) cfg now))]
        (is (= [:log-reset "c" :undefined] (last (:effects (m/apply-snapshot exhausted {:account-id "c"} cfg now)))))
        (is (= [:log-reset "c" :null] (last (:effects (m/apply-snapshot exhausted {:account-id "c" :weekly {:used-percent nil}} cfg now)))))))))

(deftest records-keep-first-seen-order
  (let [s (reduce #(:state (m/apply-snapshot %1 (snap %2 1) cfg now)) m/empty-state ["z" "a" "z" "m"])]
    (is (= ["z" "a" "m"] (map :account-id (m/all-records s))))))

(deftest provider-tracking
  (is (true? (m/tracks-provider? {:provider-id "OpenAI"} " openai ")))
  (is (false? (m/tracks-provider? {:provider-id "openai"} "factory"))))
