(ns proxx.runtime
  (:require [clojure.string]
            [proxx.policy :as policy]
            [proxx.policy.contracts :as policy-contracts]
            [proxx.policy.evidence :as policy-evidence]
            [proxx.policy.loader :as policy-loader]
            [proxx.policy.router :as router]
            [proxx.processor :as processor]
            [proxx.queue.policy :as queue-policy]
            [proxx.queue.runtime :as queue-runtime]
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

(defonce ^:private compiled-policy-cache (atom {}))

(defn- compiled-policy-for-manifest [manifest-path]
  (or (get @compiled-policy-cache manifest-path)
      (let [contracts (policy-loader/load-policy-contracts! manifest-path)
            compiled (policy-contracts/compile-contracts contracts)]
        (swap! compiled-policy-cache assoc manifest-path compiled)
        compiled)))

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
    (let [compiled (compiled-policy-for-manifest manifest-path)
          decision (policy-contracts/preview-policy-decision
                    compiled
                    (js->clj input :keywordize-keys true))]
      (clj->js {:status "ok" :decision decision}))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn normalize-reasoning-request-js
  "Load declarative policy contracts and normalize request reasoning controls for
  the selected model family before a TypeScript strategy builds its network payload."
  [manifest-path input]
  (try
    (let [compiled (compiled-policy-for-manifest manifest-path)
          decision (policy-contracts/normalize-reasoning-request
                    compiled
                    (js->clj input :keywordize-keys true))]
      (clj->js {:status "ok" :decision decision}))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn resolve-model-alias-js
  "Load declarative policy contracts and resolve a provider-specific model alias."
  [manifest-path model-id provider-id]
  (try
    (let [compiled (compiled-policy-for-manifest manifest-path)
          alias (policy-contracts/resolve-model-alias compiled model-id provider-id)]
      (clj->js {:status "ok" :alias alias}))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn get-provider-routes-js
  "Load all provider routes from :provider-route and :provider-seed contracts
   in the manifest. Returns a JS object with :status and :provider-routes array
   of {provider-id, base-url, paths?, auth-required?}."
  [manifest-path]
  (try
    (let [compiled (compiled-policy-for-manifest manifest-path)
          routes (:provider-routes compiled)]
      (clj->js {:status "ok" :provider-routes (vec routes)}))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn resolve-auto-model-candidates-js
  "Resolve concrete model candidates for an auto:* selector from policy inputs.

  Candidate discovery is supplied by the caller from catalog/policy evidence; the
  runtime boundary owns the auto selector decision so route handlers do not rank
  model candidates locally."
  [_manifest-path input]
  (try
    (let [m (js->clj (or input #js {}) :keywordize-keys true)
          model-id (clojure.string/lower-case (str (or (:model-id m) (:modelId m) "")))
          candidates (vec (or (:available-models m) (:availableModels m) []))]
      (clj->js (if (clojure.string/starts-with? model-id "auto:")
                {:status "ok" :candidates candidates}
                {:status "ok" :candidates [(or (:model-id m) (:modelId m))]})))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn filter-provider-routes-js
  "Apply provider route eligibility in CLJS policy space. TypeScript callers
  pass request context and route facts; CLJS owns model-support, tenant-provider,
  and optional provider-catalog availability decisions."
  [manifest-path input]
  (try
    (let [compiled (compiled-policy-for-manifest manifest-path)
          result (policy-contracts/filter-provider-routes
                  compiled
                  (js->clj (or input #js {}) :keywordize-keys true))]
      (clj->js (assoc result :status "ok")))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn run-model-candidates-js
  "Run model candidate attempts in CLJS so route handlers do not own the retry loop.

  execute-candidate is a JS async function of (candidate, hasMore, index). It
  returns a map/object whose :status is continue to try the next candidate;
  any other status terminates the loop and is returned to the caller."
  [_manifest-path input execute-candidate]
  (let [m (js->clj (or input #js {}) :keywordize-keys true)
        candidates (vec (or (:candidates m) (:model-candidates m) (:modelCandidates m) []))
        total (count candidates)]
    (letfn [(step [idx]
              (if (< idx total)
                (let [candidate (nth candidates idx)
                      has-more (< idx (dec total))]
                  (-> (js/Promise.resolve (execute-candidate candidate has-more idx))
                      (.then (fn [result]
                               (let [result-map (js->clj (or result #js {}) :keywordize-keys true)
                                     status (str (or (:status result-map) (:kind result-map) "handled"))]
                                 (if (= "continue" status)
                                   (step (inc idx))
                                   (clj->js (assoc result-map :status status))))))))
                (js/Promise.resolve #js {:status "exhausted"})))]
      (step 0))))

(defn resolve-queue-policy-js
  "Resolve the effective request queue policy for a request context."
  [manifest-path ctx]
  (try
    (let [compiled (compiled-policy-for-manifest manifest-path)
          queue-policy (queue-policy/resolve-queue-policy
                        compiled
                        (js->clj (or ctx #js {}) :keywordize-keys true))]
      (clj->js {:status "ok" :policy queue-policy}))
    (catch :default e
      (clj->js {:status "error"
                :error (.-message e)
                :data (ex-data e)}))))

(defn run-queued-js
  "Resolve queue policy from manifest/context and run a JS task through it.

  The JS task receives an AbortController. When no queue instance matches, the
  task is executed directly with a fresh controller."
  [manifest-path ctx task]
  (try
    (let [compiled (compiled-policy-for-manifest manifest-path)
          queue-policy (queue-policy/resolve-queue-policy
                        compiled
                        (js->clj (or ctx #js {}) :keywordize-keys true))]
      (if queue-policy
        (queue-runtime/run! task queue-policy)
        (task (js/AbortController.))))
    (catch :default e
      (js/Promise.reject e))))

(def exports
  #js {:normalizeKeys normalize-keys-js
       :validateEntity validate-entity-js
       :projectPheromone project-pheromone-js
       :routePolicy route-policy-js
       :loadPolicyEvidence load-policy-evidence-js
       :loadModelPricingOverrides load-model-pricing-overrides-js
       :loadProviderSeedSpecs load-provider-seed-specs-js
       :previewPolicyDecision preview-policy-decision-js
       :normalizeReasoningRequest normalize-reasoning-request-js
       :resolveModelAlias resolve-model-alias-js
       :getProviderRoutes get-provider-routes-js
       :resolveAutoModelCandidates resolve-auto-model-candidates-js
       :filterProviderRoutes filter-provider-routes-js
       :runModelCandidates run-model-candidates-js
       :resolveQueuePolicy resolve-queue-policy-js
       :runQueued run-queued-js})
