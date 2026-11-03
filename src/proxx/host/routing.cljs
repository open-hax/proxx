(ns proxx.host.routing
  "Request routing glue for the host (formerly src/lib/model-routing-pipeline.ts,
  catalog-alias-resolver.ts, routing-outcome-handler.ts, provider-strategy/{registry,
  contexts}.ts and the manifest-binding wrappers around the policy kernels).

  The decisions are the kernels in `proxx.runtime.routing`, `proxx.runtime.strategy`
  and friends; what remains here is sequencing: ask a store, call a kernel, answer the
  Fastify reply. Every function keeps the JS calling convention of the collaborator
  bundles the route handlers read (`proxx.host.routes`)."
  (:require [proxx.policy.manifest-path :refer [policy-manifest-path]]
            [proxx.runtime :as runtime]
            [proxx.runtime.attempt-executor :as attempt]
            [proxx.runtime.auto-model :as auto-model]
            [proxx.runtime.ollama-context :as ollama-context]
            [proxx.runtime.pricing :as pricing]
            [proxx.runtime.provider-routes :as provider-routes]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.requesty :as requesty]
            [proxx.runtime.routing :as routing]
            [proxx.runtime.strategies :as strategies]
            [proxx.runtime.strategy :as strategy]
            [proxx.runtime.strategy-routes :as strategy-routes]))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn error-message
  "`error.message` of an Error, else the string form (src/lib/errors `toErrorMessage`)."
  [e]
  (if (instance? js/Error e) (.-message e) (js/String e)))

(defn model-pricing [provider-id model]
  (pricing/get-model-pricing-js (policy-manifest-path) provider-id model))

(def ^:private water-ml-per-kwh
  (js/Number (or (aget js/process.env "DC_WATER_USE_EFFICIENCY_ML_PER_KWH") "1800")))

(defn estimate-request-cost [provider-id model prompt-tokens completion-tokens]
  (pricing/estimate-request-cost-js (policy-manifest-path) provider-id model prompt-tokens completion-tokens
                                    water-ml-per-kwh))

;; ---------------------------------------------------------------------------
;; The policy runtime handle (what `getActiveCljsRuntime()` was)
;; ---------------------------------------------------------------------------

(def policy-runtime
  "The policy kernels the route handlers consult by name."
  #js {"previewPolicyDecision" runtime/preview-policy-decision-js
       "resolveAutoModelCandidates" runtime/resolve-auto-model-candidates-js
       "runQueued" runtime/run-queued-js})

(defn run-queued
  "Run `task` (a fn of an AbortController) under the queue policy for `queue-context`; without a
  manifest it simply runs."
  [manifest-path queue-context task]
  (if (seq manifest-path)
    (runtime/run-queued-js manifest-path queue-context task)
    (task (js/AbortController.))))

(defn copy-injected-response-headers
  "Copy the headers of an in-process injected response onto `reply` (not content-length)."
  [^js reply ^js headers]
  (doseq [k (js/Object.keys headers)]
    (let [v (aget headers k)]
      (when-not (or (undefined? v) (= "content-length" (.toLowerCase k)))
        (.header reply k v)))))

;; ---------------------------------------------------------------------------
;; Provider routes
;; ---------------------------------------------------------------------------

(defn declared-provider-routes [config-or-manifest-path]
  (provider-routes/get-declared-provider-routes-js (policy-manifest-path) config-or-manifest-path))

(defn ollama-catalog-routes [config]
  (routing/build-ollama-catalog-routes-js (policy-manifest-path) config))

(defn filter-responses-api-routes [route-list openai-provider-id]
  (routing/filter-responses-api-routes-js (policy-manifest-path) route-list openai-provider-id))

(defn filter-images-api-routes [route-list openai-provider-id]
  (routing/filter-images-api-routes-js (policy-manifest-path) route-list openai-provider-id))

;; ---------------------------------------------------------------------------
;; Ollama context budgets
;; ---------------------------------------------------------------------------

