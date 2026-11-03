(ns proxx.strategy.credential-selector-w7rt-test
  "src/tests/credential-selector.test.ts: affinity reordering. The TypeScript entry points apply the
  index order decided by `candidateOrderForAffinities` (proxx.runtime.strategy) to their candidates,
  so the contract is stated in index space over the same candidate fixtures."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.strategy :as edge]))

(defn- pairs [& account-ids] (to-array (map (fn [id] #js ["openai" id]) account-ids)))

(defn- order [candidates preferred] (vec (array-seq (edge/candidate-order-for-affinities-js candidates preferred))))

(deftest reorder-for-affinities-moves-preferred-candidates-to-front
  (let [result (order (pairs "a1" "a2" "a3") (pairs "a3"))]
    (is (= 2 (first result)) "a3 comes first")
    (is (= 3 (count result)))
    (is (= [2 0 1] result))))

(deftest reorder-for-affinities-returns-everything-in-place-when-no-preferences
  (let [candidates (pairs "a1")
        first-result (edge/candidate-order-for-affinities-js candidates #js [])
        second-result (edge/candidate-order-for-affinities-js candidates #js [])]
    (is (= [0] (vec (array-seq first-result))))
    (is (not (identical? first-result second-result)) "a fresh array every time, never shared state")))

(deftest reorder-for-affinity-is-the-single-preference-case
  (let [candidates (pairs "a1" "a2")]
    (is (= 1 (first (order candidates (pairs "a2")))) "a2 comes first")
    (is (= [0 1] (order candidates #js [])) "no preference keeps the order")))
