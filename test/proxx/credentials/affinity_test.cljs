(ns proxx.credentials.affinity-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials.affinity :as aff]
            [proxx.processor :as processor]))

(deftest blank-inputs-do-nothing
  (is (nil? (aff/upsert-plan "  " "p" "a" 1)))
  (is (nil? (aff/note-success-plan nil "k" "" "a" 1)))
  (is (nil? (aff/note-success-plan nil "k" "p" " " 1))))

(deftest note-success-transitions
  (let [first-plan (aff/note-success-plan nil " k " " p " " a " 10)]
    (is (= :upsert (:op first-plan)))
    (is (= ["k" "p" "a" nil nil 0 10] (:params first-plan)))
    (let [pinned (:record first-plan)
          other-1 (aff/note-success-plan pinned "k" "p" "b" 20)
          other-2 (aff/note-success-plan (:record other-1) "k" "p" "b" 30)]
      (is (= ["k" "p" "a" "p" "b" 1 20] (:params other-1)) "first success of a challenger stays provisional")
      (is (= :promote (:op other-2)))
      (is (= ["k" "p" "b" 30] (:params other-2)))
      (is (= :upsert (:op (aff/note-success-plan (:record other-1) "k" "p" "a" 40)))
          "the pinned account succeeding clears the challenger"))))

(deftest same-transition-as-the-processor
  ;; processor/apply-affinity-event reads the clock itself, so compare the
  ;; fields that do not depend on it.
  (let [strip #(dissoc % :updated-at)
        ev (fn [p a] {:type :note-success :prompt-cache-key "k" :provider-id p :account-id a})
        run (fn [events]
              (reduce (fn [[mine theirs] [p a]]
                        [(:record (aff/note-success-plan mine "k" p a 1))
                         (processor/apply-affinity-event theirs (ev p a) {:promotion-threshold aff/promotion-success-count})])
                      [nil nil] events))]
    (doseq [events [[["p" "a"]] [["p" "a"] ["p" "b"]] [["p" "a"] ["p" "b"] ["p" "b"]]
                    [["p" "a"] ["p" "b"] ["p" "c"] ["p" "c"]] [["p" "a"] ["p" "b"] ["p" "a"]]]]
      (let [[mine theirs] (run events)]
        (is (= (strip theirs) (strip mine)) (pr-str events))))))

(deftest rows
  (is (= {:prompt-cache-key "k" :provider-id "p" :account-id "a" :updated-at 5}
         (aff/row->record {"prompt_cache_key" "k" "provider_id" "p" "account_id" "a" "provisional_provider_id" nil
                           "provisional_account_id" nil "provisional_success_count" 0 "updated_at" 5})))
  (is (= 2 (:provisional-success-count
            (aff/row->record {"prompt_cache_key" "k" "provider_id" "p" "account_id" "a" "provisional_success_count" 2})))))
