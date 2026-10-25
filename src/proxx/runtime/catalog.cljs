(ns proxx.runtime.catalog
  "JS edge for src/lib/provider-catalog.ts: the catalog store. It owns the cache,
  the per-route fetch (key-pool credentials, timeouts, aborts) and the JS shapes;
  what the catalog contains is proxx.routing.catalog/assemble-catalog and which
  endpoints are probed is the `:provider-surface-facts` contract.

  `deps` carries the TypeScript helpers the runtime cannot import:
    fetchWithResponseTimeout  (url, init, timeoutMs) => Promise<Response>
    joinUrl                   (baseUrl, path) => string"
  (:require [proxx.routing.catalog :as catalog]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.models :as models]
            [proxx.runtime.routing :as routing]
            [proxx.routing.surface :as surface]))

(def ^:private default-route-timeout-ms 15000)
(def ^:private fetch-timeout-cap-ms 45000)

(defn- route-timeout-ms
  "PROXY_PROVIDER_CATALOG_ROUTE_TIMEOUT_MS when it is a positive integer, else 15 s."
  []
  (let [raw (some-> (aget (.-env js/process) "PROXY_PROVIDER_CATALOG_ROUTE_TIMEOUT_MS") str .trim)]
    (if (seq raw)
      (let [n (js/Number.parseInt raw 10)]
        (if (and (js/Number.isFinite n) (pos? n)) n default-route-timeout-ms))
      default-route-timeout-ms)))

(defn- ttl-ms [key-reload-ms]
  (js/Math.max 5000 (js/Math.min 120000 (js/Math.trunc key-reload-ms))))

(defn- first-success
  "Call `(f x)` (a promise of a value or nil) on each x in turn; resolve with the first non-nil."
  [xs f]
  (letfn [(step [remaining]
            (if (empty? remaining)
              (js/Promise.resolve nil)
              (.then (f (first remaining)) (fn [v] (if (some? v) v (step (rest remaining)))))))]
    (step (seq xs))))

(defn- fetch-model-ids
  "Model ids from one catalog endpoint, or nil for any failure or an empty list."
  [^js deps ^js config url headers signal]
  (if (.-aborted signal)
    (js/Promise.resolve nil)
    (-> (js/Promise.resolve)
        (.then (fn [] ((.-fetchWithResponseTimeout deps) url #js {:method "GET" :headers headers :signal signal}
                       (js/Math.min (.-requestTimeoutMs config) fetch-timeout-cap-ms))))
        (.then (fn [^js response]
                 (if (.-ok response)
                   (-> (.json response)
                       (.then (fn [payload] (let [found (routing/parse-model-ids payload)] (when (seq found) found))))
                       (.catch (fn [_] nil)))
                   (-> (js/Promise.resolve (.arrayBuffer response)) (.catch (fn [_] nil)) (.then (fn [_] nil))))))
        (.catch (fn [_] nil)))))

