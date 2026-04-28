(ns proxx.cache-policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.cache-policy :as cp]))

(deftest policies-are-defined-for-entities
  (doseq [k [:provider :provider-model :prompt-affinity
             :pheromone-state :routing-policy :affinity-policy]]
    (is (contains? cp/policies k))))

(deftest provider-read-write-order
  (let [p (get cp/policies :provider)]
    (is (= [:redis :lmdb :postgres] (:write-through p)))
    (is (= [:redis :lmdb :postgres] (:read-order p)))))

(deftest pheromone-is-cache-only
  (let [p (get cp/policies :pheromone-state)]
    (is (= [:redis :lmdb] (:write-through p)))
    (is (= [:redis :lmdb] (:read-order p)))))
