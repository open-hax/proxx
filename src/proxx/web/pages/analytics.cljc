(ns proxx.web.pages.analytics
  "Analytics page: window/sort/focus state and table view-models."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.format :as fmt]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(def poll-ms 30000)
(def ls-window "open-hax-proxy.ui.analytics.window")
(def ls-sort "open-hax-proxy.ui.analytics.sort")
(def ls-provider "open-hax-proxy.ui.analytics.provider")
(def ls-model "open-hax-proxy.ui.analytics.model")

(def windows [["daily" "Daily (24h)"] ["weekly" "Weekly (7d)"] ["monthly" "Monthly (30d)"]])
(def sorts [["suitability" "Suitability"] ["tokens" "Tokens"] ["requests" "Requests"] ["ttft" "TTFT"]
            ["tps" "Decode TPS"] ["e2e-tps" "End-to-end TPS"] ["errors" "Error rate"] ["cost" "Cost"]])

(defn validate-window [v] (#{"daily" "weekly" "monthly"} v))
(defn validate-sort [v]
  (when (string? v)
    (let [n (str/lower-case (str/trim v))] (when (some #(= n (first %)) sorts) n))))

(defn window [db] (st/stored db ls-window "weekly" validate-window))
(defn sort-key [db] (st/stored db ls-sort "suitability" validate-sort))
(defn provider-focus [db] (st/stored db ls-provider "" storage/validate-string))
(defn model-focus [db] (st/stored db ls-model "" storage/validate-string))

(defn init [] {:analytics nil :loading? true :error nil :request-id 0 :model-search "" :provider-search ""})

(defn- load-fx [db]
  (let [id (inc (:request-id (st/page-slice db :analytics)))]
    [(st/update-page db :analytics assoc :request-id id :loading? true :error nil)
     [(fx/http (api/get-provider-model-analytics (sort-key db) (window db)) [:analytics/loaded id] [:analytics/failed id])]]))

(defn enter [db]
  (let [[db' fx*] (load-fx db)] [db' (into [(fx/interval-start :analytics poll-ms [:analytics/load])] fx*)]))

(defn leave [_] [(fx/interval-stop :analytics)])

(defn- options [rows k] (into [] (comp (map k) (filter #(and (string? %) (seq %)))) rows))

(defn- loaded [db [_ id payload]]
  (if (not= id (:request-id (st/page-slice db :analytics)))
    [db []]
    (let [db (st/update-page db :analytics assoc :analytics payload :loading? false)
          ;; focus on a provider/model that is no longer observed is cleared
          reset-fx (fn [[db fx*] k opts-key row-key]
                     (let [cur (get-in db [:stored k])]
                       (if (and (seq cur) (not (some #{cur} (options (get payload opts-key) row-key))))
                         (let [[db' f] (st/set-stored db k "")] [db' (into fx* f)])
                         [db fx*])))]
      (-> [db []]
          (reset-fx ls-provider :providers :providerId)
          (reset-fx ls-model :models :model)))))

(defn- failed [db [_ id message]]
  (if (= id (:request-id (st/page-slice db :analytics)))
    [(st/update-page db :analytics assoc :loading? false :error message) []]
    [db []]))

(defn- reload [[db fx*]] (let [[db' f] (load-fx db)] [db' (into (conj fx* (fx/interval-start :analytics poll-ms [:analytics/load])) f)]))

(defn- set-window [db [_ v]] (reload (st/set-stored db ls-window (or (validate-window v) "weekly"))))
(defn- set-sort [db [_ v]] (reload (st/set-stored db ls-sort (or (validate-sort v) "suitability"))))
(defn- set-provider [db [_ v]] (st/set-stored db ls-provider v))
(defn- set-model [db [_ v]] (st/set-stored db ls-model v))
(defn- set-model-search [db [_ v]] [(st/assoc-page db :analytics :model-search v) []])
(defn- set-provider-search [db [_ v]] [(st/assoc-page db :analytics :provider-search v) []])
(defn- poll [db _] (load-fx db))

(def page
  {:init init :enter enter :leave leave
   :handlers {:analytics/load poll :analytics/loaded loaded :analytics/failed failed
              :analytics/set-window set-window :analytics/set-sort set-sort
              :analytics/set-provider set-provider :analytics/set-model set-model
              :analytics/set-model-search set-model-search :analytics/set-provider-search set-provider-search}})

;; ---------------------------------------------------------------------------
;; Tables as data: column key -> header + cell formatter over a row

(def ^:private shared-tail
  [["suitability" "Suitability" #(fmt/maybe-fraction-percent (:suitabilityScore %))]
   ["confidence" "Confidence" #(fmt/maybe-fraction-percent (:confidenceScore %))]
   ["ttft" "Avg TTFT" #(fmt/maybe-ms (:avgTtftMs %))]
   ["decodeTps" "Decode TPS" #(fmt/maybe-tps (:avgDecodeTps %))]
   ["e2eTps" "End-to-End TPS" #(fmt/maybe-tps (:avgEndToEndTps %))]
   ["errorRate" "Error Rate" #(fmt/percent (:errorRate %))]
   ["cacheHit" "Cache Hit" #(fmt/percent (:cacheHitRate %))]
   ["cachedTokens" "Cached Tokens" #(fmt/compact-number (:cachedPromptTokens %))]
   ["requests" "Requests" #(fmt/compact-number (:requestCount %))]
   ["tokens" "Tokens" #(fmt/compact-number (:totalTokens %))]
   ["cost" "Est. Cost" #(fmt/usd (:costUsd %))]])

(def model-columns
  (into [["model" "Model" :model] ["providers" "Providers" #(fmt/compact-number (or (:providerCoverageCount %) 0))]] shared-tail))
(def provider-columns
  (into [["providerId" "Provider" :providerId] ["models" "Models" #(fmt/compact-number (or (:modelCoverageCount %) 0))]] shared-tail))
(def pair-columns
  (-> [["providerId" "Provider" :providerId] ["model" "Model" :model]]
      (into shared-tail)
      (into [["water" "Water" #(fmt/water (:waterEvaporatedMl %))]
             ["lastSeen" "Last Seen" #(fmt/format-date-or-dash (:lastSeenAt %))]])))

(defn table
  "`{:columns [{:key :header}] :rows [{:key col-key -> string, :row-key ...}]}`"
  [columns rows row-key-fn]
  {:columns (mapv (fn [[k h]] {:key k :header h}) columns)
   :rows (mapv (fn [row] (into {"rowKey" (row-key-fn row)}
                               (map (fn [[k _ f]] [k (str (f row))]))
                               columns))
               rows)})

(defn row-label [row] (or (:model row) (:providerId row) "-"))

(defn- search-filter [rows query]
  (let [q (str/lower-case (str/trim query))]
    (if (str/blank? q) rows (filterv #(str/includes? (str/lower-case (row-label %)) q) rows))))

(defn view-model [db]
  (let [{:keys [analytics loading? error model-search provider-search]} (st/page-slice db :analytics)
        {:keys [models providers providerModels coverage generatedAt]} analytics
        pf (provider-focus db) mf (model-focus db)
        fmodels (search-filter models model-search)
        fproviders (search-filter providers provider-search)
        fpairs (filterv #(and (or (str/blank? pf) (= pf (:providerId %))) (or (str/blank? mf) (= mf (:model %)))) providerModels)
        top-model (first models) top-provider (first providers)]
    {:window (window db) :sort (sort-key db) :provider-focus pf :model-focus mf
     :provider-options (options providers :providerId) :model-options (options models :model)
     :model-search model-search :provider-search provider-search
     :loading? loading? :error error
     :hero-stats [{:label "" :value (str "Updated " (fmt/format-date-or-dash generatedAt))}
                  {:label "" :value "Auto-refresh every 30s"}]
     :coverage-warning (when (and coverage (not (:hasFullWindowCoverage coverage)))
                         (str "Selected window is not fully covered yet. Coverage starts "
                              (fmt/format-date-or-dash (:coverageStart coverage))
                              "; requested window starts " (fmt/format-date-or-dash (:requestedWindowStart coverage))
                              ". Ranking and suitability are still useful, but historical totals may be partial."))
     :tiles [{:label "Observed Models" :value (fmt/compact-number (count models)) :detail (str "Top model: " (or (:model top-model) "-"))}
             {:label "Observed Providers" :value (fmt/compact-number (count providers)) :detail (str "Top provider: " (or (:providerId top-provider) "-")) :variant "info"}
             {:label "Provider × Model Pairs" :value (fmt/compact-number (count providerModels)) :detail (str "Window: " (window db))}
             {:label "Top Model Suitability" :value (fmt/maybe-fraction-percent (:suitabilityScore top-model)) :detail (or (:model top-model) "-") :variant "success"}
             {:label "Top Provider Suitability" :value (fmt/maybe-fraction-percent (:suitabilityScore top-provider)) :detail (or (:providerId top-provider) "-") :variant "success"}]
     :tabs [{:id "models" :label "Models" :badge (str (count fmodels))
             :empty "No models match the current filters."
             :table (table model-columns fmodels #(str "model-" (:model %)))}
            {:id "providers" :label "Providers" :badge (str (count fproviders))
             :empty "No providers match the current filters."
             :table (table provider-columns fproviders #(str "provider-" (:providerId %)))}
            {:id "pairs" :label "Pairs" :badge (str (count fpairs)) :wide? true
             :empty "No provider-model pairs match the current filters."
             :table (table pair-columns fpairs #(str "pair-" (:providerId %) "-" (:model %)))}]}))
