(ns proxx.schema
  (:require [malli.core :as m]
            [malli.error :as me]
            [malli.registry :as mr]
            [malli.transform :as mt]))

;; ══════════════════════════════════════════════════════════════
;; Primitives
;; ══════════════════════════════════════════════════════════════

(def ProviderId  [:string {:min 1}])
(def AccountId   [:string {:min 1}])
(def ModelId     [:string {:min 1}])
(def TenantId    [:string {:min 1}])
(def PromptHash  [:string {:min 8}])   ;; sha-prefix, never empty
(def EpochMs     [:int    {:min 0}])

;; ══════════════════════════════════════════════════════════════
;; Provenance — every record carries this
;; ══════════════════════════════════════════════════════════════

(def Provenance
  [:map {:closed true}
   [:source      [:enum :seed :rest :ws :redis :lmdb :postgres]]
   [:ingested-at EpochMs]
   [:seed-hash   {:optional true} [:string {:min 1}]]
   [:request-id  {:optional true} [:string {:min 1}]]])

;; ══════════════════════════════════════════════════════════════
;; Domain schemas
;; :provenance is optional at schema level —
;; records may arrive pre-stamp; assert! at ingest boundary enforces it.
;; ══════════════════════════════════════════════════════════════

(def Provider
  [:map
   [:id           ProviderId]
   [:display-name [:string {:min 1}]]
   [:enabled      :boolean]
   [:meta         {:optional true} [:map-of :keyword :any]]
   [:provenance   {:optional true} Provenance]])

(def ProviderEndpoint
  [:map
   [:provider-id ProviderId]
   [:endpoint    [:enum :completions :responses :anthropic :ollama]]
   [:path        [:string {:min 1}]]
   [:supported   :boolean]
   [:provenance  {:optional true} Provenance]])

(def ProviderCredential
  [:map
   [:id          [:string {:min 1}]]
   [:provider-id ProviderId]
   [:account-id  {:optional true} AccountId]
   [:auth-type   [:string {:min 1}]]
   [:secret      [:string {:min 1}]]
   [:provenance  {:optional true} Provenance]])

(def ProviderModel
  [:map
   [:provider-id    ProviderId]
   [:model-id       ModelId]
   [:context-tokens [:int {:min 1}]]
   [:streaming      :boolean]
   [:vision         :boolean]
   [:default-task   {:optional true} [:string {:min 1}]]
   [:meta           {:optional true} [:map-of :keyword :any]]
   [:provenance     {:optional true} Provenance]])

(def PromptAffinityRecord
  [:map
   [:prompt-cache-key           PromptHash]
   [:model-id                   {:optional true} ModelId]
   [:provider-id                ProviderId]
   [:account-id                 AccountId]
   [:provisional-provider-id    {:optional true} ProviderId]
   [:provisional-account-id     {:optional true} AccountId]
   [:provisional-success-count  {:optional true} [:int {:min 1}]]
   [:updated-at                 EpochMs]
   [:provenance                 {:optional true} Provenance]])

(def PheromoneState
  [:map
   [:provider-id   ProviderId]
   [:model-id      ModelId]
   [:score         [:double {:min -10.0 :max 10.0}]]
   [:last-event-at EpochMs]
   [:provenance    {:optional true} Provenance]])

(def ScoringWeight
  [:map
   [:profile-id [:string {:min 1}]]
   [:metric-key [:string {:min 1}]]   ;; dot-path e.g. "latency.p99"
   [:weight     [:double {:min 0.0}]]
   [:transform  [:enum :linear :invert :normalize]]
   [:provenance {:optional true} Provenance]])

(def RoutingPolicy
  [:map
   [:id              [:string {:min 1}]]
   [:scoring-profile [:string {:min 1}]]
   [:sampler         [:enum :softmax :greedy :weighted-random :round-robin]]
   [:sampler-params  {:optional true} [:map-of :keyword :any]]
   [:max-attempts    [:int {:min 1 :max 10}]]
   [:fallback-policy {:optional true} [:string {:min 1}]]
   [:provenance      {:optional true} Provenance]])

(def AffinityPolicy
  [:map
   [:tenant-id                       {:optional true} TenantId]
   [:provisional-promotion-threshold [:int {:min 1}]]
   [:affinity-ttl-seconds            {:optional true} [:int {:min 1}]]
   [:enabled                         :boolean]
   [:provenance                      {:optional true} Provenance]])

(def EvalOp [:enum :all :some :none :not :assert])

(def EvalNode
  [:map
   [:eval/op EvalOp]
   [:eval/target {:optional true} :keyword]
   [:eval/forms [:vector :any]]])

