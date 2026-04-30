(ns proxx.policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy :as policy]
            [proxx.policy.loader :as loader]
            [proxx.policy.router :as router]))

(defn strategy [id outcome strategy-symbol]
  {:contract/id id
   :contract/kind :strategy
   :policy/outcome outcome
   :policy/strategy strategy-symbol})

(defn policy-node [id outcome children]
  {:contract/id id
   :contract/kind :policy
   :policy/outcome outcome
   :policy/children children})

(deftest all-stops-on-first-nil
  (is (nil? (policy/eval-forms :all ['(= 1 2) '(= 1 1)] {} (atom [])))))

(deftest some-returns-first-non-nil
  (is (= true (policy/eval-forms :some ['(= 1 2) '(= 1 1) '(= 2 2)] {} (atom [])))))

(deftest failing-condition-skips-filters-and-children
  (policy/clear-strategies!)
  (let [calls (atom 0)
        trace (atom [])
        p {:contract/id :policy/skip
           :contract/kind :policy
           :policy/condition {:eval/op :all :eval/forms ['(= (get ctx :allowed?) true)]}
           :policy/filters [{:eval/op :all :eval/forms ['(= (get ctx :boom) true)]}]
           :policy/outcome :reduce
           :policy/children [(strategy :strategy/child :apply 'test/child)]}]
    (policy/register-strategy! 'test/child (fn [_] (swap! calls inc) :ok))
    (is (nil? (policy/eval-node p {:allowed? false} trace)))
    (is (zero? @calls))
    (is (= [] @trace))))

(deftest filters-narrow-credentials
  (let [ctx {:credentials [{:provider-id "openai" :enabled true}
                           {:provider-id "anthropic" :enabled true}
                           {:provider-id "openai" :enabled false}]}
        narrowed (policy/apply-filters [{:eval/op :all
                                         :eval/target :credentials
                                         :eval/forms ['(= (get it :provider-id) "openai")
                                                      '(get it :enabled)]}]
                                       ctx
                                       (atom []))]
    (is (= [{:provider-id "openai" :enabled true}] (:credentials narrowed)))))

(deftest strategy-exception-becomes-nil
  (policy/clear-strategies!)
  (let [trace (atom [])]
    (policy/register-strategy! 'test/boom (fn [_] (throw (js/Error. "boom"))))
    (is (nil? (policy/run-strategy (strategy :strategy/boom :apply 'test/boom) {} trace)))
    (is (= :fail (:trace/outcome (first @trace))))))

(deftest first-provider-fails-second-succeeds-via-backtracking
  (policy/clear-strategies!)
  (let [trace (atom [])]
    (policy/register-strategy! 'test/fail (constantly nil))
    (policy/register-strategy! 'test/pass (constantly {:ok true}))
    (is (= {:ok true}
           (router/route-request! [(policy-node :router/root :reduce
                                                [(strategy :strategy/first :try 'test/fail)
                                                 (strategy :strategy/second :try 'test/pass)])]
                                  {}
                                  trace)))
    (is (= [:strategy/first :strategy/second] (mapv :trace/node-id @trace)))))

(deftest exhausted-tree-throws
  (policy/clear-strategies!)
  (policy/register-strategy! 'test/fail (constantly nil))
  (try
    (router/route-request! [(strategy :strategy/fail :try 'test/fail)] {} (atom []))
    (is false "expected exhausted tree")
    (catch :default e
      (is (= true (:proxx/exhausted (ex-data e)))))))

(deftest trace-contains-one-entry-per-attempted-strategy
  (policy/clear-strategies!)
  (let [trace (atom [])]
    (policy/register-strategy! 'test/no (constantly nil))
    (policy/register-strategy! 'test/yes (constantly :yes))
    (router/route-request! [(policy-node :router/root :reduce
                                         [(strategy :strategy/no :try 'test/no)
                                          (strategy :strategy/yes :try 'test/yes)])]
                           {}
                           trace)
    (is (= 2 (count @trace)))
    (is (= [:fail :pass] (mapv :trace/outcome @trace)))))

(deftest trace-is-not-read-for-branching
  (policy/clear-strategies!)
  (let [trace (atom [{:trace/node-id :preexisting
                      :trace/op :assert
                      :trace/outcome :fail
                      :trace/elapsed-ms 0}])]
    (policy/register-strategy! 'test/yes (constantly :yes))
    (is (= :yes (router/route-request! [(strategy :strategy/yes :try 'test/yes)] {} trace)))))

(deftest next-skips-strategy-execution
  (policy/clear-strategies!)
  (let [calls (atom 0)]
    (policy/register-strategy! 'test/nope (fn [_] (swap! calls inc) :bad))
    (is (nil? (policy/eval-node {:contract/id :policy/next
                                 :contract/kind :strategy
                                 :policy/outcome :next
                                 :policy/strategy 'test/nope}
                                {}
                                (atom []))))
    (is (zero? @calls))))

(deftest reduce-delegates-into-child-choice-space
  (policy/clear-strategies!)
  (policy/register-strategy! 'test/yes (constantly :child-ok))
  (is (= :child-ok (policy/eval-node (policy-node :router/root :reduce
                                                  [(strategy :strategy/yes :apply 'test/yes)])
                                     {}
                                     (atom [])))))

(deftest loader-validates-model-router-resource
  (let [policies (loader/load-policies! "resources/policies/model-router.edn")]
    (is (= :router/root (-> policies first :contract/id)))))

(deftest malformed-policy-edn-fails-loader-validation
  (let [fs (js/require "fs")
        os (js/require "os")
        path (js/require "path")
        file (.join path (.tmpdir os) "bad-proxx-policy.edn")]
    (.writeFileSync fs file "[{:contract/id :bad :contract/kind :policy}]" "utf8")
    (is (thrown-with-msg? js/Error #"Invalid policy EDN" (loader/load-policies! file)))))

(deftest some-law-first-success
  (doseq [n (range 1 8)]
    (let [forms (vec (concat (repeat n '(= 1 2)) ['(= 1 1)]))]
      (is (= true (policy/eval-forms :some forms {} (atom [])))))))

(deftest all-law-any-failure-fails
  (doseq [n (range 1 8)]
    (let [forms (vec (concat (repeat n '(= 1 1)) ['(= 1 2)]))]
      (is (nil? (policy/eval-forms :all forms {} (atom [])))))))

(deftest filter-narrowing-monotonicity
  (doseq [n (range 1 8)]
    (let [credentials (mapv (fn [i] {:provider-id (if (even? i) "openai" "anthropic")}) (range n))
          narrowed (policy/apply-filters [{:eval/op :all
                                           :eval/target :credentials
                                           :eval/forms ['(= (get it :provider-id) "openai")]}]
                                         {:credentials credentials}
                                         (atom []))]
      (is (<= (count (:credentials narrowed)) (count credentials))))))
