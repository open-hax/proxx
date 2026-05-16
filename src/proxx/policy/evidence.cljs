(ns proxx.policy.evidence
  (:require [clojure.string :as str]))

(def default-models-dev-url "https://models.dev/api.json")
(def default-models-dev-timeout-ms 10000)
(def default-evidence-cache-ttl-ms 300000)
(defonce ^:private policy-evidence-cache (atom {}))

(defn- js-fetch []
  (.-fetch js/globalThis))

(defn- parse-json-response [response]
  (.json response))

(defn- provider-id [entry]
  (or (:provider-id entry) (:providerId entry) (:id entry)))

(defn- base-url [entry]
  (some-> (or (:base-url entry) (:baseUrl entry))
          (str/replace #"/+$" "")))

(defn- api-key [entry]
  (or (:api-key entry) (:apiKey entry) (:token entry)))

(defn- catalog-paths [entry]
  (or (:paths entry) (:catalog-paths entry) (:catalogPaths entry) ["/v1/models"]))

(defn- model-id-from-entry [entry]
  (cond
    (string? entry) entry
    (map? entry) (or (:id entry) (:name entry) (:model entry) (:model-id entry) (:modelId entry))
    :else nil))

(defn model-ids-from-v1-models-payload [payload]
  (let [items (cond
                (vector? payload) payload
                (map? payload) (or (:data payload) (:models payload) [])
                :else [])]
    (->> items
         (map model-id-from-entry)
         (filter string?)
         (remove str/blank?)
         vec)))

(defn models-dev-provider-models [payload]
  (let [providers (or (:providers payload) payload)]
    (reduce-kv (fn [acc provider-id provider]
                 (let [models (or (:models provider) {})]
                   (assoc acc (name provider-id)
                          (reduce-kv (fn [model-acc model-id _model]
                                       (assoc model-acc (name model-id) true))
                                     {}
                                     models))))
               {}
               providers)))

(defn- fetch-json! [fetch-fn url opts]
  (-> (fetch-fn url opts)
      (.then parse-json-response)))

(defn- models-dev-timeout-ms [opts]
  (or (:models-dev-timeout-ms opts)
      (:modelsDevTimeoutMs opts)
      default-models-dev-timeout-ms))

(defn load-models-dev-provider-models!
  ([opts] (load-models-dev-provider-models! opts (js-fetch)))
  ([opts fetch-fn]
   (let [url (or (:models-dev-url opts) (:modelsDevUrl opts) default-models-dev-url)
         controller (js/AbortController.)
         timeout-id (js/setTimeout #(.abort controller) (models-dev-timeout-ms opts))]
     (-> (fetch-json! fetch-fn url #js {:signal (.-signal controller)})
         (.then #(models-dev-provider-models (js->clj % :keywordize-keys true)))
         (.finally #(js/clearTimeout timeout-id))))))

(defn- route-url [route path]
  (str (base-url route) path))

(defn- auth-headers [route]
  (if-let [key (api-key route)]
    #js {"Authorization" (str "Bearer " key)}
    #js {}))

(defn- fetch-route-models! [fetch-fn route path]
  (-> (fetch-json! fetch-fn
                   (route-url route path)
                   #js {:headers (auth-headers route)})
      (.then #(model-ids-from-v1-models-payload (js->clj % :keywordize-keys true)))
      (.catch (fn [_] []))))

(defn- fetch-provider-snapshot! [fetch-fn route]
  (let [pid (provider-id route)
        paths (catalog-paths route)]
    (-> (js/Promise.all (clj->js (map #(fetch-route-models! fetch-fn route %) paths)))
        (.then (fn [results]
                 (let [model-ids (->> (js->clj results)
                                      (apply concat)
                                      distinct
                                      vec)]
                   [pid (zipmap model-ids (repeat true))]))))))

(defn load-provider-model-snapshots!
  ([routes] (load-provider-model-snapshots! routes (js-fetch)))
  ([routes fetch-fn]
   (-> (js/Promise.all (clj->js (map #(fetch-provider-snapshot! fetch-fn %) routes)))
       (.then (fn [entries]
                (into {} (js->clj entries)))))))

(defn- now-ms [] (.now js/Date))

(defn- route-cache-key [route]
  [(provider-id route) (base-url route) (vec (catalog-paths route))])

(defn- evidence-cache-key [opts routes]
  [(or (:models-dev-url opts) (:modelsDevUrl opts) default-models-dev-url)
   (mapv route-cache-key routes)])

(defn- cache-ttl-ms [opts]
  (or (:evidence-cache-ttl-ms opts)
      (:evidenceCacheTtlMs opts)
      default-evidence-cache-ttl-ms))

(defn- fresh-cache-entry [cache-key ttl-ms]
  (let [entry (get @policy-evidence-cache cache-key)]
    (when (and (:evidence entry)
               (< (- (now-ms) (:cached-at-ms entry 0)) ttl-ms))
      entry)))

(defn- store-cache-success! [cache-key evidence]
  (swap! policy-evidence-cache assoc cache-key {:cached-at-ms (now-ms)
                                                :evidence evidence})
  evidence)

(defn load-policy-evidence!
  "Build the evidence slice expected by contract-router.edn default policy.

  Evidence is cached in the CLJS policy runtime so request routing does not pay
  models.dev and /v1/models network round trips on every chat TTFT path.

  Returns {:models-dev/provider-models {...}
           :provider-model-snapshots {...}}."
  ([opts] (load-policy-evidence! opts (js-fetch)))
  ([opts fetch-fn]
   (let [routes (or (:provider-routes opts) (:providerRoutes opts) [])
         ttl-ms (cache-ttl-ms opts)
         cache-key (evidence-cache-key opts routes)]
     (if-let [entry (fresh-cache-entry cache-key ttl-ms)]
       (js/Promise.resolve (:evidence entry))
       (let [inflight (:inflight (get @policy-evidence-cache cache-key))]
         (if inflight
           inflight
           (let [request (-> (js/Promise.all #js [(load-models-dev-provider-models! opts fetch-fn)
                                                  (load-provider-model-snapshots! routes fetch-fn)])
                             (.then (fn [[models-dev snapshots]]
                                      (store-cache-success!
                                       cache-key
                                       {:models-dev/provider-models models-dev
                                        :provider-model-snapshots snapshots})))
                             (.catch (fn [error]
                                       (swap! policy-evidence-cache dissoc cache-key)
                                       (throw error))))]
             (swap! policy-evidence-cache assoc cache-key {:cached-at-ms (now-ms)
                                                           :inflight request})
             request)))))))
