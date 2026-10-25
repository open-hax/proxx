(ns proxx.routing.ordered-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.routing.ordered :as om]))

(deftest insertion-order-is-kept-beyond-eight-keys
  (let [ks (mapv #(str "k" %) (range 30))
        m (om/from-entries (map vector ks (range)))]
    (is (= ks (om/om-keys m)))
    (is (= (map vector ks (range)) (om/om-entries m)))))

(deftest overwrite-keeps-position
  (let [m (-> om/empty-om (om/om-assoc "a" 1) (om/om-assoc "b" 2) (om/om-assoc "a" 3))]
    (is (= [["a" 3] ["b" 2]] (om/om-entries m)))
    (is (= 3 (om/om-get m "a")))
    (is (om/om-contains? m "b"))
    (is (not (om/om-contains? m "c")))))

(deftest merge-appends-new-keys
  (is (= [["a" 9] ["b" 2] ["c" 3]]
         (om/om-entries (om/om-merge (om/from-entries [["a" 1] ["b" 2]]) (om/from-entries [["c" 3] ["a" 9]]))))))

(deftest js-key-order-puts-array-indices-first
  (let [m (om/from-entries [["b" 1] ["10" 2] ["a" 3] ["2" 4] ["01" 5] ["-1" 6] ["4294967295" 7] ["0" 8]])]
    (is (= ["0" "2" "10" "b" "a" "01" "-1" "4294967295"] (om/om-js-keys m))
        "what Object.keys reports: 0, 2, 10 ascending, then insertion order (01, -1 and 2^32-1 are not indices)")
    (is (= ["b" "10" "a" "2" "01" "-1" "4294967295" "0"] (om/om-keys m)) "insertion order is kept separately")))