(def PolicyOutcome [:enum :apply :try :next :reduce :sorted :project])

(def TraceEntry
  [:map
   [:trace/node-id :keyword]
   [:trace/op EvalOp]
   [:trace/outcome [:enum :pass :fail :skip]]
   [:trace/elapsed-ms :int]
   [:trace/reason {:optional true} :string]])

(def Policy
  [:and
   [:map
    [:contract/id :keyword]
    [:contract/kind [:enum :policy :strategy :model-family :model]]
    [:policy/condition {:optional true} [:ref :proxx/eval-node]]
    [:policy/filters {:optional true} [:vector [:ref :proxx/eval-node]]]
    [:policy/outcome PolicyOutcome]
    [:policy/sort {:optional true} [:ref :proxx/eval-node]]
    [:policy/project {:optional true} [:vector [:map
                                                [:project/to :keyword]
                                                [:project/from {:optional true} :keyword]
                                                [:project/form :any]
                                                [:project/distinct? {:optional true} :boolean]
                                                [:project/compact? {:optional true} :boolean]]]]
    [:policy/strategy {:optional true} :symbol]
    [:policy/children {:optional true} [:vector [:ref :proxx/policy]]]]
   [:fn {:error/message ":reduce outcome requires :policy/children"}
    (fn [m]
      (if (#{:reduce :sorted :project} (:policy/outcome m))
        (and (contains? m :policy/children)
             (seq (:policy/children m)))
        true))]
   [:fn {:error/message ":sorted outcome requires :policy/sort"}
    (fn [m]
      (if (= :sorted (:policy/outcome m))
        (some? (:policy/sort m))
        true))]
   [:fn {:error/message ":project outcome requires :policy/project"}
    (fn [m]
      (if (= :project (:policy/outcome m))
        (and (contains? m :policy/project)
             (seq (:policy/project m)))
        true))]
   [:fn {:error/message ":apply or :try outcome requires :policy/strategy"}
    (fn [m]
      (if (#{:apply :try} (:policy/outcome m))
        (some? (:policy/strategy m))
        true))]])

(def PolicyManifest
  [:map
   [:contract/id :keyword]
   [:contract/kind [:enum :policy-manifest]]
   [:policy.dsl/version :int]
   [:policy.dsl/status :keyword]
   [:policy.loader/order [:vector [:string {:min 1}]]]
   [:policy.loader/invariant {:optional true} [:string {:min 1}]]])

(def ContractBase
  [:map
   [:contract/id :keyword]
   [:contract/kind :keyword]])

(def NonEmptyStringVector [:vector [:string {:min 1}]])
(def KeywordVector [:vector :keyword])
(def ProviderIdVector [:vector ProviderId])
(def RetryBackoff [:enum :fixed :incremental :exponential :immediate])
(def QueueStatus [:enum :active :paused :draining :disabled])

(def DomainEnumContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :enum]]
    [:enum/items {:optional true} [:vector :keyword]]
    [:enum/values {:optional true} [:vector :keyword]]]
   [:fn {:error/message "enum contract requires :enum/items or :enum/values"}
    (fn [m] (boolean (or (:enum/items m) (:enum/values m))))]])

(def DomainSetContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :set]]
    [:set/items [:vector :any]]]])

(def ScoringTableContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :scoring-table]]
    [:score/by-plan [:map-of :keyword [:double {:min 0.0}]]]]])

(def PreferenceOrderContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :preference-order]]
    [:preference/items [:vector :any]]]])

(def ProviderSeedContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :provider-seed]]
    [:provider-id-env-names {:optional true} NonEmptyStringVector]
    [:provider-id-fallback ProviderId]
    [:provider/base-url {:optional true} [:string {:min 1}]]
    [:provider/baseUrl {:optional true} [:string {:min 1}]]
    [:base-url {:optional true} [:string {:min 1}]]
    [:baseUrl {:optional true} [:string {:min 1}]]
    [:key-env-names NonEmptyStringVector]]])

(def ProviderRouteContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :provider-route]]
    [:provider/id {:optional true} ProviderId]
    [:provider-id {:optional true} ProviderId]
    [:providerId {:optional true} ProviderId]
    [:provider/base-url {:optional true} [:string {:min 1}]]
    [:provider/baseUrl {:optional true} [:string {:min 1}]]
    [:base-url {:optional true} [:string {:min 1}]]
    [:baseUrl {:optional true} [:string {:min 1}]]
    [:paths {:optional true} [:map-of :keyword [:string {:min 1}]]]]
   [:fn {:error/message "provider-route requires a provider id"}
    (fn [m] (boolean (or (:provider/id m) (:provider-id m) (:providerId m))))]
   [:fn {:error/message "provider-route requires a base URL"}
    (fn [m] (boolean (or (:provider/base-url m) (:provider/baseUrl m) (:base-url m) (:baseUrl m))))]])

