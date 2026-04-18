(ns proxx.ledger.schema
  (:require [malli.core :as m]
            [proxx.schema :as s]))

;; ── Shared primitives ────────────────────────────────────────────────────────

(def SessionId  :string)
(def HarnessId  :string)
(def RequestId  :string)
(def EpochId    :string)  ;; hash of most recent failure event for a given (session,provider,account,model)

;; ── Outcome vocabulary ───────────────────────────────────────────────────────

(def RoutingOutcome
  [:enum
   :success
   :quota-exhausted
   :quota-exhausted-in-body   ;; e.g. Ollama 200 with quota message
   :rate-limited
   :timeout
   :server-error
   :auth-failure
   :invalid-request
   :empty-response
   :unrecognized-schema
   :all-strategies-exhausted])

(def QuotaWindowType
  [:enum :short :long :weekly :unknown])

(def ChurnType
  [:enum :tool-call-pruning :compaction :client-unknown])

(def CooldownReason
  [:enum :quota-short :quota-weekly :error-rate :latency :manual])

(def HealthThresholdType
  [:enum :degraded :recovered])

;; ── Base event fields ────────────────────────────────────────────────────────
;; Every ledger event carries these.

(def BaseEvent
  [:map
   [:event-id     :string]
   [:event-type   :keyword]
   [:ts           :int]          ;; epoch ms
   [:session-id   {:optional true} SessionId]
   [:provider-id  {:optional true} s/ProviderId]
   [:account-id   {:optional true} s/AccountId]
   [:model-id     {:optional true} s/ModelId]
   [:provenance   {:optional true} s/Provenance]])

;; ── 1. Session start ─────────────────────────────────────────────────────────
;; First occurrence of a client providing a given cache key.

(def SessionStartEvent
  [:merge BaseEvent
   [:map
    [:event-type          [:= :session-start]]
    [:session-id          SessionId]
    [:harness-id          HarnessId]
    [:harness-cache-key   :string]   ;; what the client calls it
    [:derived-cache-key   :string]   ;; our computed internal key at epoch 0
    [:provider-id         s/ProviderId]
    [:account-id          s/AccountId]
    [:model-id            s/ModelId]]])

;; ── 2. Empty / unrecognized provider response ────────────────────────────────
;; Covers Ollama-style silent quota exhaustion (200 + quota message in body).

(def EmptyProviderResponseEvent
  [:merge BaseEvent
   [:map
    [:event-type      [:= :empty-provider-response]]
    [:request-id      RequestId]
    [:http-status     :int]
    [:raw-body        {:optional true} :string]   ;; kept for re-labelling
    [:outcome         RoutingOutcome]
    [:label           {:optional true} :string]   ;; classifier output
    [:label-confidence {:optional true} :double]]])

(def UnrecognizedSchemaEvent
  [:merge BaseEvent
   [:map
    [:event-type   [:= :unrecognized-response-schema]]
    [:request-id   RequestId]
    [:http-status  :int]
    [:raw-body     {:optional true} :string]
    [:expected-schema :keyword]]])

;; ── 3. Session account changed ───────────────────────────────────────────────

(def SessionAccountChangedEvent
  [:merge BaseEvent
   [:map
    [:event-type       [:= :session-account-changed]]
    [:session-id       SessionId]
    [:from-account-id  s/AccountId]
    [:to-account-id    s/AccountId]
    [:from-provider-id {:optional true} s/ProviderId]
    [:to-provider-id   {:optional true} s/ProviderId]
    [:reason           RoutingOutcome]
    [:epoch-id-before  EpochId]
    [:epoch-id-after   EpochId]]])

;; ── 4. Session model changed ─────────────────────────────────────────────────

(def SessionModelChangedEvent
  [:merge BaseEvent
   [:map
    [:event-type     [:= :session-model-changed]]
    [:session-id     SessionId]
    [:from-model-id  s/ModelId]
    [:to-model-id    s/ModelId]
    [:reason         [:enum :context-overflow :policy :manual :client-requested]]
    [:epoch-id-before EpochId]
    [:epoch-id-after  EpochId]]])

;; ── 5. Session churn detected ────────────────────────────────────────────────
;; Client-side tool-call pruning or compaction broke affinity.

(def SessionChurnDetectedEvent
  [:merge BaseEvent
   [:map
    [:event-type            [:= :session-churn-detected]]
    [:session-id            SessionId]
    [:churn-type            ChurnType]
    [:prefix-similarity-before {:optional true} :double]   ;; 0..1
    [:prefix-similarity-after  {:optional true} :double]
    [:message-count-before  {:optional true} :int]
    [:message-count-after   {:optional true} :int]]])

