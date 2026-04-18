(ns proxx.schema
  (:require [malli.core :as m]
            [malli.registry :as mr]
            [clojure.string :as str]))

;; Primitive aliases

(def ProviderId :string)
(def AccountId  :string)
(def ModelId    :string)
(def TenantId   :string)
(def PromptHash :string)

;; Provenance metadata attached to all ingested records

(def Provenance
  [:map
   [:source      [:enum :seed :rest :ws :redis :lmdb :postgres]]
   [:ingested-at :int]
   [:seed-hash   {:optional true} :string]
   [:request-id  {:optional true} :string]])

;; Core domain schemas

(def Provider
  [:map
   [:id           ProviderId]
   [:display-name :string]
   [:enabled      :boolean]
   [:meta         {:optional true} [:map-of :keyword :any]]])

(def ProviderEndpoint
  [:map
   [:provider-id ProviderId]
   [:endpoint    [:enum :completions :responses :anthropic :ollama]]
   [:path        :string]
   [:supported   :boolean]])

(def ProviderModel
  [:map
   [:provider-id    ProviderId]
   [:model-id       ModelId]
   [:context-tokens :int]
   [:streaming      :boolean]
   [:vision         :boolean]
   [:default-task   {:optional true} :string]
   [:meta           {:optional true} [:map-of :keyword :any]]])

(def PromptAffinityRecord
  [:map
   [:prompt-cache-key           PromptHash]
   [:provider-id                ProviderId]
   [:account-id                 AccountId]
   [:provisional-provider-id    {:optional true} ProviderId]
   [:provisional-account-id     {:optional true} AccountId]
   [:provisional-success-count  {:optional true} :int]
   [:updated-at                 :int]])

(def PheromoneState
  [:map
   [:provider-id  ProviderId]
   [:model-id     ModelId]
   [:score        :double]
   [:last-event-at :int]])

(def ScoringWeight
  [:map
   [:profile-id :string]
   [:metric-key :string]
   [:weight     :double]
   [:transform  [:enum :linear :invert :normalize]]])

(def RoutingPolicy
  [:map
   [:id              :string]
   [:scoring-profile :string]
   [:sampler         [:enum :softmax :greedy :weighted-random :round-robin]]
   [:sampler-params  {:optional true} [:map-of :keyword :any]]
   [:max-attempts    :int]
   [:fallback-policy {:optional true} :string]])

(def AffinityPolicy
  [:map
   [:tenant-id                        {:optional true} TenantId]
   [:provisional-promotion-threshold  :int]
   [:affinity-ttl-seconds             {:optional true} :int]
   [:enabled                          :boolean]])

(def registry
  {:provider          Provider
   :provider-endpoint ProviderEndpoint
   :provider-model    ProviderModel
   :prompt-affinity   PromptAffinityRecord
   :pheromone-state   PheromoneState
   :scoring-weight    ScoringWeight
   :routing-policy    RoutingPolicy
   :affinity-policy   AffinityPolicy
   :provenance        Provenance})
