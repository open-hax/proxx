(ns proxx.runtime.pricing
  "Stateful edge of model pricing: the active models.dev snapshot and its indexes,
  the policy overrides, the contract-derived resolution profile, the models.dev
  refresh (fetch, abort timeout) and its scheduler. All decisions are in
  proxx.pricing.model; this namespace sequences effects around them.

  Every entry point takes the policy manifest path first (as the other policy-backed
  kernels do); the snapshot location comes from the manifest's
  `:model-pricing-snapshot` contract."
  (:require ["node:fs" :as fs]
            ["node:path" :as path]
            [cljs.reader :as reader]
            [proxx.policy.loader :as loader]
            [proxx.pricing.model :as model]
            [proxx.schema :as schema]))

(def ^:private default-source-url "https://models.dev/api.json")
(def ^:private default-refresh-timeout-ms 10000)
(def ^:private default-refresh-interval-ms (* 6 60 60 1000))

;; {:snapshot :indexes :overrides}; the snapshot is loaded lazily from the manifest
;; and replaced wholesale by a refresh.
(defonce ^:private state (atom {:snapshot nil :indexes nil :overrides []}))
(defonce ^:private profiles (atom {}))

(defn- nullish-or [v default] (if (nil? v) default v))

(defn- read-snapshot-file [file-path]
  (schema/assert! :proxx/models-dev-pricing-snapshot
                  (reader/read-string (.readFileSync fs file-path "utf8"))))

(defn- contracts-for
  "{:profile :snapshot-file} for a manifest, loaded and validated once."
  [manifest-path]
  (or (get @profiles manifest-path)
      (let [contracts (loader/load-policy-contracts! manifest-path)
            entry {:profile (model/profile-from-contracts contracts)
                   :snapshot-file (.join path (.dirname path manifest-path) (model/snapshot-path contracts))}]
        (swap! profiles assoc manifest-path entry)
        entry)))

(defn- install-snapshot! [snapshot]
  (swap! state assoc :snapshot snapshot :indexes (model/build-indexes snapshot)))

(defn- active!
  "The active {:snapshot :indexes :overrides}, loading the bundled snapshot on first use."
  [manifest-path]
  (when-not (:snapshot @state)
    (install-snapshot! (read-snapshot-file (:snapshot-file (contracts-for manifest-path)))))
  @state)

;; ---------------------------------------------------------------------------
;; JS conversion
;; ---------------------------------------------------------------------------

(defn- pricing->js [{:keys [input output reasoning cache-read cache-write joules-per-input-token
                            joules-per-output-token found? source provider-id model-id]}]
  (let [o #js {:inputPer1MTokens input :outputPer1MTokens output :reasoningPer1MTokens reasoning
               :cacheReadPer1MTokens cache-read :cacheWritePer1MTokens cache-write
               :joulesPerInputToken joules-per-input-token :joulesPerOutputToken joules-per-output-token
               :pricingFound found? :pricingSource source}]
    (when provider-id (aset o "pricingProviderId" provider-id))
    (when model-id (aset o "pricingModelId" model-id))
    o))

(defn- status->js [{:keys [generated-at source-url provider-count model-count]}]
  #js {:generatedAt generated-at :sourceUrl source-url
       :providerCount provider-count :modelCount model-count})

