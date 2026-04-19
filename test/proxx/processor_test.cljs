(ns proxx.processor-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.processor :as p]))

;; ══════════════════════════════════════════════════════════════
;; normalize-keys tests
;; ══════════════════════════════════════════════════════════════

(deftest normalize-keys-basic
  (is (= {:foo-bar  1
          :baz-qux  2
          :inner    {:deep-key 3}
          :seq-val  [{:a-b 1} {:c-d 2}]}
         (p/normalize-keys
          {"fooBar" 1
           "baz_qux" 2
           "inner" {"deepKey" 3}
           "seqVal" [{"aB" 1} {"cD" 2}]}))))

;; ══════════════════════════════════════════════════════════════
;; stamp-provenance tests
;; ══════════════════════════════════════════════════════════════

(deftest stamp-provenance-has-required-keys
  (let [r (p/stamp-provenance {:id "openai"} :rest {:request-id "req-1"})]
    (is (= :rest (get-in r [:provenance :source])))
    (is (int? (get-in r [:provenance :ingested-at])))
    (is (= "req-1" (get-in r [:provenance :request-id]))))
  (let [r (p/stamp-provenance {:id "seed"} :seed {:seed-hash "abc"})]
    (is (= :seed (get-in r [:provenance :source])))
    (is (= "abc" (get-in r [:provenance :seed-hash]))))
  (let [r (p/stamp-provenance {:id "redis"} :redis)]
    (is (= :redis (get-in r [:provenance :source])))))

;; ══════════════════════════════════════════════════════════════
;; apply-affinity-event tests
;; ══════════════════════════════════════════════════════════════

(def base-event
  {:type :note-success
   :prompt-cache-key "abc12345"
   :provider-id "openai"
   :account-id  "acct-1"})

(deftest affinity-new-record-on-first-success
  (let [next (p/apply-affinity-event nil base-event {:promotion-threshold 3})]
    (is (= "abc12345" (:prompt-cache-key next)))
    (is (= "openai" (:provider-id next)))
    (is (= "acct-1" (:account-id next)))
    (is (int? (:updated-at next)))))

(deftest affinity-canonical-bump-clears-provisional
  (let [state {:prompt-cache-key "abc12345"
               :provider-id      "openai"
               :account-id       "acct-1"
               :provisional-provider-id "other"
               :provisional-account-id  "acct-x"
               :provisional-success-count 2
               :updated-at 0}
        next  (p/apply-affinity-event state base-event {:promotion-threshold 3})]
    (is (= "openai" (:provider-id next)))
    (is (= "acct-1" (:account-id next)))
    (is (nil? (:provisional-provider-id next)))
    (is (nil? (:provisional-account-id next)))
    (is (nil? (:provisional-success-count next))))

  (let [state {:prompt-cache-key "abc12345"
               :provider-id      "canonical"
               :account-id       "acct-0"
               :updated-at       0}
        evt   (assoc base-event :provider-id "other" :account-id "acct-x")
        next1 (p/apply-affinity-event state evt {:promotion-threshold 3})
        next2 (p/apply-affinity-event next1 evt {:promotion-threshold 3})]
    (is (= "other" (:provisional-provider-id next1)))
    (is (= 1 (:provisional-success-count next1)))
    (is (= 2 (:provisional-success-count next2)))))

(deftest affinity-promotion-after-threshold
  (let [state {:prompt-cache-key "abc12345"
               :provider-id      "canonical"
               :account-id       "acct-0"
               :provisional-provider-id "new-prov"
               :provisional-account-id  "acct-new"
               :provisional-success-count 2
               :updated-at 0}
        evt   {:type :note-success
               :prompt-cache-key "abc12345"
               :provider-id "new-prov"
               :account-id  "acct-new"}
        next  (p/apply-affinity-event state evt {:promotion-threshold 3})]
    (is (= "new-prov" (:provider-id next)))
    (is (= "acct-new" (:account-id next)))
    (is (nil? (:provisional-provider-id next)))
    (is (nil? (:provisional-success-count next)))))

(deftest affinity-delete
  (is (nil? (p/apply-affinity-event {:prompt-cache-key "x"}
                                    {:type :delete}
                                    {:promotion-threshold 3}))))

;; ══════════════════════════════════════════════════════════════
;; project-pheromone tests (shape, not exact numbers)
;; ══════════════════════════════════════════════════════════════

(deftest pheromone-more-successes-higher
  (let [now (.now js/Date)
        base-events [{:ts now :outcome :success}
                     {:ts now :outcome :failure}]
        more-success [{:ts now :outcome :success}
                      {:ts now :outcome :success}]
        s1 (p/project-pheromone base-events {:decay-half-life-ms 60000})
        s2 (p/project-pheromone more-success {:decay-half-life-ms 60000})]
    (is (< s1 s2))))

;; ══════════════════════════════════════════════════════════════
;; scoring tests
;; ══════════════════════════════════════════════════════════════

(deftest compute-score-linear-vs-invert
  (let [metrics {:latency {:p95 300}
                 :success-rate 0.9}
        weights [{:metric-key "success-rate" :weight 1.0 :transform :linear}
                 {:metric-key "success-rate" :weight 1.0 :transform :invert}]
        s-linear (p/compute-score metrics [(first weights)])
        s-invert (p/compute-score metrics [(second weights)])]
    (is (> s-linear s-invert))))

(deftest score-candidates-uses-metrics-map
  (let [candidates [{:provider-id "openai" :model-id "gpt-4o"}
                    {:provider-id "ollama" :model-id "llama3"}]
        metrics { ["openai" "gpt-4o"] {:success-rate 0.99}
                  ["ollama" "llama3"] {:success-rate 0.80}}
        weights [{:metric-key "success-rate" :weight 1.0 :transform :linear}]
        scored (p/score-candidates candidates metrics weights)
        scores (map :score scored)]
    (is (= 2 (count scored)))
    (is (> (first scores) (second scores)))))
