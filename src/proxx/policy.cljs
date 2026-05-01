(ns proxx.policy
  (:require [proxx.policy.eval :as pe]))

(defonce ^:private strategy-registry (atom {}))
(defonce ^:private contract-kind-registry (atom {}))
(defonce ^:private contract-registry (atom {}))

(defn register-strategy! [strategy-symbol f]
  (swap! strategy-registry assoc strategy-symbol f)
  strategy-symbol)

(defn clear-strategies! []
  (reset! strategy-registry {}))

(defn register-contract-kind!
  "Register an allowed contract kind evaluator.

  The evaluator is called with the contract literal and the value passed to
  (contract/apply [kind id] value). It should return truthy when the contract
  applies to the value, nil/false otherwise. This is the Clojure extension layer
  for consumers; contracts can call registered kinds, but eval forms cannot define
  arbitrary functions or loops."
  [kind f]
  (swap! contract-kind-registry assoc kind f)
  kind)

(defn clear-contract-kinds! []
  (reset! contract-kind-registry {}))

(defn- contract-id-for-tuple [[kind id]]
  (cond
    (qualified-keyword? id) id
    (and (keyword? kind) (keyword? id)) (keyword (name kind) (name id))
    :else id))

(defn register-contract!
  "Register a contract literal so eval forms may reference it with
  (contract/apply [kind id] value). The lookup tuple is [contract kind, local id]."
  [contract]
  (let [kind (:contract/kind contract)
        id (:contract/id contract)
        local-id (when (qualified-keyword? id) (keyword (name id)))]
    (swap! contract-registry assoc [kind id] contract)
    (when local-id
      (swap! contract-registry assoc [kind local-id] contract))
    contract))

(defn register-contracts! [contracts]
  (doseq [contract contracts]
    (register-contract! contract))
  contracts)

(defn clear-contracts! []
  (reset! contract-registry {}))

(defn apply-registered-contract [tuple value]
  (let [[kind _id] tuple
        contract-id (contract-id-for-tuple tuple)
        contract (or (get @contract-registry tuple)
                     (get @contract-registry [kind contract-id]))
        evaluator (get @contract-kind-registry kind)]
    (when (and contract evaluator)
      (evaluator contract value))))

(defn- pattern-matches? [pattern value]
  (let [s (str value)]
    (cond
      (string? pattern) (boolean (re-find (re-pattern pattern) s))
      (instance? js/RegExp pattern) (.test pattern s)
      :else (= pattern value))))

(defn- first-present [& values]
  (some (fn [value]
          (when (some? value) value))
        values))

(defn- value-model-id [value]
  (cond
    (string? value) value
    (map? value) (first-present (:model-id value)
                                (:modelId value)
                                (:model value)
                                (get-in value [:request :payload :model])
                                (get-in value [:payload :model]))
    :else value))

(defn- value-provider-id [value]
  (when (map? value)
    (first-present (:provider-id value)
                   (:providerId value)
                   (:provider value)
                   (get-in value [:it :provider-id])
                   (get-in value [:it :providerId])
                   (get-in value [:it :provider])
                   (get-in value [:request :payload :provider])
                   (get-in value [:payload :provider]))))

(defn- value-request-kind [value]
  (when (map? value)
    (first-present (:request-kind value)
                   (:requestKind value)
                   (:endpoint-type value)
                   (:endpointType value))))

(defn- value-tenant-settings [value]
  (when (map? value)
    (first-present (:tenant-settings value)
                   (:tenantSettings value)
                   (:settings value))))

(defn- setting-values [settings kebab-key camel-key]
  (let [values (first-present (get settings kebab-key) (get settings camel-key))]
    (cond
      (nil? values) []
      (sequential? values) values
      :else [values])))

(defn- normalize-model-variant [model-id variant]
  (let [model (str model-id)]
    (case variant
      :identity model
      :strip-ollama-slash-prefix (if (.startsWith model "ollama/") (subs model 7) model)
      :strip-ollama-colon-prefix (if (.startsWith model "ollama:") (subs model 7) model)
      model)))