(def ModelFamilyContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-family]]
    [:match/model-pattern [:string {:min 1}]]
    [:reasoning/control {:optional true} [:enum :none :effort-level :budget-tokens]]
    [:reasoning/native-efforts {:optional true} [:vector [:or :keyword [:string {:min 1}]]]]
    [:reasoning/budget-by-effort {:optional true} [:map-of :keyword [:int {:min 0}]]]]])

(def ModelContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model]]
    [:model/id ModelId]
    [:model/family {:optional true} :keyword]
    [:model/provider {:optional true} ProviderId]]])

(def ProviderCapabilityContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :provider-capability]]
    [:match/provider-pattern [:string {:min 1}]]
    [:match/request-kind {:optional true} :keyword]
    [:prefer/strategies {:optional true} KeywordVector]
    [:exclude/strategies {:optional true} KeywordVector]]])

(def RequestSurfaceDefaultContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :request-surface-default]]
    [:match/provider-pattern [:string {:min 1}]]
    [:match/request-kind :keyword]
    [:prefer/strategies {:optional true} KeywordVector]
    [:exclude/strategies {:optional true} KeywordVector]]])

(def RoutingClauseContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :routing-clause]]
    [:match/family :keyword]
    [:prefer/providers {:optional true} [:or :keyword ProviderIdVector]]
    [:prefer/providers-strict? {:optional true} :boolean]
    [:exclude/providers {:optional true} ProviderIdVector]
    [:require/plans {:optional true} [:or :keyword KeywordVector]]
    [:exclude/plans {:optional true} KeywordVector]
    [:prefer/strategies {:optional true} KeywordVector]
    [:account/order {:optional true} :keyword]]])

(def SelectionRuleContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :selection-rule]]
    [:match/request-kind {:optional true} :keyword]
    [:match/provider-pattern {:optional true} [:string {:min 1}]]
    [:prefer/strategies {:optional true} KeywordVector]
    [:exclude/strategies {:optional true} KeywordVector]]])

(def AccountOrderingContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :account-ordering]]
    [:selection/order [:vector :any]]]])

(def AccountConstraintContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :account-constraint]]
    [:require/plans {:optional true} [:or :keyword KeywordVector]]
    [:exclude/plans {:optional true} KeywordVector]]])

(def FederationRoutingClauseContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :federation-routing-clause]]
    [:match/request-kind {:optional true} :keyword]
    [:admit/share-modes {:optional true} [:map-of :keyword KeywordVector]]
    [:admit/availability-states {:optional true} KeywordVector]
    [:selection/order {:optional true} [:vector :keyword]]]])

(def AuthorizationClauseContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :authorization-clause]]
    [:authz/domain :keyword]]])

(def ModelPricingOverrideContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-pricing-override]]
    [:match/model-pattern [:string {:min 1}]]]])

(def ModelAliasContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-alias]]
    [:match/model-pattern [:string {:min 1}]]
    [:match/provider-pattern [:string {:min 1}]]
    [:alias/model-id [:string {:min 1}]]]])

(def ReasoningNormalizationContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :reasoning-normalization]]
    [:match/family :keyword]
    [:normalize/from :keyword]
    [:normalize/effort-map [:map-of :keyword [:or :keyword [:int {:min 0}]]]]
    [:normalize/default {:optional true} [:or :keyword [:int {:min 0}]]]]])

(def RequestQueueTemplateContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :request-queue-template]]
    [:queue/name [:string {:min 1}]]
    [:queue/status {:optional true :default :active} QueueStatus]
    [:queue/concurrency-limit [:int {:min 1 :max 256}]]
    [:queue/max-queue-size [:int {:min 0 :max 10000}]]
    [:queue/overflow-policy [:enum :drop :reject]]
    [:queue/attempt-timeout-ms [:int {:min 100}]]
    [:queue/total-timeout-ms {:optional true} [:int {:min 100}]]
    [:queue/max-retries [:int {:min 0 :max 20}]]
    [:queue/retry-backoff RetryBackoff]
    [:queue/fail-fast? {:optional true :default false} :boolean]
    [:queue/jitter-factor {:optional true :default 0.2} [:double {:min 0.0 :max 1.0}]]
    [:queue/base-interval-ms {:optional true} [:int {:min 0}]]
    [:queue/retry-after-respect? {:optional true :default true} :boolean]
    [:provenance {:optional true} Provenance]]
   [:fn {:error/message ":queue/total-timeout-ms must exceed :queue/attempt-timeout-ms"}
    (fn [m]
      (if (and (:queue/total-timeout-ms m) (:queue/attempt-timeout-ms m))
        (> (:queue/total-timeout-ms m) (:queue/attempt-timeout-ms m))
        true))]
   [:fn {:error/message ":queue/base-interval-ms required for :fixed, :incremental, or :exponential backoff"}
    (fn [m]
      (if (#{:fixed :incremental :exponential} (:queue/retry-backoff m))
        (some? (:queue/base-interval-ms m))
        true))]])