(defn- cost->js [cost]
  (let [o #js {}]
    (doseq [[k v] [[:input "input"] [:output "output"] [:reasoning "reasoning"]
                   [:cache-read "cache_read"] [:cache-write "cache_write"]]
            :let [x (get cost k)]
            :when (some? x)]
      (aset o v x))
    o))

(defn- snapshot->js [{:keys [generated-at source-url providers]}]
  (let [ps #js {}]
    (doseq [[provider-id models] providers
            :let [ms #js {}]]
      (doseq [[model-id cost] models] (aset ms model-id (cost->js cost)))
      (aset ps provider-id #js {:models ms}))
    #js {:generatedAt generated-at :sourceUrl source-url :providers ps}))

;; ---------------------------------------------------------------------------
;; Entry points
;; ---------------------------------------------------------------------------

(defn get-model-pricing-js [manifest-path provider-id model]
  (let [{:keys [indexes overrides]} (active! manifest-path)]
    (pricing->js (model/model-pricing (:profile (contracts-for manifest-path)) indexes overrides provider-id model))))

(defn estimate-request-cost-js
  [manifest-path provider-id model prompt-tokens completion-tokens water-ml-per-kwh]
  (let [{:keys [indexes overrides]} (active! manifest-path)
        pricing (model/model-pricing (:profile (contracts-for manifest-path)) indexes overrides provider-id model)
        {:keys [cost-usd energy-joules water-evaporated-ml]}
        (model/estimate-cost pricing prompt-tokens completion-tokens water-ml-per-kwh)]
    #js {:costUsd cost-usd :energyJoules energy-joules :waterEvaporatedMl water-evaporated-ml}))

(defn set-policy-model-pricing-overrides-js
  "Replace the policy overrides with the usable rules in `overrides` (a JS array of
  {modelPattern, inputPer1MTokens, outputPer1MTokens, ...}); a non-array clears them.
  An uncompilable pattern throws and leaves the previous overrides in place."
  [overrides]
  (swap! state assoc :overrides
         (if (array? overrides) (model/parse-override-rules (js->clj overrides)) [])))

(defn get-model-pricing-index-status-js [manifest-path]
  (status->js (model/snapshot-status (:snapshot (active! manifest-path)))))

(defn get-models-dev-pricing-snapshot-js
  "The active snapshot in its JSON shape {generatedAt, sourceUrl, providers: {id: {models: {id: cost}}}}."
  [manifest-path]
  (snapshot->js (:snapshot (active! manifest-path))))

(defn- unref-timer [^js timer] (when (fn? (.-unref timer)) (.unref timer)) timer)

(defn ^:async refresh-models-dev-pricing-index-js
  "Fetch a models.dev-compatible payload, compact it, and make it the active snapshot.
  options: {sourceUrl?, fetchFn?, timeoutMs?}."
  [manifest-path options]
  (let [^js options (nullish-or options #js {})
        source-url (nullish-or (.-sourceUrl options) default-source-url)
        fetch-fn (nullish-or (.-fetchFn options) (.-fetch js/globalThis))]
    (when-not (fn? fetch-fn)
      (throw (js/Error. "global fetch is not available; cannot refresh models.dev pricing index")))
    (let [controller (js/AbortController.)
          timeout (unref-timer (js/setTimeout #(.abort controller)
                                              (nullish-or (.-timeoutMs options) default-refresh-timeout-ms)))]
      (try
        (let [^js response (await (fetch-fn source-url #js {:signal (.-signal controller)}))]
          (when-not (.-ok response)
            (throw (js/Error. (str "Failed to fetch " source-url ": " (.-status response)))))
          (let [payload (js->clj (await (.json response)))
                snapshot (try (model/compact-snapshot payload (.toISOString (js/Date.)) source-url)
                              (catch :default e (throw (js/Error. (ex-message e)))))]
            (install-snapshot! snapshot)
            (get-model-pricing-index-status-js manifest-path)))
        (finally (js/clearTimeout timeout))))))

(defn start-models-dev-pricing-refresh-js
  "Refresh now (unless initialRefresh is false) and every intervalMs. Concurrent
  refreshes share one in-flight promise. Returns {refreshNow, stop}.
  options: refresh options plus {intervalMs?, initialRefresh?, onRefresh?, onError?}."
  [manifest-path options]
  (let [^js options (nullish-or options #js {})
        interval-ms (nullish-or (.-intervalMs options) default-refresh-interval-ms)
        stopped (atom false)
        timer (atom nil)
        in-flight (atom nil)
        refresh-now
        (fn refresh-now []
          (or @in-flight
              (let [p (-> (refresh-models-dev-pricing-index-js manifest-path options)
                          (.then (fn [status]
                                   (when-let [f (.-onRefresh options)] (.call f options status))
                                   status))
                          (.catch (fn [error]
                                    (when-let [f (.-onError options)] (.call f options error))
                                    (throw error)))
                          (.finally #(reset! in-flight nil)))]
                (reset! in-flight p)
                p)))
        schedule-next
        (fn schedule-next []
          (when-not (or @stopped (<= interval-ms 0))
            (reset! timer
                    (unref-timer
                     (js/setTimeout (fn []
                                      (reset! timer nil)
                                      (-> (refresh-now) (.catch (fn [_] nil)) (.finally schedule-next)))
                                    interval-ms)))))]
    (if (nullish-or (.-initialRefresh options) true)
      (-> (refresh-now) (.catch (fn [_] nil)) (.finally schedule-next))
      (schedule-next))
    #js {:refreshNow refresh-now
         :stop (fn []
                 (reset! stopped true)
                 (when-let [t @timer] (js/clearTimeout t) (reset! timer nil)))}))