(defn- context-fit [kind]
  (fn [base-url request-body timeout-ms signal]
    (.then (js/Promise.resolve (ollama-context/ensure-ollama-context-fits-js
                                (policy-manifest-path) kind base-url request-body timeout-ms signal))
           (fn [budget] (if (nil? budget) nil budget)))))

(def ensure-ollama-context-fits (context-fit "chat"))
(def ensure-native-ollama-embed-context-fits (context-fit "embed"))

;; ---------------------------------------------------------------------------
;; Strategy selection
;; ---------------------------------------------------------------------------

(defn- manifest-of [^js context] (.-cljsPolicyManifestPath ^js (.-config context)))

(defn- resolve-auto-model [model request-body provider-id]
  (strategy-routes/resolve-auto-model-js
   model
   (fn [auto-model-id]
     (auto-model/select-auto-model-js (policy-manifest-path) auto-model-id request-body js/undefined provider-id
                                      js/undefined js/undefined model-pricing))))

(defn select-provider-strategy-for-context [^js context]
  (strategies/strategy-for-id-js
   (strategy/select-strategy-js (strategies/selection-facts-js context js/undefined) #js {} (manifest-of context))))

(defn select-remote-provider-strategy-for-route
  ([context provider-id] (select-remote-provider-strategy-for-route context provider-id js/undefined))
  ([^js context provider-id policy-preferred-mode]
   (let [^js scoped (js/Object.assign #js {} context)
         _ (aset scoped "routeProviderId" (.toLowerCase (.trim provider-id)))
         facts (strategies/selection-facts-js scoped js/undefined)]
     (strategies/strategy-for-id-js
      (strategy/select-remote-strategy-js facts provider-id (.-openaiProviderId ^js (.-config context))
                                          policy-preferred-mode (.-policyPreferredStrategyModeByProvider context)
                                          (manifest-of context))))))

(defn select-execution-strategy-for-provider-routes
  [context default-strategy provider-ids policy-preferred-mode]
  (let [provider-id (strategy/execution-provider-js provider-ids)]
    (if (undefined? provider-id)
      default-strategy
      (select-remote-provider-strategy-for-route context provider-id policy-preferred-mode))))

(defn select-provider-strategy
  "{strategy, context} for a request: its routing state, the auto model resolved, the strategy picked."
  [^js config client-headers ^js request-body requested-model-input routing-model-input request-auth ^js options]
  (let [^js routing-state (routing/resolve-request-routing-state-js (policy-manifest-path) config routing-model-input)
        surface (or (some-> options .-surface) "chat")
        routed-model (if (= "chat" surface)
                       (resolve-auto-model (.-routedModel routing-state) request-body (.-upstreamProviderId config))
                       (.-routedModel routing-state))
        facts (strategy/derive-strategy-context-facts-js
               #js {"surface" surface
                    "routing" routing-state
                    "requestBody" request-body
                    "hostedOpenAiFamily" (routing/looks-like-hosted-open-ai-family-js (policy-manifest-path) routed-model)
                    "config" config})
        ^js context (js/Object.assign #js {} facts
                                      #js {"config" config
                                           "clientHeaders" client-headers
                                           "requestBody" request-body
                                           "requestAuth" request-auth
                                           "requestedModelInput" requested-model-input
                                           "routingModelInput" routing-model-input
                                           "routedModel" routed-model
                                           "factoryPrefixed" (.-factoryPrefixed routing-state)})]
    #js {"strategy" (select-provider-strategy-for-context context) "context" context}))

(defn execute-provider-routing-plan
  [strategy reply request-log-store prompt-affinity-store pheromone-store key-pool provider-routes context payload
   prompt-cache-key refresh-expired-token health-store event-store quota-monitor queue-signal]
  (attempt/execute-provider-routing-plan-js
   strategy reply request-log-store prompt-affinity-store pheromone-store key-pool provider-routes context payload
   prompt-cache-key refresh-expired-token health-store event-store quota-monitor queue-signal
   #js {"selectRemoteStrategy" (fn [ctx provider-id] (select-remote-provider-strategy-for-route ctx provider-id))
        "estimateRequestCost" estimate-request-cost
        "requestyModelProvider" (fn [model] (requesty/requesty-model-provider-js (policy-manifest-path) model))}))

(defn execute-local-strategy [strategy reply request-log-store context payload queue-signal]
  (attempt/execute-local-strategy-js strategy reply request-log-store context payload queue-signal
                                     #js {"estimateRequestCost" estimate-request-cost}))

;; ---------------------------------------------------------------------------
;; Catalogue and alias resolution
;; ---------------------------------------------------------------------------

(defn ^:async resolve-catalog-and-alias
  "Resolve the model catalogue and any alias for `requested`. Resolves to
  {routingModelInput, resolvedModelCatalog, resolvedCatalogBundle, aliasApplied}, or null after
  answering `reply` with an error. A catalogue failure is logged and the model used as is."
  [^js catalog-store requested ^js reply ^js log ^js options]
  (let [routing-input (volatile! requested)
        catalog (volatile! nil)
        bundle (volatile! nil)
        alias-applied (volatile! false)
        answered (volatile! false)]
    (try
      (let [^js catalog-bundle (await (.getCatalog catalog-store))]
        (vreset! bundle catalog-bundle)
        (vreset! catalog (.-catalog catalog-bundle))
        (let [^js decision (routing/resolve-catalog-alias-js (policy-manifest-path) catalog-bundle requested
                                                             (some-> options .-preserveExplicitOllama))]
          (if (.-error decision)
            (let [^js e (.-error decision)]
              (proxy/send-open-ai-error-js reply (.-status e) (.-message e) (.-type e) (.-code e))
              (vreset! answered true))
            (do (vreset! routing-input (or (.-routingModelInput decision) requested))
                (vreset! alias-applied (true? (.-aliasApplied decision)))
                (when @alias-applied
                  (.header reply "x-open-hax-model-alias" (str requested "->" @routing-input)))))))
      (catch :default error
        (.warn log #js {"error" (error-message error)}
               "failed to resolve dynamic model aliases; using requested model as-is")))
    (if @answered
      nil
      #js {"routingModelInput" @routing-input "resolvedModelCatalog" @catalog
           "resolvedCatalogBundle" @bundle "aliasApplied" @alias-applied})))

;; ---------------------------------------------------------------------------
;; Model routing pipeline
;; ---------------------------------------------------------------------------

(defn- denies-model? [^js config tenant-settings model-id]
  (routing/tenant-denies-model-js
   (runtime/preview-policy-decision-js (or (.-cljsPolicyManifestPath config) default-manifest)
                                       #js {"modelId" model-id "requestKind" "chat"
                                            "tenantSettings" tenant-settings "providerIds" #js []})))

(defn- reply-error! [^js reply ^js e]
  (proxy/send-open-ai-error-js reply (.-status e) (.-message e) (.-type e) (.-code e)))

(defn- ranked-model-ids [routing-input request-body available provider-id request-log-store health-store]
  (map (fn [^js entry] (.-modelId entry))
       (array-seq (auto-model/rank-auto-models-js (policy-manifest-path) routing-input request-body available provider-id
                                                  request-log-store health-store model-pricing))))

(defn- candidate-models
  "The candidate model ids the routing source yields for the request."
  [source routing-input request-body ^js catalog concrete provider-id request-log-store health-store]
  (let [rank (fn [inner candidates]
               (to-array (ranked-model-ids inner request-body candidates provider-id request-log-store health-store)))]
    (case source
      "cephalon" (strategy-routes/cephalon-model-candidates-js routing-input concrete rank)
      "vision" (strategy-routes/vision-model-candidates-for-js
                routing-input (or concrete (some-> catalog .-modelIds) #js []))
      "auto" (to-array (ranked-model-ids routing-input request-body concrete provider-id request-log-store health-store))
      #js [routing-input])))

(defn ^:async resolve-model-routing
  "Validate the requested model, apply tenant policy, resolve alias and catalogue, and produce the
  candidate model ids. Resolves to {requestedModelInput, routingModelInput, resolvedModelCatalog,
  resolvedCatalogBundle, routingModelCandidates, isAutoModel} or null after answering `reply` with an error."
  [^js deps ^js request-body ^js reply ^js log ^js options]
  (let [^js checked (routing/check-requested-model-js request-body)]
    (if (or (.-error checked) (undefined? (.-model checked)))
      (do (reply-error! reply (or (.-error checked) (routing/tenant-denied-error-js ""))) nil)
      (let [requested (.-model checked)]
        (if (denies-model? (.-config deps) (.-proxySettings deps) requested)
          (do (reply-error! reply (routing/tenant-denied-error-js requested)) nil)
          (if-let [^js catalog-result (await (resolve-catalog-and-alias (.-providerCatalogStore deps) requested reply log
                                                                        #js {"preserveExplicitOllama"
                                                                             (some-> options .-preserveExplicitOllama)}))]
            (let [routing-input (.-routingModelInput catalog-result)
                  ^js resolved-catalog (.-resolvedModelCatalog catalog-result)
                  source (routing/routing-candidate-source-js
                          #js {"cephalon" (strategy/is-cephalon-auto-model-js routing-input)
                               "vision" (strategy/is-vision-auto-model-js routing-input)
                               "auto" (auto-model/is-auto-model-js routing-input)})
                  concrete (routing/resolvable-concrete-model-ids-js resolved-catalog)
                  produced (candidate-models source routing-input request-body resolved-catalog concrete
                                             (.-upstreamProviderId ^js (.-config deps)) (.-requestLogStore deps)
                                             (.-accountHealthStore deps))
                  ^js finished (routing/finish-model-routing-js requested source produced)]
              (if (or (.-error finished) (undefined? (.-candidates finished)))
                (do (reply-error! reply (or (.-error finished) (routing/tenant-denied-error-js requested))) nil)
                (do (when-not (undefined? (.-candidatesHeader finished))
                      (.header reply "x-open-hax-auto-model-candidates" (.-candidatesHeader finished)))
                    #js {"requestedModelInput" requested
                         "routingModelInput" routing-input
                         "resolvedModelCatalog" resolved-catalog
                         "resolvedCatalogBundle" (.-resolvedCatalogBundle catalog-result)
                         "routingModelCandidates" (.-candidates finished)
                         "isAutoModel" (true? (.-isAutoModel finished))})))
            nil))))))

;; ---------------------------------------------------------------------------
;; Routing outcome
;; ---------------------------------------------------------------------------

(defn ^:async handle-routing-outcome
  "Answer the client when no candidate served the request: classify what the attempts saw and send
  the matching OpenAI-shaped error. Always resolves true."
  [^js input]
  (let [^js execution (.-execution input)
        ^js reply (.-reply input)
        ^js log (.-log input)
        outcome (routing/classify-routing-outcome-js execution (.-availability input))
        retry-in-ms (if (routing/routing-outcome-needs-retry-hint-js outcome)
                      (await (routing/min-ms-until-any-provider-key-ready-js (.-keyPool input) (.-providerRoutes input)))
                      0)
        ^js summary (.-summary execution)
        ^js response (routing/routing-outcome-response-js
                      outcome
                      #js {"routedModel" (.-routedModel input) "logPrefix" (.-logPrefix input)
                           "lastUpstreamError" (.-lastUpstreamError summary) "sawRequestError" (.-sawRequestError summary)}
                      retry-in-ms)]
    (when-not (undefined? (.-retryAfterSeconds response))
      (.header reply "retry-after" (.-retryAfterSeconds response)))
    (when-let [^js entry (.-log response)]
      (let [fields #js {"providerRoutes" (.-providerRoutes input) "attempts" (.-attempts summary)
                        "upstreamMode" (.-strategyMode input)}]
        (if (= "error" (.-level entry))
          (do (aset fields "sawRequestError" (.-sawRequestError summary)) (.error log fields (.-message entry)))
          (.warn log fields (.-message entry)))))
    (proxy/send-open-ai-error-js reply (.-status response) (.-message response) (.-type response) (.-code response))
    true))