(def RequestQueueInstanceContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :request-queue-instance]]
    [:queue/template-id :keyword]
    [:queue/tenant-id {:optional true} TenantId]
    [:queue/provider-id {:optional true} ProviderId]
    [:match/family {:optional true} :keyword]
    [:match/request-kind {:optional true} :keyword]
    [:queue/status {:optional true} [:maybe QueueStatus]]
    [:queue/concurrency-limit {:optional true} [:maybe [:int {:min 1 :max 256}]]]
    [:queue/max-queue-size {:optional true} [:maybe [:int {:min 0 :max 10000}]]]
    [:queue/overflow-policy {:optional true} [:maybe [:enum :drop :reject]]]
    [:queue/attempt-timeout-ms {:optional true} [:maybe [:int {:min 100}]]]
    [:queue/total-timeout-ms {:optional true} [:maybe [:int {:min 100}]]]
    [:queue/max-retries {:optional true} [:maybe [:int {:min 0 :max 20}]]]
    [:queue/retry-backoff {:optional true} [:maybe RetryBackoff]]
    [:queue/fail-fast? {:optional true} [:maybe :boolean]]
    [:queue/jitter-factor {:optional true} [:maybe [:double {:min 0.0 :max 1.0}]]]
    [:queue/base-interval-ms {:optional true} [:maybe [:int {:min 0}]]]
    [:queue/retry-after-respect? {:optional true} [:maybe :boolean]]
    [:queue/active-count {:optional true} [:int {:min 0}]]
    [:queue/queued-count {:optional true} [:int {:min 0}]]
    [:queue/last-enqueued-at {:optional true} EpochMs]
    [:provenance {:optional true} Provenance]]
   [:fn {:error/message ":request-queue-instance requires at least one scope key"}
    (fn [m]
      (boolean (or (:queue/tenant-id m)
                   (:queue/provider-id m)
                   (:match/family m)
                   (:match/request-kind m))))]
   [:fn {:error/message ":queue/total-timeout-ms must exceed :queue/attempt-timeout-ms"}
    (fn [m]
      (if (and (:queue/total-timeout-ms m) (:queue/attempt-timeout-ms m))
        (> (:queue/total-timeout-ms m) (:queue/attempt-timeout-ms m))
        true))]])

(def PolicyProgramContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :policy-program]]
    [:program/phases [:vector :keyword]]]])

(def StrategyBindingContract
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :strategy-binding]]
    [:strategy/mode {:optional true} :keyword]
    [:match/strategy {:optional true} :keyword]
    [:policy/strategy {:optional true} :symbol]]
   [:fn {:error/message "strategy-binding requires :strategy/mode, :match/strategy, or :policy/strategy"}
    (fn [m] (boolean (or (:strategy/mode m) (:match/strategy m) (:policy/strategy m))))]])

(def PolicyContract
  [:multi {:dispatch :contract/kind}
   [:enum DomainEnumContract]
   [:set DomainSetContract]
   [:scoring-table ScoringTableContract]
   [:preference-order PreferenceOrderContract]
   [:provider-seed ProviderSeedContract]
   [:provider-route ProviderRouteContract]
   [:model-family ModelFamilyContract]
   [:model ModelContract]
   [:provider-capability ProviderCapabilityContract]
   [:request-surface-default RequestSurfaceDefaultContract]
   [:routing-clause RoutingClauseContract]
   [:selection-rule SelectionRuleContract]
    [:account-ordering AccountOrderingContract]
    [:account-constraint AccountConstraintContract]
    [:federation-routing-clause FederationRoutingClauseContract]
    [:authorization-clause AuthorizationClauseContract]
    [:model-pricing-override ModelPricingOverrideContract]
    [:model-alias ModelAliasContract]
    [:reasoning-normalization ReasoningNormalizationContract]
   [:request-queue-template RequestQueueTemplateContract]
   [:request-queue-instance RequestQueueInstanceContract]
   [:policy-program PolicyProgramContract]
   [:strategy-binding StrategyBindingContract]
   [:policy Policy]
   [:strategy Policy]])

