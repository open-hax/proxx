(ns proxx.schema
  (:require [malli.core :as m]
            [malli.error :as me]
            [malli.registry :as mr]))

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

;; ══════════════════════════════════════════════════════════════
;; Registry — single source of truth
;; ══════════════════════════════════════════════════════════════

(def registry
  {:provenance        Provenance
   :provider          Provider
   :provider-endpoint ProviderEndpoint
   :provider-model    ProviderModel
   :prompt-affinity   PromptAffinityRecord
   :pheromone-state   PheromoneState
   :scoring-weight    ScoringWeight
   :routing-policy    RoutingPolicy
   :affinity-policy   AffinityPolicy})

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

(defn assert!
  "Throws on schema failure. Use at ingest boundaries."
  [entity-type record]
  (let [[status result] (validate entity-type record)]
    (if (= :ok status)
      record
      (throw (ex-info "Schema assertion failed"
                      {:entity-type entity-type
                       :errors      result
                       :input       record})))))

(defn coerce
  "Attempt to coerce record via malli default-value-transformer.
   Returns coerced record or nil on failure."
  [entity-type record]
  (let [schema (schema-for entity-type)]
    (try
      (let [coerced (m/coerce schema record (m/default-value-transformer))]
        (when (m/validate schema coerced) coerced))
      (catch :default _ nil))))