(defn- model-allowed-by-settings? [contract value]
  (let [settings (value-tenant-settings value)
        allowed (set (map str (setting-values settings :allowed-models :allowedModels)))
        variants (:normalize/model-variants contract)
        model-id (value-model-id value)
        candidates (set (map #(normalize-model-variant model-id %) (or (seq variants) [:identity])))]
    (or (empty? allowed)
        (boolean (some allowed candidates)))))

(defn- provider-allowed-by-settings? [value]
  (let [settings (value-tenant-settings value)
        provider-id (str (value-provider-id value))
        allowed (set (map str (setting-values settings :allowed-provider-ids :allowedProviderIds)))]
    (or (empty? allowed)
        (contains? allowed provider-id))))

(defn- provider-not-disabled-by-settings? [value]
  (let [settings (value-tenant-settings value)
        provider-id (str (value-provider-id value))
        disabled (set (map str (setting-values settings :disabled-provider-ids :disabledProviderIds)))]
    (not (contains? disabled provider-id))))

(defn- value-plan [value]
  (when (map? value)
    (first-present (:plan-type value)
                   (:planType value)
                   (get-in value [:it :plan-type])
                   (get-in value [:it :planType]))))

(defn- account-constraint-applies? [contract value]
  (let [model-id (str (value-model-id value))
        models (set (map str (:match/models contract)))]
    (or (empty? models)
        (contains? models model-id))))

(defn- account-satisfies-constraint? [contract value]
  (if-not (account-constraint-applies? contract value)
    true
    (let [raw-plan (or (value-plan value) :unknown)
          plan (if (keyword? raw-plan) raw-plan (keyword (str raw-plan)))
          required (set (:require/plan-set contract))
          excluded (set (:exclude/plans contract))]
      (and (or (empty? required) (contains? required plan))
           (not (contains? excluded plan))))))

(defn register-default-contract-kinds!
  "Register built-in policy contract kind evaluators.

  This is the default host-language extension layer for the EDN decision-tree
  language. Eval forms may call these contracts by tuple with contract/apply,
  while the implementations stay in Clojure instead of inside EDN."
  []
  (register-contract-kind!
   :model
   (fn [contract value]
     (= (or (:model/id contract)
            (some-> (:contract/id contract) name))
        (value-model-id value))))
  (register-contract-kind!
   :model-family
   (fn [contract value]
     (pattern-matches? (:match/model-pattern contract) (value-model-id value))))
  (register-contract-kind!
   :provider-capability
   (fn [contract value]
     (and (pattern-matches? (:match/provider-pattern contract) (value-provider-id value))
          (or (nil? (:match/request-kind contract))
              (= (:match/request-kind contract) (value-request-kind value))))))
  (register-contract-kind!
   :routing-clause
   (fn [contract value]
     (if-let [family-id (:match/family contract)]
       (apply-registered-contract [:model-family (keyword (name family-id))] (value-model-id value))
       true)))
  (register-contract-kind!
   :authorization-clause
   (fn [contract value]
     (case (:authz/domain contract)
       :model (model-allowed-by-settings? contract value)
       :provider (case (:contract/id contract)
                   :tenant/provider-allow-list (provider-allowed-by-settings? value)
                   :tenant/provider-disabled-list (provider-not-disabled-by-settings? value)
                   true)
       true)))
  (register-contract-kind!
   :account-constraint
   account-satisfies-constraint?)
  [:model :model-family :provider-capability :routing-clause :authorization-clause :account-constraint])

(defn- now-ms [] (.now js/Date))

(defn- trace! [trace entry]
  (swap! trace conj entry)
  nil)

(defn- contract-apply-fns []
  (reduce-kv (fn [acc tuple _contract]
               (assoc acc tuple #(apply-registered-contract tuple %)))
             {}
             @contract-registry))

(defn eval-form
  ([form ctx trace] (eval-form form ctx trace (contract-apply-fns)))
  ([form ctx trace injected-fns]
   (pe/eval-form form ctx trace injected-fns)))

(defn apply-target [ctx target item]
  (assoc ctx :it item target [item]))

(defn- eval-targeted-form [form ctx target]
  (if-let [items (and target (get ctx target))]
    (some (fn [item]
            (eval-form form (assoc ctx :it item) nil))
          items)
    (eval-form form ctx nil)))

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

(defn- sortable-value [value]
  (cond
    (nil? value) js/Infinity
    (keyword? value) (name value)
    :else value))

(defn- sort-key-for-item [sort-node ctx idx item]
  (let [item-ctx (assoc ctx :it item)
        key-parts (mapv #(sortable-value (eval-form % item-ctx nil))
                        (:eval/forms sort-node))]
    (conj key-parts idx)))

(defn- ordered-target-items [sort-node ctx]
  (let [target (:eval/target sort-node)
        direction (or (:sort/direction sort-node) :asc)
        items (vec (get ctx target []))
        keyed (map-indexed (fn [idx item]
                             {:item item
                              :key (sort-key-for-item sort-node ctx idx item)})
                           items)
        ordered (sort-by :key keyed)]
    (mapv :item (if (= :desc direction) (reverse ordered) ordered))))

(defn- eval-sorted-children [policy ctx trace]
  (let [sort-node (:policy/sort policy)
        target (:eval/target sort-node)]
    (if-not target
      (eval-children-some (:policy/children policy) ctx trace)
      (some (fn [item]
              (eval-children-some (:policy/children policy)
                                  (assoc ctx :it item target [item])
                                  trace))
            (ordered-target-items sort-node ctx)))))

(defn- compact-projection? [projection]
  (not= false (:project/compact? projection)))

(defn- projection-inputs [projection ctx]
  (if-let [from (:project/from projection)]
    (get ctx from [])
    [ctx]))

(defn- project-values [projection ctx]
  (let [values (mapv (fn [item]
                       (eval-form (:project/form projection)
                                  (assoc ctx :it item)
                                  nil))
                     (projection-inputs projection ctx))
        compacted (if (compact-projection? projection)
                    (filterv some? values)
                    values)]
    (if (:project/distinct? projection)
      (vec (distinct compacted))
      compacted)))

(defn- apply-projections [projections ctx]
  (reduce (fn [next-ctx projection]
            (assoc next-ctx (:project/to projection) (project-values projection next-ctx)))
          ctx
          projections))

(defn- eval-project-children [policy ctx trace]
  (eval-children-some (:policy/children policy)
                      (apply-projections (:policy/project policy) ctx)
                      trace))

(defn eval-node [policy ctx trace]
  (when (condition-passes? policy ctx trace)
    (when-let [filtered-ctx (apply-filters (:policy/filters policy) ctx trace)]
      (case (:policy/outcome policy)
        :next nil
        :reduce (eval-children-some (:policy/children policy) filtered-ctx trace)
        :sorted (eval-sorted-children policy filtered-ctx trace)
        :project (eval-project-children policy filtered-ctx trace)
        (:apply :try) (when (= :strategy (:contract/kind policy))
                        (run-strategy policy filtered-ctx trace))
        nil))))
