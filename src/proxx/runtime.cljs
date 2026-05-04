(ns proxx.runtime
  (:require [proxx.policy :as policy]
            [proxx.policy.contracts :as policy-contracts]
            [proxx.policy.evidence :as policy-evidence]
            [proxx.policy.loader :as policy-loader]
            [proxx.policy.router :as router]
            [proxx.processor :as processor]
            [proxx.schema :as schema]
            [proxx.strategies.anthropic :as anthropic]
            [proxx.strategies.openai :as openai]))

(defn normalize-keys-js
  "Normalize JS object keys through the CLJS data-layer processor."
  [value]
  (clj->js (processor/normalize-keys (js->clj value :keywordize-keys true))))

(defn validate-entity-js
  "Validate a JS object against the CLJS/Malli entity registry.
   Object keys are normalized before validation. Returns a JS object
   shaped as {status, record|errors}."
  [entity-type value]
  (let [[status result] (schema/validate (keyword entity-type)
                                         (processor/normalize-keys
                                          (js->clj value :keywordize-keys true)))]
    (clj->js (if (= :ok status)
              {:status "ok" :record result}
              {:status "error" :errors result}))))

(defn- normalize-event-outcome [event]
  (update event :outcome #(if (string? %) (keyword %) %)))

(defn project-pheromone-js
  "Project and clamp pheromone score from JS event objects."
  [events opts]
  (processor/project-pheromone (mapv normalize-event-outcome
                                     (js->clj events :keywordize-keys true))
                               (js->clj (or opts #js {}) :keywordize-keys true)))

(defn route-policy-js [policies ctx]
  (policy/register-strategy! 'proxx.strategies.openai/chat-completions-passthrough
                             openai/chat-completions-passthrough)
  (policy/register-strategy! 'proxx.strategies.anthropic/messages-passthrough
                             anthropic/messages-passthrough)
  (let [trace (atom [])]
    (try
      (let [result (router/route-request! (js->clj policies :keywordize-keys true)
                                          (js->clj ctx :keywordize-keys true)
                                          trace)]
        (clj->js {:status "ok" :result result :trace @trace}))
      (catch :default e
        (clj->js {:status "error"
                  :error (.-message e)
                  :data (ex-data e)
                  :trace @trace})))))

(defn load-policy-evidence-js
  "Load models.dev and /v1/models provider snapshot evidence for policy context."
  [opts]
  (-> (policy-evidence/load-policy-evidence! (js->clj (or opts #js {}) :keywordize-keys true))
      (.then (fn [evidence]
               #js {"models-dev/provider-models" (clj->js (:models-dev/provider-models evidence))
                    "provider-model-snapshots" (clj->js (:provider-model-snapshots evidence))}))))

(defn load-model-pricing-overrides-js
  "Load declarative pricing override contracts from a policy manifest.

  Returns a JS array of objects shaped as:
    {modelPattern, providerPattern?, mode, inputPer1MTokens, outputPer1MTokens, cacheReadPer1MTokens, cacheWritePer1MTokens, source?, notes?}

  Commandment: pricing overrides are policy EDN only — do not add JSON or TypeScript pricing tables."
  [manifest-path]
  (let [contracts (policy-loader/load-policy-contracts! manifest-path)
        overrides (->> contracts
                       (filter #(= :model-pricing-override (:contract/kind %)))
                       (map (fn [contract]
                              {:contractId (str (:contract/id contract))
                               :modelPattern (:match/model-pattern contract)
                               :providerPattern (:match/provider-pattern contract)
                               :mode (or (:override/mode contract) :fallback-unpriced)
                               :inputPer1MTokens (:pricing/input-per-1m-tokens contract)
                               :outputPer1MTokens (:pricing/output-per-1m-tokens contract)
                               :reasoningPer1MTokens (:pricing/reasoning-per-1m-tokens contract)
                               :cacheReadPer1MTokens (:pricing/cache-read-per-1m-tokens contract)
                               :cacheWritePer1MTokens (:pricing/cache-write-per-1m-tokens contract)
                               :source (:override/source contract)
                               :notes (:override/notes contract)}))
                       vec)]
    (clj->js overrides)))

(defn load-provider-seed-specs-js
  "Load provider seed specs from :provider-seed contracts in the manifest.

  Returns a JS array of objects shaped as:
    {providerIdEnvNames: string[], providerIdFallback: string, keyEnvNames: string[]}

  This replaces hardcoded TypeScript env-provider spec arrays with declarative contract data."
  [manifest-path]
  (let [contracts (policy-loader/load-policy-contracts! manifest-path)
        idx (policy-contracts/index-contracts contracts)
        specs (policy-contracts/provider-seed-specs idx)]
    (clj->js specs)))

(defn preview-policy-decision-js
  "Load declarative policy contracts from manifest-path and return a pure decision preview."
  [manifest-path input]
  (try
    (let [contracts (policy-loader/load-policy-contracts! manifest-path)
          compiled (policy-contracts/compile-contracts contracts)
          decision (policy-contracts/preview-policy-decision
                    compiled
                    (js->clj input :keywordize-keys true))]
      (clj->js {:status "ok" :decision decision}))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(def exports
  #js {:normalizeKeys normalize-keys-js
       :validateEntity validate-entity-js
       :projectPheromone project-pheromone-js
       :routePolicy route-policy-js
       :loadPolicyEvidence load-policy-evidence-js
       :loadModelPricingOverrides load-model-pricing-overrides-js
       :loadProviderSeedSpecs load-provider-seed-specs-js
       :previewPolicyDecision preview-policy-decision-js})
