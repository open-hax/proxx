(ns proxx.policy.contracts)

(defn pattern-matches?
  "Return true when regex pattern text matches value."
  [pattern value]
  (let [s (str value)]
    (cond
      (string? pattern) (boolean (re-find (re-pattern pattern) s))
      (instance? js/RegExp pattern) (.test pattern s)
      :else (= pattern value))))

(defn index-contracts
  "Build a deterministic contract index and fail on duplicate ids."
  [contracts]
  (reduce (fn [idx contract]
            (let [id (:contract/id contract)]
              (when (contains? (:by-id idx) id)
                (throw (ex-info "Duplicate policy contract id"
                                {:contract/id id})))
              (-> idx
                  (update :contracts conj contract)
                  (assoc-in [:by-id id] contract))))
          {:contracts []
           :by-id {}}
          contracts))

(defn require-contract [idx id]
  (or (get-in idx [:by-id id])
      (throw (ex-info "Missing policy contract reference"
                      {:contract/id id}))))

(defn- maybe-resolve-items [idx value]
  (cond
    (keyword? value) (:set/items (require-contract idx value))
    (vector? value) value
    (nil? value) nil
    :else (throw (ex-info "Unsupported policy item reference"
                          {:value value}))))

(defn- maybe-resolve-provider-order [idx value]
  (cond
    (keyword? value) (:preference/items (require-contract idx value))
    (vector? value) value
    (nil? value) nil
    :else (throw (ex-info "Unsupported provider order reference"
                          {:value value}))))

