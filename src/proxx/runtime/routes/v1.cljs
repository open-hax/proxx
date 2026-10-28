(ns proxx.runtime.routes.v1
  "The /v1 inference routes: POST /v1/images/generations, /v1/chat/completions and
  /v1/responses. Handlers sequence the host collaborators (strategy selection,
  route filters, queue, upstream attempts, federation, bridge, the reply) around
  the decisions in proxx.http.v1.

  Request bodies stay opaque JS values (they are forwarded to strategies that
  read them with JS semantics); facts are read from them here.

  `c` is the collaborator bag the TS shim supplies; `deps` is the AppDeps object,
  read per request (its `bridgeRelay` is assigned after registration)."
  (:require [proxx.http.v1 :as v1]
            [proxx.jsval :as jv]
            [proxx.runtime.federation-routing :as fed-routing]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

;; ---------------------------------------------------------------------------
;; Shared edge helpers
;; ---------------------------------------------------------------------------

(defn- raise!
  ([^js c e] (raise! c e nil))
  ([^js c {:keys [status message type code meta]} cause]
   (throw ((.-makeOpenAiHttpError c)
           #js {:statusCode status :message message :type type :code code
                :meta (when meta (clj->js meta)) :cause cause}))))

(defn- js-record? [x] (and (some? x) (= "object" (js* "typeof ~{}" x))))

(defn- or-undef [x] (if (nil? x) js/undefined x))

(defn- tenant-id [^js raw default]
  (or (some-> (.-openHaxAuth raw) (.-tenantId)) default))

(defn- queued
  "Run `task` (a fn of the abort controller) under the request queue for the
  provider/kind."
  [^js c ^js deps ^js raw provider-id request-kind task]
  ((.-runCljsQueued c) (.-cljsPolicyManifestPath ^js (.-config deps))
                       #js {"tenant-id" (tenant-id raw "default")
                            "provider-id" (or-undef provider-id)
                            "request-kind" request-kind}
                       task))

(defn- provider-ids [routes] (mapv #(.-providerId ^js %) (array-seq routes)))

(defn- unique-provider-ids [routes] (vec (distinct (provider-ids routes))))

(defn- ^:async ensure-fresh! [^js deps routes]
  (doseq [id (unique-provider-ids routes)]
    (await ((.-ensureFreshAccounts deps) id))))

(defn- auth-or-undef [^js raw] (or-undef (.-openHaxAuth raw)))

(defn- ^:async execute-plan
  "executeProviderRoutingPlan under the queue. Returns the execution, or
  ::handled when the queue answered the client."
  [^js c ^js deps ^js raw ^js reply request-kind strategy routes context payload prompt-cache-key]
  (try
    (await (queued c deps raw (first (provider-ids routes)) request-kind
                   (fn ^:async plan [^js controller]
                     (await ((.-executeProviderRoutingPlan c)
                             strategy reply (.-requestLogStore deps) (.-promptAffinityStore deps)
                             (.-providerRoutePheromoneStore deps) (.-keyPool deps) routes context payload
                             (or-undef prompt-cache-key) (.-refreshExpiredOAuthAccount deps)
                             (.-accountHealthStore deps) (.-eventStore deps) (.-quotaMonitor deps)
                             (.-signal controller))))))
    (catch :default error
      (if ((.-sendQueueError c) reply error) ::handled (throw error)))))

(defn- ^:async federated
  [^js c ^js deps ^js raw ^js reply request-kind routes ^js context upstream-path body]
  (await (queued c deps raw (first (provider-ids routes)) request-kind
                 (fn ^:async federate [^js controller]
                   (await ((.-executeFederatedRequestRouting deps)
                           #js {:requestHeaders (.-headers raw) :requestBody body
                                :requestAuth (auth-or-undef raw) :requestKind request-kind
                                :providerRoutes routes :upstreamPath upstream-path :reply reply
                                :timeoutMs (.-upstreamAttemptTimeoutMs context) :signal (.-signal controller)}))))))

(defn- ^:async bridged
  [^js c ^js deps ^js raw ^js reply request-kind routes ^js context upstream-path body]
  (await (queued c deps raw (first (provider-ids routes)) request-kind
                 (fn ^:async bridge []
                   (await (fed-routing/execute-bridge-request-routing
                           #js {:bridgeRelay (.-bridgeRelay deps) :app (.-app deps) :config (.-config deps)
                                :sqlTenantProviderPolicyStore (.-sqlTenantProviderPolicyStore deps)
                                :runtimeCredentialStore (.-runtimeCredentialStore deps) :keyPool (.-keyPool deps)}
                           #js {:requestHeaders (.-headers raw) :requestBody body
                                :requestAuth (auth-or-undef raw) :requestKind request-kind
                                :allowedProviderIds (to-array (provider-ids routes))
                                :upstreamPath upstream-path :reply reply
                                :timeoutMs (.-upstreamAttemptTimeoutMs context)}))))))

