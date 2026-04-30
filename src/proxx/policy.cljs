(ns proxx.policy
  (:require [proxx.policy.eval :as pe]))

(defonce ^:private strategy-registry (atom {}))

(defn register-strategy! [strategy-symbol f]
  (swap! strategy-registry assoc strategy-symbol f)
  strategy-symbol)

(defn clear-strategies! []
  (reset! strategy-registry {}))

(defn- now-ms [] (.now js/Date))

(defn- trace! [trace entry]
  (swap! trace conj entry)
  nil)

(defn eval-form [form ctx trace]
  (pe/eval-form form ctx trace))

(defn apply-target [ctx target item]
  (assoc ctx :it item target [item]))

(defn- eval-targeted-form [form ctx target]
  (if-let [items (and target (get ctx target))]
    (some (fn [item]
            (pe/eval-form form (assoc ctx :it item) nil))
          items)
    (pe/eval-form form ctx nil)))

(defn eval-forms [op forms ctx trace]
  (case op
    :all (reduce (fn [_ form]
                   (let [result (eval-targeted-form form ctx nil)]
                     (if (nil? result) (reduced nil) result)))
                 true
                 forms)
    :some (some #(eval-targeted-form % ctx nil) forms)
    :none (when-not (some #(eval-targeted-form % ctx nil) forms) true)
    :not (when-not (eval-targeted-form (first forms) ctx nil) true)
    :assert (when (eval-forms :all forms ctx trace) true)
    nil))

(defn- eval-filter [filter-node ctx]
  (let [{:eval/keys [op forms target]} filter-node]
    (if target
      (let [items (get ctx target [])
            narrowed (filterv (fn [item]
                                (let [item-ctx (assoc ctx :it item)]
                                  (some? (eval-forms op forms item-ctx nil))))
                              items)]
        (assoc ctx target narrowed))
      (when (some? (eval-forms op forms ctx nil)) ctx))))

(defn apply-filters [filters ctx _trace]
  (reduce (fn [next-ctx filter-node]
            (if (nil? next-ctx)
              (reduced nil)
              (eval-filter filter-node next-ctx)))
          ctx
          filters))

(defn run-strategy [policy ctx trace]
  (let [started (now-ms)
        node-id (:contract/id policy)
        strategy (:policy/strategy policy)]
    (try
      (if-let [f (get @strategy-registry strategy)]
        (let [result (f ctx)]
          (trace! trace {:trace/node-id node-id
                         :trace/op :assert
                         :trace/outcome (if (nil? result) :fail :pass)
                         :trace/elapsed-ms (max 0 (long (- (now-ms) started)))})
          result)
        (do
          (trace! trace {:trace/node-id node-id
                         :trace/op :assert
                         :trace/outcome :fail
                         :trace/elapsed-ms (max 0 (long (- (now-ms) started)))
                         :trace/reason (str "Unknown strategy " strategy)})
          nil))
      (catch :default e
        (trace! trace {:trace/node-id node-id
                       :trace/op :assert
                       :trace/outcome :fail
                       :trace/elapsed-ms (max 0 (long (- (now-ms) started)))
                       :trace/reason (.-message e)})
        nil))))

(declare eval-node)

(defn- condition-passes? [policy ctx trace]
  (if-let [condition (:policy/condition policy)]
    (let [{:eval/keys [op forms target]} condition]
      (if target
        (some? (some (fn [item]
                       (eval-forms op forms (assoc ctx :it item) trace))
                     (get ctx target [])))
        (some? (eval-forms op forms ctx trace))))
    true))

(defn- eval-children-some [children ctx trace]
  (some #(eval-node % ctx trace) children))

(defn eval-node [policy ctx trace]
  (when (condition-passes? policy ctx trace)
    (when-let [filtered-ctx (apply-filters (:policy/filters policy) ctx trace)]
      (case (:policy/outcome policy)
        :next nil
        :reduce (eval-children-some (:policy/children policy) filtered-ctx trace)
        (:apply :try) (when (= :strategy (:contract/kind policy))
                        (run-strategy policy filtered-ctx trace))
        nil))))
