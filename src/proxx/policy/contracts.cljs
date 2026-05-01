(ns proxx.policy.contracts)

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

(defn tenant-authorization-clauses [idx]
  (->> (:contracts idx)
       (filter #(= :authorization-clause (:contract/kind %)))
       vec))

(defn fallback-policy [idx]
  (some #(when (= :fallback-policy (:contract/kind %)) %) (:contracts idx)))

(defn root-program [idx]
  (some #(when (= :policy-program (:contract/kind %)) %) (:contracts idx)))

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
     :tenant-authorization-clauses (tenant-authorization-clauses idx)
     :fallback-policy (fallback-policy idx)
     :root-program (root-program idx)}))