(defn routing-clauses
  "Return ordered routing clauses enriched with referenced family/provider/plan facts."
  [idx]
  (->> (:contracts idx)
       (filter #(= :routing-clause (:contract/kind %)))
       (mapv (fn [clause]
               (let [family-id (:match/family clause)]
                 (cond-> clause
                   family-id
                   (assoc :match/family-contract (require-contract idx family-id))

                   (:prefer/providers clause)
                   (assoc :prefer/provider-order
                          (maybe-resolve-provider-order idx (:prefer/providers clause)))

                   (:require/plans clause)
                   (assoc :require/plan-set
                          (maybe-resolve-items idx (:require/plans clause)))))))))

(defn provider-capabilities [idx]
  (->> (:contracts idx)
       (filter #(= :provider-capability (:contract/kind %)))
       vec))

(defn request-surface-defaults [idx]
  (->> (:contracts idx)
       (filter #(= :request-surface-default (:contract/kind %)))
       vec))

(defn account-orderings [idx]
  (->> (:contracts idx)
       (filter #(= :account-ordering (:contract/kind %)))
       (mapv (fn [ordering]
               (if-let [score-ref (some :score/by-plan (:selection/order ordering))]
                 (assoc ordering :score/table (:score/by-plan (require-contract idx score-ref)))
                 ordering)))))

(defn account-constraints [idx]
  (->> (:contracts idx)
       (filter #(= :account-constraint (:contract/kind %)))
       (mapv (fn [constraint]
               (cond-> constraint
                 (:require/plans constraint)
                 (assoc :require/plan-set
                        (maybe-resolve-items idx (:require/plans constraint))))))))

(defn tenant-authorization-clauses [idx]
  (->> (:contracts idx)
       (filter #(= :authorization-clause (:contract/kind %)))
       vec))

(defn fallback-policy [idx]
  (some #(when (= :fallback-policy (:contract/kind %)) %) (:contracts idx)))

(defn root-program [idx]
  (some #(when (= :policy-program (:contract/kind %)) %) (:contracts idx)))

(defn routing-clause-matches-model?
  "Return true when a compiled routing clause's family pattern matches model-id."
  [clause model-id]
  (let [pattern (get-in clause [:match/family-contract :match/model-pattern])]
    (pattern-matches? pattern model-id)))

(defn select-routing-clause
  "Select the first routing clause whose family pattern matches model-id."
  [compiled model-id]
  (some #(when (routing-clause-matches-model? % model-id) %)
        (:routing-clauses compiled)))

(defn provider-clause-matches?
  "Return true when a provider/request capability clause applies."
  [clause provider-id request-kind]
  (and (pattern-matches? (:match/provider-pattern clause) provider-id)
       (or (nil? (:match/request-kind clause))
           (= request-kind (:match/request-kind clause)))))

(defn strategy-preference-clauses
  "Return provider capability and request-surface clauses that apply in order."
  [compiled provider-id request-kind]
  (->> (concat (:provider-capabilities compiled)
               (:request-surface-defaults compiled))
       (filterv #(provider-clause-matches? % provider-id request-kind))))

(defn order-provider-candidates
  "Filter excluded provider ids and order preferred providers before original order."
  [route provider-ids]
  (let [original-order (zipmap provider-ids (range))
        excluded (set (:exclude/providers route))
        filtered (filterv #(not (contains? excluded %)) provider-ids)
        preferred (:prefer/provider-order route)
        preferred-order (zipmap preferred (range))
        fallback-rank (count preferred)]
    (sort-by (fn [provider-id]
               [(get preferred-order provider-id fallback-rank)
                (get original-order provider-id 0)])
             filtered)))

(defn select-account-ordering
  "Return the account ordering contract declared by a route."
  [compiled route]
  (let [ordering-id (:account/order route)]
    (or (some #(when (= ordering-id (:contract/id %)) %)
              (:account-orderings compiled))
        (some #(when (= :account-order/prefer-free (:contract/id %)) %)
              (:account-orderings compiled)))))

(defn- account-plan [account]
  (or (:plan-type account)
      (:planType account)
      :unknown))

(defn- quota-exhausted? [account]
  (true? (or (:quota-exhausted? account)
             (:is-quota-exhausted? account)
             (:isQuotaExhausted account))))

(defn- constrain-accounts-by-plan [route accounts]
  (let [required (set (:require/plan-set route))
        excluded (set (:exclude/plans route))
        required-matches (if (seq required)
                           (filterv #(contains? required (account-plan %)) accounts)
                           accounts)
        after-required (if (and (seq required) (seq required-matches))
                         required-matches
                         accounts)
        excluded-filtered (if (seq excluded)
                            (filterv #(not (contains? excluded (account-plan %))) after-required)
                            after-required)
        after-excluded (if (and (seq excluded) (seq excluded-filtered))
                         excluded-filtered
                         after-required)]
    {:accounts after-excluded
     :applies-constraint (not= (count after-excluded) (count accounts))}))

(defn- filter-quota-exhausted [accounts]
  (let [available (filterv #(not (quota-exhausted? %)) accounts)]
    (if (seq available) available accounts)))

(defn- order-accounts [ordering accounts]
  (let [original-order (zipmap accounts (range))
        selection-order (:selection/order ordering)
        preferred-plan (:prefer/plan (first (filter map? selection-order)))
        score-table (:score/table ordering)]
    (cond
      preferred-plan
      (sort-by (fn [account]
                 [(if (= preferred-plan (account-plan account)) 0 1)
                  (get original-order account 0)])
               accounts)

      score-table
      (sort-by (fn [account]
                 [(- (get score-table (account-plan account) 0))
                  (get original-order account 0)])
               accounts)

      :else accounts)))

(defn order-account-candidates
  "Apply route plan constraints, quota fallback, and declared account ordering."
  [compiled route accounts]
  (let [ordering (select-account-ordering compiled route)
        constrained (constrain-accounts-by-plan route accounts)
        quota-filtered (filter-quota-exhausted (:accounts constrained))]
    {:ordered (vec (order-accounts ordering quota-filtered))
     :applies-constraint (:applies-constraint constrained)}))

(defn compile-contracts
  "Compile loaded declarative policy contracts into phase-oriented indexes.

  This does not execute policy yet; it makes references explicit so parity tests
  can compare the declarative program with current runtime behavior."
  [contracts]
  (let [idx (index-contracts contracts)]
    {:index idx
     :routing-clauses (routing-clauses idx)
     :provider-capabilities (provider-capabilities idx)
     :request-surface-defaults (request-surface-defaults idx)
     :account-orderings (account-orderings idx)
     :account-constraints (account-constraints idx)
     :tenant-authorization-clauses (tenant-authorization-clauses idx)
     :fallback-policy (fallback-policy idx)
     :root-program (root-program idx)}))
