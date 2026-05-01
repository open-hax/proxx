(ns proxx.policy.contracts
  (:require [clojure.string :as str]))

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

(defn default-strategy-order [idx]
  (:preference/items (require-contract idx :domain/default-strategy-order)))

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

(defn- normalized-keyword [value]
  (cond
    (keyword? value) value
    (string? value) (keyword (str/replace value #"_" "-"))
    :else value))

(defn- account-plan [account]
  (normalized-keyword (or (:plan-type account)
                          (:planType account)
                          :unknown)))

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

(defn- strategy-mode [strategy]
  (normalized-keyword (or (:mode strategy)
                          (:strategy/mode strategy)
                          strategy)))

(defn- first-rank-map [items]
  (reduce-kv (fn [acc idx item]
               (if (contains? acc item)
                 acc
                 (assoc acc item idx)))
             {}
             (vec items)))

(defn strategy-policy
  "Derive combined strategy preferences/exclusions for route/provider/request."
  [compiled route provider-id request-kind]
  (let [clauses (strategy-preference-clauses compiled provider-id request-kind)
        provider-preferred (mapcat :prefer/strategies clauses)
        provider-excluded (mapcat :exclude/strategies clauses)
        model-preferred (:prefer/strategies route)
        model-excluded (:exclude/strategies route)]
    {:preference-order (vec (concat provider-preferred
                                    model-preferred
                                    (:default-strategy-order compiled)))
     :excluded (set (concat provider-excluded model-excluded))
     :clauses clauses}))

(defn order-strategy-candidates
  "Order strategy candidates by declarative provider/model/default preferences.

  If every candidate is excluded, returns original candidates to preserve the
  current fallback behavior of trying the first original strategy."
  [compiled route provider-id request-kind strategies]
  (let [{:keys [preference-order excluded]} (strategy-policy compiled route provider-id request-kind)
        original-order (zipmap strategies (range))
        allowed (filterv #(not (contains? excluded (strategy-mode %))) strategies)
        candidates (if (seq allowed) allowed strategies)
        preference-rank (first-rank-map preference-order)
        fallback-rank (count preference-order)]
    (vec (sort-by (fn [strategy]
                    [(get preference-rank (strategy-mode strategy) fallback-rank)
                     (- (or (:priority strategy) 0))
                     (get original-order strategy 0)])
                  candidates))))

(defn select-strategy-candidate
  "Select the first declaratively ordered strategy candidate."
  [compiled route provider-id request-kind strategies]
  (first (order-strategy-candidates compiled route provider-id request-kind strategies)))

(defn- get-any [m ks]
  (some #(get m %) ks))

(defn- non-empty-values [xs]
  (->> xs
       (filter string?)
       (map str/trim)
       (remove str/blank?)
       vec))

(defn- normalize-model-variants [model]
  (let [trimmed (str/lower-case (str/trim (str model)))]
    (if (str/blank? trimmed)
      []
      (cond-> #{trimmed}
        (str/starts-with? trimmed "ollama/")
        (conj (subs trimmed (count "ollama/")))

        (str/starts-with? trimmed "ollama:")
        (conj (subs trimmed (count "ollama:")))))))

(defn tenant-model-allowed?
  "Apply declarative tenant model allow-list semantics."
  [settings & models]
  (let [allowed-models (non-empty-values (or (get-any settings [:allowed-models :allowedModels]) []))]
    (if (empty? allowed-models)
      true
      (let [allowed (set (mapcat normalize-model-variants allowed-models))
            candidates (set (mapcat normalize-model-variants (filter string? models)))]
        (boolean (and (seq candidates)
                      (some allowed candidates)))))))

(defn- normalize-provider-id [provider-id]
  (str/lower-case (str/trim (str provider-id))))

(defn tenant-provider-allowed?
  "Apply declarative tenant provider allow/disabled-list semantics."
  [settings provider-id]
  (let [normalized (normalize-provider-id provider-id)
        allowed (set (map normalize-provider-id
                          (or (get-any settings [:allowed-provider-ids :allowedProviderIds]) [])))
        disabled (set (map normalize-provider-id
                           (or (get-any settings [:disabled-provider-ids :disabledProviderIds]) [])))]
    (and (not (str/blank? normalized))
         (or (empty? allowed) (contains? allowed normalized))
         (not (contains? disabled normalized)))))

(defn- normalize-mode [mode]
  (when mode
    (keyword (str/replace (name mode) #"_" "-"))))

(defn share-mode-allows-relay? [mode]
  (contains? #{:relay-only :warm-import :project-credentials}
             (normalize-mode mode)))

(defn share-mode-allows-warm-import? [mode]
  (contains? #{:warm-import :project-credentials}
             (normalize-mode mode)))

(defn share-mode-allows-credential-projection? [mode]
  (= :project-credentials (normalize-mode mode)))

(defn- share-mode-satisfies? [mode required]
  (case (normalize-mode required)
    :project-credentials (share-mode-allows-credential-projection? mode)
    :warm-import (share-mode-allows-warm-import? mode)
    :relay (share-mode-allows-relay? mode)
    (share-mode-allows-relay? mode)))

(defn tenant-provider-policy-allows-use?
  "Apply federated tenant provider share policy semantics."
  [policy input]
  (let [requested-model (str/trim (str (or (get-any input [:requested-model :requestedModel]) "")))
        allowed-models (non-empty-values (or (get-any policy [:allowed-models :allowedModels]) []))]
    (and (some? policy)
         (= (get-any policy [:owner-subject :ownerSubject])
            (get-any input [:owner-subject :ownerSubject]))
         (= (get-any policy [:provider-kind :providerKind])
            (get-any input [:provider-kind :providerKind]))
         (or (str/blank? requested-model)
             (empty? allowed-models)
             (contains? (set allowed-models) requested-model))
         (share-mode-satisfies? (get-any policy [:share-mode :shareMode])
                                (get-any input [:required-share-mode :requiredShareMode])))))

(defn- lookup-provider-value [m provider-id fallback]
  (cond
    (contains? m provider-id) (get m provider-id)
    (contains? m (keyword provider-id)) (get m (keyword provider-id))
    :else fallback))

(defn- accounts-for-provider [input provider-id]
  (let [by-provider (or (get-any input [:accounts-by-provider :accountsByProvider]) {})]
    (if (seq by-provider)
      (lookup-provider-value by-provider provider-id [])
      (or (:accounts input) []))))

(defn- strategies-for-provider [input provider-id]
  (let [by-provider (or (get-any input [:strategies-by-provider :strategiesByProvider]) {})]
    (if (seq by-provider)
      (lookup-provider-value by-provider provider-id [])
      (or (:strategies input) []))))

(defn- evidence-model-variants [model-id]
  (let [model (str model-id)]
    (vec (distinct [model (str/replace model #":" "-")]))))

(defn- evidence-has-model? [evidence provider-id model-id]
  (boolean
   (some (fn [candidate]
           (or (get-in evidence [provider-id candidate])
               (get-in evidence [(keyword provider-id) candidate])))
         (evidence-model-variants model-id))))

(defn- provider-model-evidenced? [input provider-id model-id]
  (let [models-dev (or (get-any input [:models-dev/provider-models :modelsDevProviderModels]) {})
        snapshots (or (get-any input [:provider-model-snapshots :providerModelSnapshots]) {})]
    (or (evidence-has-model? models-dev provider-id model-id)
        (evidence-has-model? snapshots provider-id model-id))))

(defn- evidence-filtered-provider-ids [route input provider-ids model-id]
  (if (= :route/default (:contract/id route))
    (filterv #(provider-model-evidenced? input % model-id) provider-ids)
    provider-ids))

(defn preview-policy-decision
  "Produce a pure policy decision preview from compiled declarative contracts.

  This function is intentionally side-effect-free. It exists for parity tests and
  live-runtime cutover preparation; it does not execute a provider strategy."
  [compiled input]
  (let [model-id (or (get-any input [:model-id :modelId :requested-model :requestedModel]) "")
        request-kind (or (get-any input [:request-kind :requestKind]) :chat)
        tenant-settings (or (get-any input [:tenant-settings :tenantSettings]) {})]
    (if-not (tenant-model-allowed? tenant-settings model-id)
      {:status :denied
       :reason :tenant-model-not-allowed
       :model-id model-id}
      (if-let [route (select-routing-clause compiled model-id)]
        (let [provider-ids (or (get-any input [:provider-ids :providerIds]) [])
              evidenced-providers (evidence-filtered-provider-ids route input provider-ids model-id)
              tenant-allowed-providers (filterv #(tenant-provider-allowed? tenant-settings %) evidenced-providers)
              ordered-providers (vec (order-provider-candidates route tenant-allowed-providers))
              provider-id (first ordered-providers)]
          (if-not provider-id
            {:status :exhausted
             :reason :no-provider-candidates
             :model-id model-id
             :route-id (:contract/id route)
             :providers []}
            (let [account-result (order-account-candidates compiled route (accounts-for-provider input provider-id))
                  ordered-accounts (:ordered account-result)
                  ordered-strategies (order-strategy-candidates compiled
                                                                route
                                                                provider-id
                                                                request-kind
                                                                (strategies-for-provider input provider-id))]
              {:status :ok
               :model-id model-id
               :request-kind request-kind
               :route-id (:contract/id route)
               :providers ordered-providers
               :provider-id provider-id
               :accounts ordered-accounts
               :account (first ordered-accounts)
               :applies-account-constraint (:applies-constraint account-result)
               :strategies ordered-strategies
               :strategy (first ordered-strategies)})))
        {:status :exhausted
         :reason :no-routing-clause
         :model-id model-id}))))

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
     :default-strategy-order (default-strategy-order idx)
     :tenant-authorization-clauses (tenant-authorization-clauses idx)
     :fallback-policy (fallback-policy idx)
     :root-program (root-program idx)}))