;; ── 6. Context overflow detected ────────────────────────────────────────────
;; Hit practical context limit for (provider, model).
;; Distinct from advertised limit — captures actual observed behavior.

(def ContextOverflowDetectedEvent
  [:merge BaseEvent
   [:map
    [:event-type               [:= :context-overflow-detected]]
    [:session-id               SessionId]
    [:tokens-in                :int]
    [:tokens-out               {:optional true} :int]
    [:advertised-context-limit {:optional true} :int]
    [:observed-limit-estimate  {:optional true} :int]
    [:overflow-signal          [:enum :hard-error :soft-truncation :empty-response :provider-message]]
    [:raw-signal               {:optional true} :string]]])

;; ── 7. Account cooldown initiated ───────────────────────────────────────────

(def AccountCooldownInitiatedEvent
  [:merge BaseEvent
   [:map
    [:event-type       [:= :account-cooldown-initiated]]
    [:reason           CooldownReason]
    [:cooldown-until   :int]       ;; epoch ms — expected expiry
    [:triggering-event-id {:optional true} :string]]])

;; ── 8. Account cooldown expired ─────────────────────────────────────────────

(def AccountCooldownExpiredEvent
  [:merge BaseEvent
   [:map
    [:event-type        [:= :account-cooldown-expired]]
    [:cooldown-initiated-at :int]
    [:cooldown-reason   CooldownReason]]])

;; ── 9. Quota reset detected ─────────────────────────────────────────────────

(def QuotaResetDetectedEvent
  [:merge BaseEvent
   [:map
    [:event-type      [:= :quota-reset-detected]]
    [:window-type     QuotaWindowType]
    [:detected-via    [:enum :explicit-api :inferred-from-traffic :manual]]
    [:tokens-available {:optional true} :int]
    [:reset-at        {:optional true} :int]]])

;; ── 10. Account health degraded ─────────────────────────────────────────────

(def AccountHealthDegradedEvent
  [:merge BaseEvent
   [:map
    [:event-type          [:= :account-health-degraded]]
    [:health-score-before :double]
    [:health-score-after  :double]
    [:degraded-threshold  :double]
    [:contributing-metrics {:optional true}
     [:map
      [:error-rate    {:optional true} :double]
      [:p50-latency-ms {:optional true} :double]
      [:p99-latency-ms {:optional true} :double]
      [:quota-pressure {:optional true} :double]]]]])

;; ── 11. Account health improved ─────────────────────────────────────────────

(def AccountHealthImprovedEvent
  [:merge BaseEvent
   [:map
    [:event-type           [:= :account-health-improved]]
    [:health-score-before  :double]
    [:health-score-after   :double]
    [:recovery-threshold   :double]
    [:contributing-metrics {:optional true}
     [:map
      [:error-rate    {:optional true} :double]
      [:p50-latency-ms {:optional true} :double]
      [:p99-latency-ms {:optional true} :double]
      [:quota-pressure {:optional true} :double]]]]])

;; ── Union / dispatch ─────────────────────────────────────────────────────────
;; All ledger events as a tagged union, dispatch on :event-type.

(def LedgerEvent
  [:multi {:dispatch :event-type}
   [:session-start                SessionStartEvent]
   [:empty-provider-response      EmptyProviderResponseEvent]
   [:unrecognized-response-schema UnrecognizedSchemaEvent]
   [:session-account-changed      SessionAccountChangedEvent]
   [:session-model-changed        SessionModelChangedEvent]
   [:session-churn-detected       SessionChurnDetectedEvent]
   [:context-overflow-detected    ContextOverflowDetectedEvent]
   [:account-cooldown-initiated   AccountCooldownInitiatedEvent]
   [:account-cooldown-expired     AccountCooldownExpiredEvent]
   [:quota-reset-detected         QuotaResetDetectedEvent]
   [:account-health-degraded      AccountHealthDegradedEvent]
   [:account-health-improved      AccountHealthImprovedEvent]])

(def registry
  {:ledger/event                    LedgerEvent
   :ledger/session-start            SessionStartEvent
   :ledger/empty-provider-response  EmptyProviderResponseEvent
   :ledger/unrecognized-schema      UnrecognizedSchemaEvent
   :ledger/session-account-changed  SessionAccountChangedEvent
   :ledger/session-model-changed    SessionModelChangedEvent
   :ledger/session-churn            SessionChurnDetectedEvent
   :ledger/context-overflow         ContextOverflowDetectedEvent
   :ledger/cooldown-initiated       AccountCooldownInitiatedEvent
   :ledger/cooldown-expired         AccountCooldownExpiredEvent
   :ledger/quota-reset              QuotaResetDetectedEvent
   :ledger/health-degraded          AccountHealthDegradedEvent
   :ledger/health-improved          AccountHealthImprovedEvent})
