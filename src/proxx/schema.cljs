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

(def ProviderWireProfileContract
  "How a provider's non-standard upstream is addressed: which endpoint and
  `x-api-provider` a model uses (first matching route wins; the last route is a
  catch-all), the static headers it requires, and prompt rewrites it demands."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :provider-wire-profile]]
    [:wire/provider-id [:string {:min 1}]]
    [:wire/context-length-keys {:optional true} [:vector [:string {:min 1}]]]
    [:wire/model-routes
     {:optional true}
     [:vector {:min 1}
      [:map
       [:match/model-pattern [:string {:min 1}]]
       [:wire/api-provider [:string {:min 1}]]
       [:wire/model-type {:optional true} :keyword]
       [:wire/endpoint-path {:optional true} [:string {:min 1}]]]]]
    [:wire/static-headers {:optional true} [:map-of :string :string]]
    [:wire/anthropic-headers {:optional true} [:map-of :string :string]]
    [:wire/thinking-beta-header {:optional true} [:string {:min 1}]]
    [:wire/static-key-prefix {:optional true} [:string {:min 1}]]
    [:wire/prompt-rewrites
     {:optional true}
     [:vector [:map
               [:match/system-contains [:string {:min 1}]]
               [:wire/replace-with [:string {:min 1}]]]]]]])

(def ProviderSurfaceFactsContract
  "Facts about which provider/model surfaces exist: which providers speak the
  OpenAI-compatible and Responses APIs, how hosted-OpenAI model ids look, which
  provider ids are dedicated Ollama hosts, where a provider's model catalog
  lives, and which bridge paths a capability-less bridge may serve. Interpreted
  by `proxx.routing.surface`; never restated in TypeScript."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :provider-surface-facts]]
    [:surface/openai-compatible-providers NonEmptyStringVector]
    [:surface/responses-providers NonEmptyStringVector]
    [:surface/hosted-openai-model-patterns NonEmptyStringVector]
    [:surface/dedicated-ollama-provider-pattern [:string {:min 1}]]
    [:surface/ollama-base-url-provider [:string {:min 1}]]
    [:surface/local-ollama-provider-id [:string {:min 1}]]
    [:surface/ollama-provider-id-pattern [:string {:min 1}]]
    [:surface/explicit-ollama-prefixes NonEmptyStringVector]
    [:surface/legacy-bridge-path-prefixes NonEmptyStringVector]
    [:catalog/source-paths
     [:vector {:min 1}
      [:map
       [:match/provider-pattern [:string {:min 1}]]
       [:catalog/paths NonEmptyStringVector]]]]
    [:catalog/codex-markers
     [:map
      [:openai-base-url-contains NonEmptyStringVector]
      [:openai-path-contains NonEmptyStringVector]]]
    [:catalog/ollama-paths NonEmptyStringVector]]])

(def AutoModelProfileContract
  "Facts behind auto:* model selection: default candidate list, and per model an
  intelligence rank and the optional capabilities it supports."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :auto-model-profile]]
    [:auto/default-intelligence [:int {:min 0}]]
    [:auto/default-candidates [:vector [:string {:min 1}]]]
    [:auto/models
     [:map-of [:string {:min 1}]
      [:map
       [:intelligence {:optional true} [:int {:min 0}]]
       [:capabilities {:optional true} [:set [:enum :vision :tools :thinking]]]]]]]])