(defn- fetch-provider-catalog [^js deps ^js config ^js key-pool ^js route paths signal facts]
  (let [provider-id (.-providerId route)
        base-url (.-baseUrl route)
        join (.-joinUrl deps)
        local? (catalog/local-ollama-route? base-url (.-ollamaBaseUrl config))
        unauthenticated (fn []
                          (first-success paths
                                         (fn [path]
                                           (let [headers (js/Headers. #js {:accept "application/json"})]
                                             (when (js* "!!~{}" (.-ollamaApiKey config))
                                               (.set headers "authorization" (str "Bearer " (.-ollamaApiKey config))))
                                             (fetch-model-ids deps config (join base-url path) headers signal)))))]
    (-> (js/Promise.resolve)
        (.then (fn [] (.getAllAccounts key-pool provider-id)))
        (.catch (fn [_] nil))
        (.then (fn [accounts]
                 (if (or (nil? accounts) (zero? (.-length accounts)))
                   (if local? (unauthenticated) (js/Promise.resolve nil))
                   (first-success (array-seq accounts)
                                  (fn [^js account]
                                    (first-success paths
                                                   (fn [path]
                                                     (fetch-model-ids deps config (join base-url path)
                                                                      #js {:authorization (str "Bearer " (.-token account))
                                                                           :accept "application/json"}
                                                                      signal)))))))))))

(defn- fetch-route-catalog
  "A route's model ids within the per-route timeout; [] on timeout or any failure."
  [deps config key-pool route paths timeout-ms facts]
  (let [controller (js/AbortController.)
        signal (.-signal controller)
        timer (js/setTimeout #(.abort controller) timeout-ms)
        aborted (js/Promise. (fn [resolve _] (.addEventListener signal "abort" (fn [] (resolve nil)) #js {:once true})))]
    (-> (js/Promise.race #js [(fetch-provider-catalog deps config key-pool route paths signal facts) aborted])
        (.then (fn [found] (or found [])))
        (.catch (fn [_] []))
        (.finally (fn [] (js/clearTimeout timer))))))

(defn- sequential
  "Run `(f x)` (a promise) for each x one after another; resolve with the vector of results."
  [xs f]
  (reduce (fn [acc x] (.then acc (fn [results] (.then (f x) (fn [r] (conj results r))))))
          (js/Promise.resolve [])
          xs))

(defn- entries->js [entries]
  (let [o #js {}] (doseq [[k v] entries] (aset o k v)) o))

(defn- provider-catalog->js [{:keys [provider-id model-ids fetched-at stale source-endpoints]}]
  #js {:providerId provider-id :modelIds (to-array model-ids) :fetchedAt fetched-at :stale stale
       :sourceEndpoints (to-array source-endpoints)})

(defn- resolved->js [{:keys [model-ids alias-targets dynamic-ollama-model-ids declared-model-ids provider-catalogs preferences]}]
  #js {:catalog #js {:modelIds (to-array model-ids)
                     :aliasTargets (entries->js alias-targets)
                     :dynamicOllamaModelIds (to-array dynamic-ollama-model-ids)
                     :declaredModelIds (to-array declared-model-ids)}
       :providerCatalogs (entries->js (map (fn [[k v]] [k (provider-catalog->js v)]) provider-catalogs))
       :preferences #js {:preferred (to-array (:preferred preferences))
                         :disabled (to-array (:disabled preferences))
                         :aliases (entries->js (:aliases preferences))}})

(defn- load-sources
  "Promise of {:preferences :declared}: the model preferences (aliases as ordered entries) and declared models."
  [^js config]
  (.then (js/Promise.all #js [(models/load-model-preferences-js (.-modelsFilePath config) #js [])
                              (models/load-declared-models-js (.-modelsFilePath config))])
         (fn [loaded]
           (let [^js prefs (aget loaded 0)]
             {:declared (js->clj (aget loaded 1))
              :preferences {:preferred (js->clj (.-preferred prefs))
                            :disabled (js->clj (.-disabled prefs))
                            :aliases (interop/js->data (js/Object.entries (.-aliases prefs)))}}))))

(defn- probe-routes
  "Promise of [{:provider-id :model-ids ...}] probing each route in turn. `paths-for` gives a
  route's endpoints; `extra` adds the fields (source endpoints) the result carries."
  [route-list probe paths-for]
  (sequential (array-seq route-list)
              (fn [^js route]
                (let [paths (paths-for route)]
                  (.then (probe route paths)
                         (fn [found] {:provider-id (.-providerId route) :model-ids found
                                      :source-endpoints paths :fetched-at (js/Date.now)}))))))

(defn create-provider-catalog-store-js
  "The catalog store for a config, key pool and the routes to probe. Returns an object
  with `getCatalog(forceRefresh?)` and `isModelAvailable(providerId, modelId)`."
  [manifest-path ^js config ^js key-pool ^js route-list ^js ollama-route-list ^js deps]
  (let [facts (routing/surface-facts manifest-path)
        ttl (ttl-ms (.-keyReloadMs config))
        timeout-ms (route-timeout-ms)
        cache (atom nil)
        probe (fn [route paths] (fetch-route-catalog deps config key-pool route paths timeout-ms facts))
        catalog-config {:openai-provider-id (.-openaiProviderId config)
                        :openai-base-url (.-openaiBaseUrl config)
                        :openai-responses-path (.-openaiResponsesPath config)
                        :openai-chat-completions-path (.-openaiChatCompletionsPath config)}
        ollama-route-ids (mapv #(.-providerId ^js %) (array-seq ollama-route-list))
        build (fn [now]
                (-> (load-sources config)
                    (.then (fn [{:keys [preferences declared]}]
                             (-> (probe-routes route-list probe #(surface/catalog-paths facts catalog-config (.-providerId ^js %)))
                                 (.then (fn [route-results]
                                          (-> (probe-routes ollama-route-list probe (constantly (surface/ollama-catalog-paths facts)))
                                              (.then (fn [ollama-results]
                                                       (resolved->js
                                                        (catalog/assemble-catalog
                                                         facts {:preferences preferences :declared declared
                                                                :route-results route-results
                                                                :ollama-results (mapv #(dissoc % :source-endpoints) ollama-results)
                                                                :ollama-route-ids ollama-route-ids}))))))))))
                    (.then (fn [resolved]
                             (reset! cache {:expires-at (+ now ttl) :resolved resolved})
                             resolved))))
        get-catalog (fn [force-refresh]
                      (let [now (js/Date.now) cached @cache]
                        (if (and (not (js* "!!~{}" force-refresh)) cached (> (:expires-at cached) now))
                          (js/Promise.resolve (:resolved cached))
                          (build now))))]
    (clj->js
     {:getCatalog (fn [force-refresh] (get-catalog force-refresh))
      :isModelAvailable (fn [provider-id model-id]
                          (.then (get-catalog false)
                                 (fn [^js resolved]
                                   (let [^js entry (aget (.-providerCatalogs resolved) provider-id)]
                                     (if (js* "!!~{}" entry) (.includes (.-modelIds entry) model-id) false)))))})))
