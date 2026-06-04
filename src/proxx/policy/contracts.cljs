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

(defn model-families [idx]
  (->> (:contracts idx)
       (filter #(= :model-family (:contract/kind %)))
       vec))

(defn reasoning-normalizations [idx]
  (->> (:contracts idx)
       (filter #(= :reasoning-normalization (:contract/kind %)))
       vec))

(defn model-aliases [idx]
  (->> (:contracts idx)
       (filter #(= :model-alias (:contract/kind %)))
       vec))

(defn queue-templates [idx]
  (->> (:contracts idx)
       (filter #(= :request-queue-template (:contract/kind %)))
       vec))

(defn federation-routing-clauses [idx]
  (->> (:contracts idx)
       (filter #(= :federation-routing-clause (:contract/kind %)))
       vec))

(defn queue-instances [idx]
  (->> (:contracts idx)
       (filter #(= :request-queue-instance (:contract/kind %)))
       vec))

(defn- provider-route-provider-id [route]
  (or (:provider/id route)
      (:provider-id route)
      (:providerId route)
      (:provider-id-fallback route)
      (some-> (:contract/id route) name)))

(defn- provider-route-base-url [route]
  (or (:provider/base-url route)
      (:provider/baseUrl route)
      (:base-url route)
      (:baseUrl route)))

(defn- provider-seed-route [contract]
  (let [provider-id (provider-route-provider-id contract)
        base-url (provider-route-base-url contract)]
    (when (and (string? provider-id)
               (not (str/blank? provider-id))
               (string? base-url)
               (not (str/blank? base-url)))
      {:contract/id (:contract/id contract)
       :contract/kind :provider-route
       :provider/id provider-id
       :provider/base-url base-url})))

(defn provider-routes [idx]
  (let [seed-routes (keep #(when (= :provider-seed (:contract/kind %))
                             (provider-seed-route %))
                          (:contracts idx))
        explicit-routes (filter #(= :provider-route (:contract/kind %))
                                (:contracts idx))]
    (vec (concat seed-routes explicit-routes))))

(defn provider-seed-specs [idx]
  (->> (:contracts idx)
       (filter #(= :provider-seed (:contract/kind %)))
       (mapv (fn [contract]
               {:provider-id-env-names (vec (or (:provider-id-env-names contract) []))
                :provider-id-fallback (or (:provider-id-fallback contract) (some-> (:contract/id contract) name))
                :key-env-names (vec (or (:key-env-names contract) []))}))))

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
  "Filter excluded provider ids and order preferred providers before original order.

  When :prefer/providers-strict? is true and a preferred provider order exists,
  only providers explicitly listed in that order remain eligible. This lets
  specific model families fail closed on their canonical upstream instead of
  spilling into the ambient configured provider universe."
  [route provider-ids]
  (let [original-order (zipmap provider-ids (range))
        excluded (set (:exclude/providers route))
        filtered (filterv #(not (contains? excluded %)) provider-ids)
        preferred (:prefer/provider-order route)
        strict? (true? (:prefer/providers-strict? route))
        preferred-set (set preferred)
        candidates (if (and strict? (seq preferred))
                     (filterv #(contains? preferred-set %) filtered)
                     filtered)
        preferred-order (zipmap preferred (range))
        fallback-rank (count preferred)]
    (sort-by (fn [provider-id]
               [(get preferred-order provider-id fallback-rank)
                (get original-order provider-id 0)])
             candidates)))

(defn select-account-ordering
  "Return the account ordering contract declared by a route."
  [compiled route]
  (let [ordering-id (:account/order route)]
    (or (some #(when (= ordering-id (:contract/id %)) %)
              (:account-orderings compiled))
        (some #(when (= :account-order/prefer-free (:contract/id %)) %)
              (:account-orderings compiled)))))

(defn normalized-keyword [value]
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

(defn strategy-mode [strategy]
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

(defn- prompt-cache-key [input]
  (some-> (get-any input [:prompt-cache-key :promptCacheKey]) str str/trim))

(defn- affinity-record [input]
  (get-any input [:prompt-affinity :promptAffinity :affinity-record :affinityRecord]))

(defn- affinity-value [record kebab-key camel-key]
  (when (map? record)
    (get-any record [kebab-key camel-key])))

(defn- model-scoped-affinity-matches? [input model-id]
  (let [record (affinity-record input)
        input-cache-key (prompt-cache-key input)
        affinity-cache-key (some-> (affinity-value record :prompt-cache-key :promptCacheKey) str str/trim)
        affinity-model-id (some-> (affinity-value record :model-id :modelId) str str/trim)]
    (and (not (str/blank? input-cache-key))
         (= input-cache-key affinity-cache-key)
         (not (str/blank? affinity-model-id))
         (= (str model-id) affinity-model-id))))

(defn- affinity-bound-provider-id [input]
  (some-> (affinity-value (affinity-record input) :provider-id :providerId) str str/trim))

(defn- affinity-bound-account [input]
  (let [record (affinity-record input)
        provider-id (affinity-bound-provider-id input)
        account-id (some-> (affinity-value record :account-id :accountId) str str/trim)]
    (when (and (not (str/blank? provider-id))
               (not (str/blank? account-id)))
      {:provider-id provider-id
       :account-id account-id})))

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
        (conj (subs trimmed (count "ollama:")))

        (str/starts-with? trimmed "ollama-lan/")
        (conj (subs trimmed (count "ollama-lan/")))

        (str/starts-with? trimmed "ollama-lan:")
        (conj (subs trimmed (count "ollama-lan:")))))))

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

(defn- dedupe-provider-id-values [provider-ids]
  (vec (distinct (remove str/blank? (map str provider-ids)))))

(defn- requested-provider-ids [input]
  (dedupe-provider-id-values
   (or (get-any input [:requested-provider-ids :requestedProviderIds]) [])))

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

(defn- hosted-openai-family? [model-id]
  (let [lowered (str/lower-case (str model-id))]
    (or (str/starts-with? lowered "gpt-")
        (str/starts-with? lowered "openai/")
        (str/starts-with? lowered "openai:")
        (str/starts-with? lowered "chatgpt-")
        (= lowered "o1")
        (= lowered "o3")
        (= lowered "o4")
        (str/starts-with? lowered "o1-")
        (str/starts-with? lowered "o3-")
        (str/starts-with? lowered "o4-"))))

(defn- glm-model? [model-id]
  (str/starts-with? (str/lower-case (str/trim (str model-id))) "glm-"))

(defn- provider-route-id-from-input [route]
  (some-> (get-any route [:provider-id :providerId :provider/id]) str str/trim))

(defn- provider-route-base-url-from-input [route]
  (some-> (get-any route [:base-url :baseUrl :provider/base-url :provider/baseUrl]) str str/trim))

(defn- normalize-provider-route-input [route]
  (let [provider-id (provider-route-id-from-input route)
        base-url (provider-route-base-url-from-input route)
        auth-required (get-any route [:auth-required :authRequired :auth-required? :auth/required?])]
    (when (and (not (str/blank? provider-id))
               (not (str/blank? base-url)))
      (cond-> {:providerId provider-id
               :baseUrl (str/replace base-url #"/+$" "")}
        (boolean? auth-required)
        (assoc :authRequired auth-required)))))

(defn- input-provider-routes [input]
  (vec (keep normalize-provider-route-input
             (or (get-any input [:provider-routes :providerRoutes]) []))))

(defn- openai-provider-id [config]
  (normalize-provider-id (or (get-any config [:openai-provider-id :openaiProviderId]) "openai")))

(defn- openai-codex-surface? [config]
  (let [base-url (str/lower-case (str (get-any config [:openai-base-url :openaiBaseUrl])))
        responses-path (str/lower-case (str (get-any config [:openai-responses-path :openaiResponsesPath])))
        chat-path (str/lower-case (str (get-any config [:openai-chat-completions-path :openaiChatCompletionsPath])))]
    (or (str/includes? base-url "chatgpt.com/backend-api")
        (str/includes? responses-path "/codex/")
        (str/includes? chat-path "/codex/"))))

(defn- provider-route-supports-model? [config route model-id]
  (let [provider-id (normalize-provider-id (provider-route-id-from-input route))
        openai-id (openai-provider-id config)
        normalized-model (str/lower-case (str/trim (str model-id)))]
    (cond
      (and (= provider-id openai-id)
           (not (hosted-openai-family? normalized-model)))
      false

      (and (= provider-id openai-id)
           (= normalized-model "gpt-5.4-nano")
           (openai-codex-surface? config))
      false

      :else true)))

(defn request-surface-provider-allowed?
  "Return true when declarative request-surface defaults allow provider-id.

  Provider capability clauses tune strategy preference. Request-surface-default
  clauses define the provider universe for non-chat surfaces such as embeddings,
  images, video, music, and TTS. If a surface has no default clause, preserve
  legacy fail-open behavior for chat-like routes while the policy manifest grows.
  "
  [compiled provider-id request-kind]
  (let [surface-clauses (filterv #(= request-kind (:match/request-kind %))
                                  (:request-surface-defaults compiled))]
    (or (empty? surface-clauses)
        (boolean (some #(pattern-matches? (:match/provider-pattern %) provider-id)
                       surface-clauses)))))

(defn- requested-provider-allowed? [input provider-id]
  (let [requested (set (map normalize-provider-id (requested-provider-ids input)))]
    (or (empty? requested)
        (contains? requested (normalize-provider-id provider-id)))))

(defn- provider-entry [catalog-bundle provider-id]
  (let [provider-catalogs (or (get-any catalog-bundle [:provider-catalogs :providerCatalogs]) {})
        normalized (normalize-provider-id provider-id)]
    (or (get provider-catalogs provider-id)
        (get provider-catalogs (keyword provider-id))
        (get provider-catalogs normalized)
        (get provider-catalogs (keyword normalized)))))

(defn- catalog-model-ids [entry]
  (vec (or (get-any entry [:model-ids :modelIds]) [])))

(defn- catalog-entry-supports-model? [model-id entry]
  (let [normalized-model (str/lower-case (str/trim (str model-id)))
        ids (catalog-model-ids entry)
        normalized-ids (set (map #(str/lower-case (str/trim (str %))) ids))]
    (or (contains? normalized-ids normalized-model)
        (and (glm-model? normalized-model)
             (some glm-model? ids)))))

(defn- catalog-dynamic-ollama-model? [catalog-bundle model-id]
  (let [normalized-model (str/lower-case (str/trim (str model-id)))
        dynamic-ids (or (get-any (get-any catalog-bundle [:catalog])
                                 [:dynamic-ollama-model-ids :dynamicOllamaModelIds])
                        [])]
    (boolean (some #(= normalized-model (str/lower-case (str/trim (str %)))) dynamic-ids))))

(defn- provider-id-looks-like-ollama? [provider-id]
  (str/includes? (normalize-provider-id provider-id) "ollama"))

(defn- partition-with [pred items]
  (reduce (fn [[matched rest] item]
            (if (pred item)
              [(conj matched item) rest]
              [matched (conj rest item)]))
          [[] []]
          items))

(defn- filter-provider-routes-by-catalog [routes model-id catalog-bundle]
  (if (glm-model? model-id)
    (vec routes)
    (let [[routes-without-catalog routes-with-catalog]
          (partition-with #(nil? (provider-entry catalog-bundle (provider-route-id-from-input %))) routes)
          catalog-matched (filterv #(catalog-entry-supports-model?
                                     model-id
                                     (provider-entry catalog-bundle (provider-route-id-from-input %)))
                                   routes-with-catalog)]
      (cond
        (seq catalog-matched)
        (vec (concat routes-without-catalog catalog-matched))

        (catalog-dynamic-ollama-model? catalog-bundle model-id)
        (vec (concat routes-without-catalog
                     (filter #(provider-id-looks-like-ollama?
                               (provider-route-id-from-input %))
                             routes-with-catalog)))

        :else
        (vec routes)))))

(defn- catalog-declared-model? [catalog-bundle model-id]
  (let [normalized-model (str/lower-case (str/trim (str model-id)))
        declared (or (get-any (get-any catalog-bundle [:catalog])
                              [:declared-model-ids :declaredModelIds])
                     [])]
    (boolean (some #(= normalized-model (str/lower-case (str/trim (str %)))) declared))))

(defn- catalog-disabled-model? [catalog-bundle model-id]
  (let [normalized-model (str/lower-case (str/trim (str model-id)))
        disabled (or (get-any (get-any catalog-bundle [:preferences])
                              [:disabled])
                     [])]
    (boolean (some #(= normalized-model (str/lower-case (str/trim (str %)))) disabled))))

(defn- catalog-rejects-model? [routes model-id catalog-bundle]
  (if (catalog-declared-model? catalog-bundle model-id)
    false
    (loop [remaining routes
           saw-catalog? false]
      (if-let [route (first remaining)]
        (let [entry (provider-entry catalog-bundle (provider-route-id-from-input route))]
          (cond
            (nil? entry) false
            (catalog-entry-supports-model? model-id entry) false
            :else (recur (rest remaining) true)))
        saw-catalog?))))

(defn filter-provider-routes
  "Apply provider route eligibility in CLJS policy space.

  This owns model-support gates, tenant provider allow/deny gates, and optional
  provider-catalog availability/rejection semantics so route handlers do not
  decide provider eligibility locally."
  [_compiled input]
  (let [model-id (or (get-any input [:model-id :modelId :routed-model :routedModel]) "")
        request-kind (normalized-keyword (or (get-any input [:request-kind :requestKind]) :chat))
        config (or (get-any input [:config]) {})
        tenant-settings (or (get-any input [:tenant-settings :tenantSettings]) {})
        catalog-bundle (get-any input [:catalog-bundle :catalogBundle])
        apply-catalog-availability? (not= false (get-any input [:catalog-availability? :catalogAvailability]))
        routes (->> (input-provider-routes input)
                    (filter #(provider-route-supports-model? config % model-id))
                    (filter #(request-surface-provider-allowed? _compiled
                                                               (provider-route-id-from-input %)
                                                               request-kind))
                    (filter #(requested-provider-allowed? input
                                                           (provider-route-id-from-input %)))
                    (filter #(tenant-provider-allowed? tenant-settings
                                                        (provider-route-id-from-input %)))
                    vec)]
    (if (map? catalog-bundle)
      (if (catalog-disabled-model? catalog-bundle model-id)
        {:providerRoutes routes
         :catalog {:disabled true
                   :rejected false}}
        (if apply-catalog-availability?
          (let [catalog-routes (filter-provider-routes-by-catalog routes model-id catalog-bundle)]
            {:providerRoutes catalog-routes
             :catalog {:disabled false
                       :rejected (catalog-rejects-model? catalog-routes model-id catalog-bundle)}})
          {:providerRoutes routes
           :catalog {:disabled false
                     :rejected false}}))
      {:providerRoutes routes
       :catalog {:disabled false
                 :rejected false}})))

(defn- normalize-mode [mode]
  (when mode
    (keyword (str/replace (name mode) #"_" "-"))))

(def ^:private default-share-mode-requirements
  {:relay #{:relay-only :warm-import :project-credentials}
   :warm-import #{:warm-import :project-credentials}
   :project-credentials #{:project-credentials}})

(defn- share-mode-requirements [compiled request-kind]
  (let [normalized-request-kind (some-> request-kind normalized-keyword)
        declared (->> (:federation-routing-clauses compiled)
                      (filter (fn [clause]
                                (let [match-kind (:match/request-kind clause)]
                                  (or (nil? match-kind)
                                      (nil? normalized-request-kind)
                                      (= match-kind normalized-request-kind)))))
                      (map :admit/share-modes)
                      (filter map?)
                      (apply merge))]
    (if (seq declared)
      (reduce-kv (fn [acc required modes]
                   (assoc acc (normalize-mode required) (set (map normalize-mode modes))))
                 default-share-mode-requirements
                 declared)
      default-share-mode-requirements)))

(defn share-mode-allows-relay? [mode]
  (contains? #{:relay-only :warm-import :project-credentials}
             (normalize-mode mode)))

(defn share-mode-allows-warm-import? [mode]
  (contains? #{:warm-import :project-credentials}
             (normalize-mode mode)))

(defn share-mode-allows-credential-projection? [mode]
  (= :project-credentials (normalize-mode mode)))

(defn- share-mode-satisfies? [compiled mode required request-kind]
  (let [normalized-required (or (normalize-mode required) :relay)
        allowed (or (get (share-mode-requirements compiled request-kind) normalized-required)
                    (get default-share-mode-requirements normalized-required)
                    (:relay default-share-mode-requirements))]
    (contains? allowed (normalize-mode mode))))

(defn tenant-provider-policy-allows-use?
  "Apply federated tenant provider share policy semantics."
  ([policy input]
   (tenant-provider-policy-allows-use? {:federation-routing-clauses []} policy input))
  ([compiled policy input]
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
          (share-mode-satisfies? compiled
                                 (get-any policy [:share-mode :shareMode])
                                 (get-any input [:required-share-mode :requiredShareMode])
                                 (get-any input [:request-kind :requestKind]))))))

(defn- projected-availability-state [account]
  (normalize-mode (get-any account [:availability-state :availabilityState])))

(defn- projected-provider-id [account]
  (some-> (get-any account [:provider-id :providerId]) str str/trim))

(defn- projected-account-id [account]
  (some-> (get-any account [:account-id :accountId]) str str/trim))

(defn- projected-source-peer-id [account]
  (some-> (get-any account [:source-peer-id :sourcePeerId]) str str/trim))

(defn- projected-warm-request-count [account]
  (let [value (get-any account [:warm-request-count :warmRequestCount])]
    (if (number? value) value 0)))

(defn- federation-routing-clause-for [compiled request-kind]
  (or (some #(when (= request-kind (:match/request-kind %)) %)
            (:federation-routing-clauses compiled))
      (some #(when (nil? (:match/request-kind %)) %)
            (:federation-routing-clauses compiled))))

(defn- federation-sort-value [account token]
  (case token
    :availability-state (case (projected-availability-state account)
                          :remote-route 0
                          :descriptor 1
                          :imported 2
                          99)
    :warm-request-count-desc (- (projected-warm-request-count account))
    :provider-id (or (projected-provider-id account) "")
    :account-id (or (projected-account-id account) "")
    :source-peer-id (or (projected-source-peer-id account) "")
    nil))

(defn resolve-federation-route-candidates
  "Order projected federation accounts from declarative policy contracts.

   TypeScript supplies facts from storage; this function owns admission and order."
  [compiled input]
  (let [request-kind (normalized-keyword (or (get-any input [:request-kind :requestKind]) :chat))
        provider-ids (set (map normalize-provider-id (or (get-any input [:provider-ids :providerIds]) [])))
        local-keys (set (or (get-any input [:local-provider-account-keys :localProviderAccountKeys]) []))
        now-ms (or (get-any input [:now-ms :nowMs]) 0)
        projected-accounts (vec (or (get-any input [:projected-accounts :projectedAccounts]) []))
        clause (federation-routing-clause-for compiled request-kind)
        admitted-states (set (or (:admit/availability-states clause) [:remote-route :descriptor]))
        order (or (:selection/order clause)
                  [:availability-state :warm-request-count-desc :provider-id :account-id :source-peer-id])]
    (if-not clause
      {:status :exhausted
       :reason :no-federation-routing-clause
       :request-kind request-kind
       :candidates []}
      {:status :ok
       :request-kind request-kind
       :route-id (:contract/id clause)
       :candidates
       (->> projected-accounts
            (filter (fn [account]
                      (let [provider-id (projected-provider-id account)
                            account-id (projected-account-id account)
                            state (projected-availability-state account)
                            cooldown-ms (or (get-in account [:metadata :cooldownUntilMs])
                                            (get-in account [:metadata :cooldown-until-ms])
                                            0)]
                        (and provider-id
                             account-id
                             (or (empty? provider-ids) (contains? provider-ids (normalize-provider-id provider-id)))
                             (not (contains? local-keys (str (normalize-provider-id provider-id) "\u0000" account-id)))
                             (contains? admitted-states state)
                             (<= cooldown-ms now-ms)))))
            (sort-by (fn [account]
                       (mapv #(federation-sort-value account %) order)))
            vec)})))

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

(defn strategies-for-provider [input provider-id]
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

(defn- route-default-provider-ids [route]
  (if (= :route/default (:contract/id route))
    []
    (vec (:prefer/provider-order route))))

(defn- dedupe-provider-ids [provider-ids]
  (dedupe-provider-id-values provider-ids))

(defn request-or-route-provider-ids [route input]
  (let [available-provider-ids (if-let [provider-ids (seq (or (get-any input [:provider-ids :providerIds]) []))]
                                 (dedupe-provider-ids provider-ids)
                                 (dedupe-provider-ids (route-default-provider-ids route)))
        requested (set (map normalize-provider-id (requested-provider-ids input)))]
    (if (seq requested)
      (filterv #(contains? requested (normalize-provider-id %)) available-provider-ids)
      available-provider-ids)))

(defn- provider-route-by-id [compiled]
  (into {}
        (keep (fn [route]
                (let [provider-id (provider-route-provider-id route)
                      base-url (provider-route-base-url route)]
                  (when (and (string? provider-id)
                             (not (str/blank? provider-id))
                             (string? base-url)
                             (not (str/blank? base-url)))
                    [provider-id (cond-> {:provider-id provider-id
                                           :base-url base-url}
                                   (contains? route :auth/required?)
                                   (assoc :auth-required? (:auth/required? route))
                                   (contains? route :paths)
                                   (assoc :paths (:paths route)))]))))
        (:provider-routes compiled)))

(defn- selected-provider-routes [compiled provider-ids]
  (let [by-id (provider-route-by-id compiled)]
    (vec (keep by-id provider-ids))))

(defn model-family-for-model
  "Return the first compiled model-family contract matching model-id."
  [compiled model-id]
  (some #(when (pattern-matches? (:match/model-pattern %) model-id) %)
        (:model-families compiled)))

(defn resolve-model-alias
  "Return the provider-specific model alias for a model-id, or nil if none."
  [compiled model-id provider-id]
  (some #(when (and (pattern-matches? (:match/model-pattern %) model-id)
                    (pattern-matches? (:match/provider-pattern %) provider-id))
           (:alias/model-id %))
        (:model-aliases compiled)))

(defn- reasoning-token [value]
  (when (some? value)
    (let [s (-> (str value)
                str/trim
                str/lower-case
                (str/replace #"_" "-")
                (str/replace #"\\s+" "-"))]
      (when-not (str/blank? s)
        (keyword (case s
                   ("disable" "disabled" "off") "none"
                   ("normal" "auto") "medium"
                   ("x-high" "very-high" "extra-high") "xhigh"
                   s))))))

(defn- wire-effort [value]
  (cond
    (keyword? value) (name value)
    (string? value) value
    :else value))

(defn- family-native-efforts [family]
  (set (keep reasoning-token (:reasoning/native-efforts family))))

(defn- reasoning-normalization-for-family [compiled family-id]
  (some #(when (= family-id (:match/family %)) %)
        (:reasoning-normalizations compiled)))

(defn- normalize-effort-value [compiled family value]
  (let [token (reasoning-token value)
        clause (reasoning-normalization-for-family compiled (:contract/id family))
        effort-map (:normalize/effort-map clause)
        mapped (when token (get effort-map token))
        default (:normalize/default clause)
        native-efforts (family-native-efforts family)]
    (cond
      (some? mapped) mapped
      (and token (contains? native-efforts token)) token
      (some? default) default
      :else token)))

(defn- top-level-reasoning-effort-key [body]
  (some #(when (contains? body %) %)
        [:reasoning_effort :reasoningEffort :reasoning-effort]))

(defn- nested-reasoning-effort [body]
  (let [reasoning (:reasoning body)]
    (when (map? reasoning)
      (:effort reasoning))))

(defn- requested-reasoning-effort [body]
  (or (nested-reasoning-effort body)
      (some->> (top-level-reasoning-effort-key body) (get body))))

(defn- dissoc-top-level-reasoning-effort [body]
  (apply dissoc body [:reasoning_effort :reasoningEffort :reasoning-effort]))

(defn- remove-nested-reasoning-effort [body]
  (if (map? (:reasoning body))
    (update body :reasoning dissoc :effort)
    body))

(defn- apply-budget-reasoning [body normalized]
  (let [budget (if (number? normalized) normalized nil)
        disabled? (or (= :none normalized)
                      (= 0 budget))]
    (cond-> (-> body
                dissoc-top-level-reasoning-effort
                remove-nested-reasoning-effort)
      true (assoc :thinking (if disabled?
                              {:type "disabled"}
                              {:type "enabled"
                               :budget_tokens (or budget 12288)})))))

(defn- apply-effort-reasoning [body normalized]
  (let [effort (wire-effort normalized)
        top-key (top-level-reasoning-effort-key body)]
    (cond-> body
      top-key (assoc top-key effort)
      (map? (:reasoning body)) (assoc-in [:reasoning :effort] effort))))

(defn normalize-reasoning-request
  "Normalize flexible client reasoning language into the target model family's
  contract-native representation. This is pure policy: strategies receive the
  returned request body and should not reinterpret reasoning aliases."
  [compiled input]
  (let [body (or (get-any input [:request-body :requestBody]) {})
        model-id (or (get-any input [:model-id :modelId :routed-model :routedModel])
                     (:model body))
        family (model-family-for-model compiled model-id)
        requested (requested-reasoning-effort body)]
    (if (or (not (map? body)) (nil? requested) (nil? family))
      {:status :ok
       :request-body body
       :reasoning {:normalized? false
                   :reason :no-reasoning-effort-or-family
                   :model-id model-id}}
      (let [normalized (normalize-effort-value compiled family requested)
            control (or (:reasoning/control family) :effort-level)
            request-body (if (= :budget-tokens control)
                           (apply-budget-reasoning body normalized)
                           (apply-effort-reasoning body normalized))]
        {:status :ok
         :request-body request-body
         :reasoning {:normalized? (not= (reasoning-token requested) (reasoning-token normalized))
                     :model-id model-id
                     :family-id (:contract/id family)
                     :control control
                     :input-effort (wire-effort (reasoning-token requested))
                     :output-effort (wire-effort normalized)}}))))

(defn- missing-provider-route-ids [compiled provider-ids]
  (let [by-id (provider-route-by-id compiled)]
    (filterv #(not (contains? by-id %)) provider-ids)))

(defn evidence-filtered-provider-ids [route input provider-ids model-id]
  (if (= :route/default (:contract/id route))
    (let [evidenced (filterv #(provider-model-evidenced? input % model-id) provider-ids)]
      (if (seq evidenced) evidenced provider-ids))
    provider-ids))

(defn- strategy-by-provider [compiled route input request-kind provider-ids]
  (into {}
        (map (fn [provider-id]
               [provider-id
                (select-strategy-candidate compiled
                                           route
                                           provider-id
                                           request-kind
                                           (strategies-for-provider input provider-id))]))
        provider-ids))

(defn preview-policy-decision
  "Produce a pure policy decision preview from compiled declarative contracts.

  This function is intentionally side-effect-free. It exists for parity tests and
  live-runtime cutover preparation; it does not execute a provider strategy."
  [compiled input]
  (let [model-id (or (get-any input [:model-id :modelId :requested-model :requestedModel]) "")
        request-kind (normalized-keyword (or (get-any input [:request-kind :requestKind]) :chat))
        tenant-settings (or (get-any input [:tenant-settings :tenantSettings]) {})]
    (if-not (tenant-model-allowed? tenant-settings model-id)
      {:status :denied
       :reason :tenant-model-not-allowed
       :model-id model-id}
      (if-let [bound-account (and (model-scoped-affinity-matches? input model-id)
                                  (affinity-bound-account input))]
        (let [provider-id (:provider-id bound-account)]
          (if-let [missing-route (first (missing-provider-route-ids compiled [provider-id]))]
            {:status :exhausted
             :reason :missing-provider-route
             :model-id model-id
             :route-id :route/prompt-affinity
             :providers [provider-id]
             :missing-provider-routes [missing-route]}
            {:status :ok
             :reason :prompt-affinity-bound
             :model-id model-id
             :request-kind request-kind
             :route-id :route/prompt-affinity
             :providers [provider-id]
             :provider-routes (selected-provider-routes compiled [provider-id])
              :provider-id provider-id
              :accounts [bound-account]
              :account bound-account
              :applies-account-constraint true
              :strategy-by-provider (strategy-by-provider compiled
                                                          nil
                                                          input
                                                          request-kind
                                                          [provider-id])
              :strategies (order-strategy-candidates compiled
                                                      nil
                                                      provider-id
                                                     request-kind
                                                     (strategies-for-provider input provider-id))
             :strategy (select-strategy-candidate compiled
                                                  nil
                                                  provider-id
                                                  request-kind
                                                  (strategies-for-provider input provider-id))}))
        (if-let [route (select-routing-clause compiled model-id)]
          (let [provider-ids (request-or-route-provider-ids route input)
              surface-providers (filterv #(request-surface-provider-allowed? compiled % request-kind)
                                         provider-ids)
              evidenced-providers (evidence-filtered-provider-ids route input surface-providers model-id)
              tenant-allowed-providers (filterv #(tenant-provider-allowed? tenant-settings %) evidenced-providers)
              ordered-providers (vec (order-provider-candidates route tenant-allowed-providers))
              provider-id (first ordered-providers)]
          (if-not provider-id
            {:status :exhausted
             :reason :no-provider-candidates
             :model-id model-id
             :route-id (:contract/id route)
             :providers []}
            (if (seq (missing-provider-route-ids compiled ordered-providers))
              {:status :exhausted
               :reason :missing-provider-route
               :model-id model-id
               :route-id (:contract/id route)
               :providers ordered-providers
               :missing-provider-routes (missing-provider-route-ids compiled ordered-providers)}
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
                 :provider-routes (selected-provider-routes compiled ordered-providers)
                 :provider-id provider-id
                  :accounts ordered-accounts
                  :account (first ordered-accounts)
                  :applies-account-constraint (:applies-constraint account-result)
                  :strategy-by-provider (strategy-by-provider compiled
                                                              route
                                                              input
                                                              request-kind
                                                              ordered-providers)
                  :strategies ordered-strategies
                  :strategy (first ordered-strategies)}))))
          {:status :exhausted
           :reason :no-routing-clause
           :model-id model-id})))))

(defn compile-contracts
  "Compile loaded declarative policy contracts into phase-oriented indexes.

  This does not execute policy yet; it makes references explicit so parity tests
  can compare the declarative program with current runtime behavior."
  [contracts]
  (let [idx (index-contracts contracts)]
     {:index idx
      :routing-clauses (routing-clauses idx)
      :provider-capabilities (provider-capabilities idx)
       :federation-routing-clauses (federation-routing-clauses idx)
       :model-families (model-families idx)
      :reasoning-normalizations (reasoning-normalizations idx)
      :model-aliases (model-aliases idx)
      :queue-templates (queue-templates idx)
      :queue-instances (queue-instances idx)
      :provider-routes (provider-routes idx)
      :provider-seed-specs (provider-seed-specs idx)
      :request-surface-defaults (request-surface-defaults idx)
      :account-orderings (account-orderings idx)
      :account-constraints (account-constraints idx)
      :default-strategy-order (default-strategy-order idx)
      :tenant-authorization-clauses (tenant-authorization-clauses idx)
      :fallback-policy (fallback-policy idx)
      :root-program (root-program idx)}))