(def UpstreamAttemptPolicyContract
  "How an upstream attempt is judged: which statuses retry the same credential,
  cool it down or disable it for good (with per-provider exceptions), the
  cooldown ceilings by failure kind, and the ordering/route-quality constants."
  (let [Statuses [:set [:int {:min 100 :max 599}]]
        ByProvider [:map-of [:string {:min 1}] Statuses]
        Ms [:int {:min 0}]]
    [:and
     ContractBase
     [:map
      [:contract/kind [:enum :upstream-attempt-policy]]
      [:attempt/retry-same-credential [:map [:statuses Statuses] [:by-provider ByProvider]]]
      [:attempt/auth-cooldown [:map [:statuses Statuses] [:except-by-provider ByProvider] [:cap-ms Ms]]]
      [:attempt/permanent-disable
       [:map [:auth-types [:set :keyword]] [:statuses Statuses] [:except-by-provider ByProvider] [:cooldown-ms Ms]]]
      [:attempt/cooldown-caps [:map-of :keyword Ms]]
      [:attempt/latency-ordering [:map [:ttft-grace-ms Ms] [:window-size [:int {:min 1}]]]]
      [:attempt/plan-cost-tier [:map-of [:string {:min 1}] [:int {:min 0}]]]
      [:attempt/free-plan-first
       [:vector [:map [:provider-id [:string {:min 1}]] [:model-prefix [:string {:min 1}]]]]]
      [:attempt/max-sticky-transport-failures [:int {:min 1}]]
      [:attempt/route-quality
       [:map [:min-latency-ms Ms] [:max-latency-ms Ms] [:floor [:and number? [:fn pos?]]]]]]]))

(def StrategyRegistryContract
  "Ordered strategy descriptors with data predicates over request facts; first
  match wins. See 78-strategy-registry.edn for the predicate forms."
  (let [Pred [:or
              [:tuple [:enum :true :not-true] :keyword]
              [:tuple [:enum :eq :not-eq] :keyword [:or :string :keyword]]
              [:tuple [:enum :in] :keyword [:set :string]]
              [:tuple [:enum :fn] :keyword]
              [:tuple [:enum :not] [:tuple [:enum :fn] :keyword]]]]
    [:and
     ContractBase
     [:map
      [:contract/kind [:enum :strategy-registry]]
      [:registry/entries
       [:vector {:min 1}
        [:map
         [:strategy/id :keyword]
         [:strategy/mode [:string {:min 1}]]
         [:strategy/local? {:optional true} :boolean]
         [:strategy/path {:optional true}
          [:map
           [:static {:optional true} [:string {:min 1}]]
           [:config-key {:optional true} [:string {:min 1}]]
           [:provider-path-key {:optional true} [:string {:min 1}]]
           [:template {:optional true} [:string {:min 1}]]
           [:model-default {:optional true} [:string {:min 1}]]]]
         [:strategy/match [:vector Pred]]]]]
      [:registry/payload-rules
       [:map
        [:codex-unsupported-params [:vector [:string {:min 1}]]]
        [:factory-default-max-tokens [:int {:min 1}]]
        [:ovm-default-model [:string {:min 1}]]]]
      [:registry/compat-embedding-providers [:set [:string {:min 1}]]]]]))

(def AutoModelChainsContract
  "Fallback-chain auto models (vision, cephalon) and the shared advance rule."
  (let [Models [:vector [:string {:min 1}]]]
    [:and
     ContractBase
     [:map
      [:contract/kind [:enum :auto-model-chains]]
      [:chains/max-candidates [:map [:default [:int {:min 1}]] [:ceiling [:int {:min 1}]]]]
      [:chains/advance-on [:vector :keyword]]
      [:chains/vision
       [:map
        [:model-chain Models]
        [:route-priority
         [:vector [:map
                   [:models {:optional true} [:set [:string {:min 1}]]]
                   [:model-prefix {:optional true} [:string {:min 1}]]
                   [:model-contains {:optional true} [:string {:min 1}]]
                   [:provider-ids {:optional true} [:set [:string {:min 1}]]]
                   [:provider-prefix {:optional true} [:string {:min 1}]]]]]]]
      [:chains/cephalon
       [:map
        [:preferred-models Models] [:ollama-preferred Models] [:ollama-fast-order Models]
        [:ollama-smart-order Models] [:empty-ranking-fallback [:string {:min 1}]]]]]]))

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

(def ModelPricingSnapshotContract
  "Locates the models.dev price table (EDN) relative to the contract file."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-pricing-snapshot]]
    [:snapshot/path [:string {:min 1}]]]])