;; ══════════════════════════════════════════════════════════════
;; Registry — single source of truth
;; ══════════════════════════════════════════════════════════════

(def registry
  {:provenance        Provenance
   :provider            Provider
   :provider-endpoint   ProviderEndpoint
   :provider-credential ProviderCredential
   :provider-model      ProviderModel
   :prompt-affinity     PromptAffinityRecord
   :pheromone-state   PheromoneState
   :scoring-weight    ScoringWeight
   :routing-policy    RoutingPolicy
   :affinity-policy   AffinityPolicy
   :proxx/eval-op         EvalOp
   :proxx/eval-node       EvalNode
   :proxx/outcome         PolicyOutcome
   :proxx/trace-entry     TraceEntry
   :proxx/policy          Policy
   :proxx/policy-manifest PolicyManifest
   :proxx/contract-base ContractBase
   :proxx/contract-enum DomainEnumContract
   :proxx/contract-set DomainSetContract
   :proxx/contract-scoring-table ScoringTableContract
   :proxx/contract-preference-order PreferenceOrderContract
   :proxx/contract-provider-seed ProviderSeedContract
   :proxx/contract-provider-route ProviderRouteContract
   :proxx/contract-model-family ModelFamilyContract
   :proxx/contract-model ModelContract
   :proxx/contract-provider-capability ProviderCapabilityContract
   :proxx/contract-request-surface-default RequestSurfaceDefaultContract
   :proxx/contract-routing-clause RoutingClauseContract
   :proxx/contract-selection-rule SelectionRuleContract
    :proxx/contract-account-ordering AccountOrderingContract
    :proxx/contract-account-constraint AccountConstraintContract
    :proxx/contract-federation-routing-clause FederationRoutingClauseContract
   :proxx/contract-authorization-clause AuthorizationClauseContract
    :proxx/contract-model-pricing-override ModelPricingOverrideContract
    :proxx/contract-model-alias ModelAliasContract
    :proxx/contract-reasoning-normalization ReasoningNormalizationContract
   :proxx/retry-backoff RetryBackoff
   :proxx/queue-status QueueStatus
   :proxx/contract-request-queue-template RequestQueueTemplateContract
   :proxx/contract-request-queue-instance RequestQueueInstanceContract
   :proxx/contract-policy-program PolicyProgramContract
   :proxx/contract-strategy-binding StrategyBindingContract
   :proxx/policy-contract PolicyContract})

(mr/set-default-registry!
  (mr/composite-registry
    (m/default-schemas)
    registry))

;; ══════════════════════════════════════════════════════════════
;; Public API
;; ══════════════════════════════════════════════════════════════

(defn schema-for [entity-type]
  (or (get registry entity-type)
      (throw (ex-info "Unknown entity-type"
                      {:entity-type entity-type
                       :known (keys registry)}))))

(defn validate
  "Returns [:ok record] or [:error humanized-explanation]."
  [entity-type record]
  (let [schema (schema-for entity-type)]
    (if (m/validate schema record)
      [:ok record]
      [:error (me/humanize (m/explain schema record))])))

(defn- sanitize-record
  "Redact sensitive keys from a record before including in error messages."
  [record]
  (if (map? record)
    (reduce-kv (fn [acc k v]
                 (if (#{:secret :password :apiKey :api-key :token} k)
                   (assoc acc k "[REDACTED]")
                   (assoc acc k v)))
               {}
               record)
    record))

(defn assert!
  "Throws on schema failure. Use at ingest boundaries."
  [entity-type record]
  (let [[status result] (validate entity-type record)]
    (if (= :ok status)
      record
      (throw (ex-info "Schema assertion failed"
                      {:entity-type entity-type
                       :errors      result
                       :input       (sanitize-record record)})))))

(defn- apply-policy-contract-defaults [record]
  (if (= :request-queue-template (:contract/kind record))
    (merge {:queue/status :active
            :queue/jitter-factor 0.2
            :queue/fail-fast? false
            :queue/retry-after-respect? true}
           record)
    record))

(defn coerce
  "Attempt to coerce record via malli default-value-transformer.
   Returns coerced record or nil on failure."
  [entity-type record]
  (let [schema (schema-for entity-type)]
    (try
      (let [coerced (apply-policy-contract-defaults
                     (m/coerce schema record (mt/default-value-transformer)))]
        (when (m/validate schema coerced) coerced))
      (catch :default _ nil))))
