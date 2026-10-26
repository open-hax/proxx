(ns proxx.runtime.routes.embeddings
  "POST /v1/embeddings. Sequences the host collaborators (routing pipeline, route
  filter, queue, fetch) around the decisions in proxx.http.embeddings.

  `c` is the collaborator bag the TS shim supplies: resolveModelRouting,
  hasModelPrefix-free helpers, getDeclaredProviderRoutes, filterDeclaredProviderRoutes,
  isOpenAiCompatEmbedProvider, normalizeLlamacppModelName, stripModelPrefix,
  ensureNativeOllamaEmbedContextFits, runCljsQueued, sendQueueError, joinUrl,
  fetchWithResponseTimeout, toErrorMessage, getActiveCljsRuntime,
  makeOpenAiHttpError, defaultTenantId."
  (:require [proxx.compat.ollama-native :as native]
            [proxx.http.embeddings :as emb]
            [proxx.http.proxy :as proxy]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

(defn- raise! [^js c {:keys [status message type code meta]} cause]
  (throw ((.-makeOpenAiHttpError c)
          #js {:statusCode status :message message :type type :code code
               :meta (when meta (clj->js meta)) :cause cause})))

(defn- js-record? [x] (and (some? x) (= "object" (js* "typeof ~{}" x))))

(defn- ^:async handle [^js deps ^js c {:keys [^js raw ^js reply]}]
  (let [body (.-body raw)
        ^js config (.-config deps)
        log (.-log raw)]
    (when-not (js-record? body) (raise! c emb/invalid-body nil))
    (let [model (let [m (aget body "model")] (if (string? m) m ""))
          _ (when-let [e (emb/auto-model-error model)] (raise! c e nil))
          llamacpp-prefixes (vec (or (interop/js->data (.-llamacppModelPrefixes config)) []))
          ollama-prefixes (vec (interop/js->data (.-ollamaModelPrefixes config)))
          {:keys [requested-provider-ids explicit-provider-id] :as hints}
          (emb/provider-hints model llamacpp-prefixes ollama-prefixes)
          tenant-id (let [t (some-> (.-openHaxAuth raw) (.-tenantId))] (or t (.-defaultTenantId c)))
          queue-tenant (let [t (some-> (.-openHaxAuth raw) (.-tenantId))] (or t "default"))
          proxy-settings (await (.getForTenant ^js (.-proxySettingsStore deps) tenant-id))
          modelRouting (await ((.-resolveModelRouting c)
                               #js {:config config :proxySettings proxy-settings
                                    :providerCatalogStore (.-providerCatalogStore deps)
                                    :requestLogStore (.-requestLogStore deps)}
                               body reply log))]
      (if-not modelRouting
        {:handled? true}
        (let [routed (emb/routed-model (.-routingModelInput ^js modelRouting) hints llamacpp-prefixes ollama-prefixes
                                       #((.-stripModelPrefix c) %1 (clj->js %2)))
              manifest (.-cljsPolicyManifestPath config)
              runtime ((.-getActiveCljsRuntime c))
              _ (when (and (true? (.-cljsPolicyAuthoritative config)) (not runtime))
                  (raise! c {:status 503 :message "CLJS policy runtime is required for embeddings routing."
                             :type "server_error" :code "cljs_policy_runtime_unavailable"
                             :meta {"requestedModel" model}} nil))
              declared ((.-getDeclaredProviderRoutes c) config)
              filter-input #js {:config config :modelId routed :requestKind "embeddings"
                                :tenantSettings proxy-settings :providerRoutes declared}
              _ (when requested-provider-ids (aset filter-input "requestedProviderIds" (clj->js requested-provider-ids)))
              ^js filtered ((.-filterDeclaredProviderRoutes c) manifest filter-input)
              policy-routes (.-providerRoutes filtered)
              selected (if explicit-provider-id
                         (.filter policy-routes (fn [^js r] (= explicit-provider-id (.-providerId r))))
                         policy-routes)]
          (when (zero? (.-length selected))
            (raise! c (emb/no-provider-error routed explicit-provider-id) nil))
          (let [queued (fn [candidate-id task]
                         ((.-runCljsQueued c) manifest
                                              #js {"tenant-id" queue-tenant "provider-id" candidate-id "request-kind" "embeddings"}
                                              task))
                forward-headers (fn [] (js/Headers. (clj->js (proxy/forward-headers (interop/js->data (.-headers raw))))))
                timeout (.-requestTimeoutMs config)]
            (loop [candidates (array-seq selected)]
              (if (empty? candidates)
                (raise! c (emb/exhausted-error model routed) nil)
                (let [^js candidate (first candidates)
                      candidate-id (.-providerId candidate)
                      ollama? (not ((.-isOpenAiCompatEmbedProvider c) candidate-id))
                      candidate-model (if ollama? routed ((.-normalizeLlamacppModelName c) routed))
                      with-model (doto (js/Object.assign #js {} body) (aset "model" candidate-model))
                      embed-body (native/native-embed->openai-request (interop/js->data with-model))
                      input (get embed-body "input")]
                  (when-let [e (emb/limits-error (emb/input-summary input)
                                                 (.-embedMaxBatchItems config) (.-embedMaxInputChars config))]
                    (raise! c e nil))
                  (let [budget (when ollama?
                                 (interop/js->data
                                  (await (queued candidate-id
                                                 (fn ^:async budget [^js controller]
                                                   (await ((.-ensureNativeOllamaEmbedContextFits c)
                                                           (.-ollamaBaseUrl config)
                                                           #js {:model candidate-model :input (clj->js input)}
                                                           (min timeout 30000) (.-signal controller)))))))) 
                        verdict (emb/context-verdict budget (.-embedMaxContextTokens config))
                        _ (when-let [e (:error verdict)] (raise! c e nil))
                        outcome
                        (try
                          (let [^js upstream
                                (if ollama?
                                  (let [upstream-body (native/native-embed->ollama-request
                                                       (interop/js->data with-model)
                                                       (or (:num-ctx verdict) (get budget "availableContextTokens")))]
                                    (await (queued candidate-id
                                                   (fn ^:async fetch-ollama [^js controller]
                                                     (await ((.-fetchWithResponseTimeout c)
                                                             ((.-joinUrl c) (.-ollamaBaseUrl config) "/api/embed")
                                                             #js {:method "POST" :headers (forward-headers)
                                                                  :body (js/JSON.stringify (clj->js upstream-body))
                                                                  :signal (.-signal controller)}
                                                             timeout))))))
                                  (let [base-url (or (aget (.-upstreamProviderBaseUrls config) candidate-id)
                                                     (.-baseUrl candidate) "")]
                                    (if (empty? base-url)
                                      ::no-base-url
                                      (await (queued candidate-id
                                                     (fn ^:async fetch-compat [^js controller]
                                                       (await ((.-fetchWithResponseTimeout c)
                                                               ((.-joinUrl c) base-url "/v1/embeddings")
                                                               #js {:method "POST" :headers (forward-headers)
                                                                    :body (js/JSON.stringify
                                                                           (js/Object.assign #js {} (clj->js embed-body) #js {:model candidate-model}))
                                                                    :signal (.-signal controller)}
                                                               timeout))))))))]
                            (if (= ::no-base-url upstream)
                              (do (.warn log #js {:providerId candidate-id} "no base URL for provider, skipping")
                                  :next)
                              upstream))
                          (catch :default error
                            (if ((.-sendQueueError c) reply error)
                              :handled
                              (do (.warn log #js {:providerId candidate-id :err ((.-toErrorMessage c) error)}
                                         "embedding provider fetch failed, will try next")
                                  :next))))]
                    (cond
                      (= :handled outcome) {:handled? true}
                      (= :next outcome) (recur (rest candidates))
                      :else
                      (let [^js upstream outcome]
                        (if-not (.-ok upstream)
                          (let [text (await (.text upstream))
                                v (emb/upstream-failure candidate-id (.-status upstream) text)]
                            (if (= :next-provider v)
                              (do (.warn log #js {:providerId candidate-id :status (.-status upstream)
                                                  :response (.slice text 0 200)}
                                         "embedding provider 5xx, will try next")
                                  (recur (rest candidates)))
                              (raise! c (:error v) nil)))
                          (let [json (await (.json upstream))]
                            {:body (if ollama?
                                     (do (when (nil? json)
                                           (throw (js/TypeError. "Cannot read properties of null (reading 'embeddings')")))
                                         (clj->js (native/native-embed-response->openai-embeddings
                                                   (interop/js->data json) (get embed-body "model"))))
                                     (js/Object.assign #js {} json #js {:model (get embed-body "model")}))}))))))))))))))

(defn register-embeddings-routes-js [app ^js deps ^js collaborators]
  (ring/register! app [{:method :post :path "/v1/embeddings" :opaque-body? true
                        :handler (fn [req] (handle deps collaborators req))}]))