(def ModelPricingProviderRuleContract
  "A routed provider id either maps onto a models.dev provider or is local (free)."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-pricing-provider-rule]]
    [:match/provider-id [:string {:min 1}]]
    [:pricing/models-dev-provider {:optional true} [:string {:min 1}]]
    [:pricing/local {:optional true} :boolean]]
   [:fn {:error/message "provider rule requires :pricing/models-dev-provider or :pricing/local"}
    (fn [m] (boolean (or (:pricing/models-dev-provider m) (:pricing/local m))))]])

(def ModelPricingVendorFallbackContract
  "Canonical vendor providers to consult for a model whose id starts with one of the prefixes."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-pricing-vendor-fallback]]
    [:match/model-prefixes [:vector {:min 1} [:string {:min 1}]]]
    [:pricing/vendor-providers [:vector {:min 1} [:string {:min 1}]]]]])

(def ModelEnergyProfileContract
  "Joules per token for models matching a pattern; a profile without a pattern is the default."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :model-energy-profile]]
    [:match/model-pattern {:optional true} [:string {:min 1}]]
    [:energy/joules-per-input-token number?]
    [:energy/joules-per-output-token number?]]])

(def ModelsDevPricingSnapshot
  "The models.dev price table: per provider an ordered vector of [model-id cost].
  Order is data (it decides lookup ties), hence vectors rather than maps."
  [:map
   [:generated-at :string]
   [:source-url :string]
   [:providers
    [:map-of :string
     [:vector [:tuple :string
               [:map-of [:enum :input :output :reasoning :cache-read :cache-write] number?]]]]]])

(def ProviderQuotaProfileContract
  "Endpoints, client id, timeouts and probe settings for reading a provider account's quota."
  [:and
   ContractBase
   [:map
    [:contract/kind [:enum :provider-quota-profile]]
    [:quota/token-url [:string {:min 1}]]
    [:quota/usage-url [:string {:min 1}]]
    [:quota/client-id [:string {:min 1}]]
    [:quota/refresh-buffer-ms [:int {:min 0}]]
    [:quota/usage-timeout-ms [:int {:min 1}]]
    [:quota/probe-timeout-ms [:int {:min 1}]]
    [:quota/probe-model [:string {:min 1}]]
    [:quota/probe-expected-text [:string {:min 1}]]]])

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
    [:provider-wire-profile ProviderWireProfileContract]
    [:provider-surface-facts ProviderSurfaceFactsContract]
    [:auto-model-profile AutoModelProfileContract]
    [:upstream-attempt-policy UpstreamAttemptPolicyContract]
    [:strategy-registry StrategyRegistryContract]
    [:auto-model-chains AutoModelChainsContract]
    [:authorization-clause AuthorizationClauseContract]
    [:model-pricing-override ModelPricingOverrideContract]
    [:model-pricing-snapshot ModelPricingSnapshotContract]
    [:model-pricing-provider-rule ModelPricingProviderRuleContract]
    [:model-pricing-vendor-fallback ModelPricingVendorFallbackContract]
    [:model-energy-profile ModelEnergyProfileContract]
    [:provider-quota-profile ProviderQuotaProfileContract]
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
   :proxx/models-dev-pricing-snapshot ModelsDevPricingSnapshot
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
    :proxx/contract-provider-wire-profile ProviderWireProfileContract
    :proxx/contract-provider-surface-facts ProviderSurfaceFactsContract
    :proxx/contract-auto-model-profile AutoModelProfileContract
    :proxx/contract-upstream-attempt-policy UpstreamAttemptPolicyContract
    :proxx/contract-strategy-registry StrategyRegistryContract
    :proxx/contract-auto-model-chains AutoModelChainsContract
   :proxx/contract-authorization-clause AuthorizationClauseContract
    :proxx/contract-model-pricing-override ModelPricingOverrideContract
    :proxx/contract-model-pricing-snapshot ModelPricingSnapshotContract
    :proxx/contract-model-pricing-provider-rule ModelPricingProviderRuleContract
    :proxx/contract-model-pricing-vendor-fallback ModelPricingVendorFallbackContract
    :proxx/contract-model-energy-profile ModelEnergyProfileContract
    :proxx/contract-provider-quota-profile ProviderQuotaProfileContract
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