(defn- apply-policy-context
  "A copy of the strategy context with the policy decision's strategy modes."
  [^js context ^js policy-result]
  (let [overrides (v1/policy-context-overrides
                   {:strategy-mode (.-strategyMode policy-result)
                    :strategy-mode-by-provider (.-strategyModeByProvider policy-result)})
        out (js/Object.assign #js {} context)]
    (doseq [[k v] overrides] (aset out k v))
    out))

(defn- context-model
  "The model the policy filters see: `routedModel || requestedModelInput`."
  [^js context]
  (let [routed (.-routedModel context)]
    (if (and (string? routed) (seq routed)) routed (.-requestedModelInput context))))

(defn- filter-routes [^js c ^js deps request-kind model proxy-settings routes extra]
  (let [^js config (.-config deps)
        input (js/Object.assign #js {:config config :modelId model :requestKind request-kind
                                     :tenantSettings proxy-settings :providerRoutes routes}
                                extra)]
    ((.-filterDeclaredProviderRoutes c) (.-cljsPolicyManifestPath config) input)))

(defn- routes-for-ids
  "The `routes` (JS array of route objects) ordered by `prioritize-openai-route`."
  [routes openai-prefixed? openai-provider-id]
  (if-not openai-prefixed?
    (.slice routes)
    (let [rank (fn [^js r] (if (= openai-provider-id (.-providerId r)) 0 1))]
      (.sort (.slice routes) (fn [a b] (- (rank a) (rank b)))))))

;; ---------------------------------------------------------------------------
;; POST /v1/images/generations
;; ---------------------------------------------------------------------------

(defn- ^:async images-handler [^js c ^js deps {:keys [^js raw ^js reply]}]
  (let [body (.-body raw)]
    (when-not (js-record? body) (raise! c v1/invalid-body))
    (let [^js config (.-config deps)
          settings (await (.getForTenant ^js (.-proxySettingsStore deps) (tenant-id raw (.-defaultTenantId c))))
          model (let [m (aget body "model")] (if (string? m) m ""))]
      (when (empty? model) (raise! c v1/missing-model))
      (let [^js selected ((.-selectProviderStrategy c) config (.-headers raw) body model model (auth-or-undef raw)
                          #js {:surface "images-passthrough"})
            ^js strategy (.-strategy selected)
            ^js context (.-context selected)]
        (.header reply "x-open-hax-upstream-mode" (.-mode strategy))
        (let [payload (try (.buildPayload strategy context)
                           (catch :default error
                             (raise! c (v1/invalid-provider-options ((.-toErrorMessage c) error) {"requestedModel" model}) error)))
              declared ((.-filterImagesApiRoutes c) ((.-getDeclaredProviderRoutes c) config) (.-openaiProviderId config))
              ^js filtered (filter-routes c deps "images" (context-model context) settings declared nil)
              routes (.-providerRoutes filtered)]
          (when (zero? (.-length routes)) (raise! c (v1/provider-not-allowed (.-routedModel context))))
          (await (ensure-fresh! deps routes))
          (let [availability (await ((.-inspectProviderAvailability c) (.-keyPool deps) routes))
                execution (await (execute-plan c deps raw reply "images" strategy routes context payload nil))]
            (cond
              (= ::handled execution) {:handled? true}
              (.-handled ^js execution) {:handled? true}
              (await (federated c deps raw reply "images" routes context "/v1/images/generations" body)) {:handled? true}
              (await ((.-handleRoutingOutcome c)
                      #js {:keyPool (.-keyPool deps) :reply reply :execution execution :availability availability
                           :providerRoutes routes :strategyMode (.-mode strategy) :routedModel (.-routedModel context)
                           :log (.-log ^js (.-app deps)) :logPrefix "images"}))
              {:handled? true}
              :else (raise! c (v1/exhausted :images nil (.-routedModel context))))))))))

(defn register-images-routes-js [app ^js deps ^js c]
  (ring/register! app [{:method :post :path "/v1/images/generations" :opaque-body? true
                        :handler (fn [req] (images-handler c deps req))}]))

;; ---------------------------------------------------------------------------
;; POST /v1/chat/completions
;; ---------------------------------------------------------------------------

(defn- local-mode? [mode] (contains? #{"ollama_chat" "local_ollama_chat"} mode))

(defn- ^:async chat-candidate
  "One model candidate. Resolves {:status \"handled\"} or {:status \"continue\"};
  throws a typed OpenAI error when the request cannot be served."
  [^js c ^js deps ^js raw ^js reply {:keys [proxy-settings body requested candidate has-more?]}]
  (let [^js config (.-config deps)
        ^js log (.-log raw)
        continue {:status "continue"} handled {:status "handled"}
        ^js selected ((.-selectProviderStrategy c) config (.-headers raw) body requested candidate (auth-or-undef raw))
        ^js strategy (.-strategy selected)
        ^js context (.-context selected)
        _ (.header reply "x-open-hax-upstream-mode" (.-mode strategy))
        declared ((.-getDeclaredProviderRoutes c) config)
        only (v1/initial-provider-filter {:factory-prefixed (.-factoryPrefixed context)
                                          :explicit-ollama (.-explicitOllama context)})
        initial (if only (.filter declared (fn [^js r] (= only (.-providerId r)))) declared)
        ^js policy (filter-routes c deps "chat" (context-model context) proxy-settings initial nil)
        routes (volatile! (routes-for-ids (.-providerRoutes policy) (.-openAiPrefixed context) (.-openaiProviderId config)))
        exec-context (volatile! (apply-policy-context context policy))
        select-strategy (fn [] ((.-selectExecutionStrategyForProviderRoutes c) @exec-context strategy
                                                                              (to-array (provider-ids @routes))))
        exec-strategy (volatile! (select-strategy))]
    (.header reply "x-open-hax-upstream-mode" (.-mode ^js @exec-strategy))
    (if (and (zero? (.-length @routes)) (not (.-isLocal ^js @exec-strategy)))
      (if has-more? continue (raise! c (v1/provider-not-allowed (.-routedModel context))))
      (let [gate (try
                   (let [^js catalog-result
                         (filter-routes c deps "chat" (context-model context) proxy-settings @routes
                                        #js {:catalogBundle (await (.getCatalog ^js (.-providerCatalogStore deps)))
                                             :catalogAvailability (not (.-isLocal ^js @exec-strategy))})]
                     (vreset! routes (routes-for-ids (.-providerRoutes catalog-result) (.-openAiPrefixed context)
                                                     (.-openaiProviderId config)))
                     (vreset! exec-context (apply-policy-context @exec-context catalog-result))
                     (vreset! exec-strategy (select-strategy))
                     (.header reply "x-open-hax-upstream-mode" (.-mode ^js @exec-strategy))
                     (let [^js catalog (.-catalog catalog-result)]
                       (v1/catalog-gate {:disabled? (boolean (some-> catalog (.-disabled)))
                                         :rejected? (boolean (some-> catalog (.-rejected)))
                                         :routes-empty? (zero? (.-length @routes))
                                         :local? (.-isLocal ^js @exec-strategy)
                                         :has-more? has-more? :check-routes? true
                                         :routed-model (.-routedModel context)})))
                   (catch :default error
                     (if ((.-isOpenAiHttpError c) error)
                       (throw error)
                       (do (.warn log #js {:error ((.-toErrorMessage c) error)}
                                  "failed to verify provider model catalog; continuing without gating")
                           :ok))))]
        (cond
          (= :continue gate) continue
          (:error gate) (raise! c (:error gate))
          :else
          (let [^js strategy* @exec-strategy
                ^js context* @exec-context
                payload (try (.buildPayload strategy* context*)
                             (catch :default error
                               (if has-more? ::continue
                                   (raise! c (v1/invalid-provider-options ((.-toErrorMessage c) error)
                                                                          {"routedModel" (.-routedModel context)})))))]
            (if (= ::continue payload)
              continue
              (let [overflow
                    (when (local-mode? (.-mode strategy*))
                      (let [upstream-payload (.-upstreamPayload ^js payload)]
                        (when (and (js-record? upstream-payload)
                                   (not ((.-requestHasExplicitNumCtx c) body)))
                          (let [budget (await (queued c deps raw (or (first (provider-ids @routes)) "ollama") "chat"
                                                      (fn ^:async budget [^js controller]
                                                        (await ((.-ensureOllamaContextFits c) (.-ollamaBaseUrl config)
                                                                upstream-payload (min (.-requestTimeoutMs config) 30000)
                                                                (.-signal controller))))))
                                data (interop/js->data budget)]
                            (when (v1/context-exceeded? data)
                              (if has-more? :continue (v1/ollama-context-overflow data (.-routedModel context))))))))]
                (cond
                  (= :continue overflow) continue
                  overflow (raise! c overflow)
                  (.-isLocal strategy*)
                  (try (await (queued c deps raw "ollama" "chat"
                                      (fn ^:async local [^js controller]
                                        (await ((.-executeLocalStrategy c) strategy* reply (.-requestLogStore deps)
                                                                           context* payload (.-signal controller))))))
                       handled
                       (catch :default error
                         (if ((.-sendQueueError c) reply error) handled (throw error))))
                  :else
                  (let [rs @routes]
                    (await (ensure-fresh! deps rs))
                    (let [availability (await ((.-inspectProviderAvailability c) (.-keyPool deps) rs))
                          execution (await (execute-plan c deps raw reply "chat" strategy* rs context* payload
                                                         ((.-extractPromptCacheKey c) body)))]
                      (cond
                        (= ::handled execution) handled
                        (.-handled ^js execution) handled
                        (await (federated c deps raw reply "chat" rs context "/v1/chat/completions" body)) handled
                        (await (bridged c deps raw reply "chat" rs context "/v1/chat/completions" body)) handled
                        has-more? continue
                        :else
                        (if (await ((.-handleRoutingOutcome c)
                                    #js {:keyPool (.-keyPool deps) :reply reply :execution execution
                                         :availability availability :providerRoutes rs
                                         :strategyMode (.-mode strategy*) :routedModel (.-routedModel context)
                                         :log (.-log ^js (.-app deps))}))
                          handled
                          continue)))))))))))))

(defn- ^:async chat-handler [^js c ^js deps {:keys [^js raw ^js reply]}]
  (let [body (.-body raw)]
    (when-not (js-record? body) (raise! c v1/invalid-body))
    (let [^js config (.-config deps)
          settings (await (.getForTenant ^js (.-proxySettingsStore deps) (tenant-id raw "default")))
          fast? (jv/truthy? (.-fastMode ^js settings))
          request-body (if fast?
                         (js/Object.assign
                          #js {:open_hax (js/Object.assign #js {:fast_mode true}
                                                           (when (js-record? (aget body "open_hax")) (aget body "open_hax")))}
                          body)
                         body)]
      (when fast? (.header reply "x-open-hax-fast-mode" "priority"))
      (let [^js routing (await ((.-resolveModelRouting c)
                                #js {:config config :proxySettings settings
                                     :providerCatalogStore (.-providerCatalogStore deps)
                                     :requestLogStore (.-requestLogStore deps)
                                     :accountHealthStore (.-accountHealthStore deps)}
                                request-body reply (.-log raw) #js {:preserveExplicitOllama true}))]
        (if-not routing
          {:handled? true}
          (let [candidates (vec (array-seq (.-routingModelCandidates routing)))
                requested (.-requestedModelInput routing)
                total (count candidates)]
            (loop [i 0]
              (if (>= i total)
                (raise! c (v1/exhausted :chat requested nil))
                (let [result (await (chat-candidate c deps raw reply
                                                    {:proxy-settings settings :body request-body :requested requested
                                                     :candidate (nth candidates i) :has-more? (< i (dec total))}))]
                  (if (= "continue" (:status result))
                    (recur (inc i))
                    {:handled? true}))))))))))

(defn register-chat-routes-js [app ^js deps ^js c]
  (ring/register! app [{:method :post :path "/v1/chat/completions" :opaque-body? true
                        :handler (fn [req] (chat-handler c deps req))}]))

;; ---------------------------------------------------------------------------
;; POST /v1/responses
;; ---------------------------------------------------------------------------

(defn- ^:async ollama-responses-compat
  "A responses request for an explicit ollama model: bridge through the native
  chat-completions route and translate back."
  [^js c ^js deps ^js raw ^js reply body requested-model]
  (let [^js bridge-payload (js/Object.assign #js {} ((.-responsesRequestToChatRequest c) body) #js {:stream false})
        ^js bridged-res (await ((.-injectNativeBridge deps) "/v1/chat/completions" bridge-payload (.-headers raw)))]
    ((.-copyInjectedResponseHeaders c) reply (.-headers bridged-res))
    (if (>= (.-statusCode bridged-res) 400)
      (do (.code reply (.-statusCode bridged-res))
          (.send reply (or (.-body bridged-res) ""))
          {:handled? true})
      (let [parsed (try (js/JSON.parse (let [b (.-body bridged-res)] (if (nil? b) "null" b)))
                        (catch :default error
                          (raise! c (v1/translation-failed "Failed to parse proxied Ollama chat completion response"
                                                           {"requestedModel" requested-model}) error)))]
        (when-not (and (js-record? parsed) (js/Array.isArray (aget parsed "choices")))
          (raise! c (v1/translation-failed "Invalid proxied Ollama chat completion response"
                                           {"requestedModel" requested-model})))
        (if (true? (aget body "stream"))
          (let [stream (try ((.-chatCompletionEventStreamToResponsesEventStream c)
                             ((.-chatCompletionToSse c) parsed) requested-model)
                            (catch :default error
                              (raise! c (v1/stream-translation-failed ((.-toErrorMessage c) error)
                                                                      {"requestedModel" requested-model}) error)))]
            (.code reply 200)
            (.header reply "content-type" "text/event-stream; charset=utf-8")
            (.header reply "cache-control" "no-cache")
            (.header reply "x-accel-buffering" "no")
            (.send reply stream)
            {:handled? true})
          (do (.code reply 200)
              (.header reply "content-type" "application/json")
              (.send reply ((.-chatCompletionToResponsesResponse c) parsed))
              {:handled? true}))))))

(defn- ^:async responses-candidate
  [^js c ^js deps ^js raw ^js reply {:keys [settings body requested candidate has-more? prompt-cache-key]}]
  (let [^js config (.-config deps)
        ^js log (.-log raw)
        continue {:status "continue"} handled {:status "handled"}
        ^js selected ((.-selectProviderStrategy c) config (.-headers raw) body requested candidate (auth-or-undef raw)
                      #js {:surface "responses-passthrough"})
        ^js strategy (.-strategy selected)
        ^js context (.-context selected)
        _ (.header reply "x-open-hax-upstream-mode" (.-mode strategy))
        declared ((.-getDeclaredProviderRoutes c) config)
        base (if (.-factoryPrefixed context)
               (.filter declared (fn [^js r] (= "factory" (.-providerId r))))
               declared)
        responses-routes ((.-filterResponsesApiRoutes c) base (.-openaiProviderId config))
        ^js policy (filter-routes c deps "responses-passthrough" (context-model context) settings responses-routes nil)
        routes (volatile! (.-providerRoutes policy))
        exec-context (volatile! (apply-policy-context context policy))]
    (if (zero? (.-length @routes))
      (if has-more? continue (raise! c (v1/provider-not-allowed (.-routedModel context))))
      (let [gate (try
                   (let [^js catalog-result
                         (filter-routes c deps "responses-passthrough" (context-model context) settings @routes
                                        #js {:catalogBundle (await (.getCatalog ^js (.-providerCatalogStore deps)))})]
                     (vreset! routes (.-providerRoutes catalog-result))
                     (vreset! exec-context (apply-policy-context @exec-context catalog-result))
                     (let [^js catalog (.-catalog catalog-result)]
                       (v1/catalog-gate {:disabled? (boolean (some-> catalog (.-disabled)))
                                         :rejected? (boolean (some-> catalog (.-rejected)))
                                         :has-more? has-more? :check-routes? false
                                         :routed-model (.-routedModel context)})))
                   (catch :default error
                     (if ((.-isOpenAiHttpError c) error)
                       (throw error)
                       (do (.warn log #js {:error ((.-toErrorMessage c) error)}
                                  "failed to verify provider model catalog for /v1/responses; continuing without gating")
                           :ok))))]
        (cond
          (= :continue gate) continue
          (:error gate) (raise! c (:error gate))
          :else
          (let [^js context* @exec-context
                payload (try (.buildPayload strategy context*)
                             (catch :default error
                               (if has-more? ::continue
                                   (raise! c (v1/invalid-provider-options ((.-toErrorMessage c) error)
                                                                          {"routedModel" (.-routedModel context)})
                                           error))))]
            (if (= ::continue payload)
              continue
              (let [rs @routes]
                (await (ensure-fresh! deps rs))
                (let [^js availability (await ((.-inspectProviderAvailability c) (.-keyPool deps) rs prompt-cache-key))
                      execution (await (execute-plan c deps raw reply "responses" strategy rs context* payload
                                                     (.-prompt_cache_key availability)))]
                  (cond
                    (= ::handled execution) handled
                    (.-handled ^js execution) handled
                    (await (federated c deps raw reply "responses" rs context* "/v1/responses" body)) handled
                    (await (bridged c deps raw reply "responses" rs context* "/v1/responses" body)) handled
                    has-more? continue
                    (await ((.-handleRoutingOutcome c)
                            #js {:keyPool (.-keyPool deps) :reply reply :execution execution
                                 :availability availability :providerRoutes rs :strategyMode (.-mode strategy)
                                 :routedModel (.-routedModel context*) :log (.-log ^js (.-app deps))
                                 :logPrefix "responses passthrough"}))
                    handled
                    :else continue))))))))))

(defn- ^:async responses-handler [^js c ^js deps {:keys [^js raw ^js reply]}]
  (let [body (.-body raw)]
    (when-not (js-record? body) (raise! c v1/invalid-body))
    (let [^js config (.-config deps)
          settings (await (.getForTenant ^js (.-proxySettingsStore deps) (tenant-id raw "default")))
          prompt-cache-key ((.-extractPromptCacheKey c) body)
          ^js app-log (.-log ^js (.-app deps))
          _ (.info app-log #js {:responsesBody ((.-summarizeResponsesRequestBody c) body)
                                :hasPromptCacheKey (boolean prompt-cache-key)
                                :promptCacheKey (or-undef (when prompt-cache-key ((.-hashPromptCacheKey c) prompt-cache-key)))}
                   "responses passthrough: incoming body")
          requested (let [m (aget body "model")] (if (string? m) m ""))]
      (when (empty? requested) (raise! c v1/missing-model))
      (let [^js catalog-result (await ((.-resolveCatalogAndAlias c) (.-providerCatalogStore deps) requested reply (.-log raw)))]
        (if-not catalog-result
          {:handled? true}
          (let [routing-model (.-routingModelInput catalog-result)]
            (if (or (v1/explicit-ollama-model? requested) (v1/explicit-ollama-model? routing-model))
              (await (ollama-responses-compat c deps raw reply body
                                              (if (v1/explicit-ollama-model? routing-model) routing-model requested)))
              (let [auto? (v1/auto-model? routing-model)
                    auto-provider-ids
                    (when auto?
                      (provider-ids (.-providerRoutes ^js
                                     (filter-routes c deps "responses-passthrough" routing-model settings
                                                    ((.-filterResponsesApiRoutes c) ((.-getDeclaredProviderRoutes c) config)
                                                                                    (.-openaiProviderId config))
                                                    nil))))
                    concrete (if auto?
                               (vec (or (array-seq ((.-resolvableConcreteModelIdsForProviders c)
                                                    (.-resolvedCatalogBundle catalog-result) (to-array auto-provider-ids)
                                                    (fn [model-id] ((.-shouldUseResponsesUpstream c) model-id
                                                                                                    (.-responsesModelPrefixes config)))))
                                        []))
                               [])
                    auto-decision (when auto?
                                    (let [runtime ((.-getActiveCljsRuntime c))]
                                      (when (and runtime (.-resolveAutoModelCandidates ^js runtime))
                                        (interop/js->data
                                         ((.-resolveAutoModelCandidates ^js runtime)
                                          (or (.-cljsPolicyManifestPath config) "resources/policies/runtime/00-manifest.edn")
                                          #js {:modelId routing-model :requestBody body :availableModels (to-array concrete)})))))
                    candidates (v1/responses-candidates routing-model auto? auto-decision concrete)]
                (when (empty? candidates) (raise! c (v1/requested-model-not-found requested)))
                (when auto?
                  (.header reply "x-open-hax-auto-model-candidates" (v1/auto-candidates-header candidates)))
                (let [total (count candidates)]
                  (loop [i 0]
                    (if (>= i total)
                      (raise! c (v1/exhausted :responses requested nil))
                      (let [result (await (responses-candidate c deps raw reply
                                                               {:settings settings :body body :requested requested
                                                                :candidate (nth candidates i) :has-more? (< i (dec total))
                                                                :prompt-cache-key prompt-cache-key}))]
                        (if (= "continue" (:status result))
                          (recur (inc i))
                          {:handled? true})))))))))))))

(defn register-responses-routes-js [app ^js deps ^js c]
  (ring/register! app [{:method :post :path "/v1/responses" :opaque-body? true
                        :handler (fn [req] (responses-handler c deps req))}]))
