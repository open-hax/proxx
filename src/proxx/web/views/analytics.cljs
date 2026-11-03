(ns proxx.web.views.analytics
  (:require [proxx.web.pages.analytics :as analytics]
            [proxx.web.ui :as ui]))

(defn- data-table [{:keys [columns rows]} empty wide?]
  [ui/data-table-shell (cond-> {:columns columns :rows rows :empty-state empty
                                :row-key (fn [^js row _] (aget row "rowKey"))}
                         wide? (assoc :wide true))])

(defn- select [label value options on-change & [all-label]]
  [:label label " "
   [:select {:value value :on-change #(on-change (ui/event-value %))}
    (when all-label [:option {:value ""} all-label])
    (for [[v text] options] ^{:key v} [:option {:value v} text])]])

(defn view [db dispatch!]
  (let [{:keys [window sort provider-focus model-focus provider-options model-options model-search provider-search
                loading? error hero-stats coverage-warning tiles tabs]} (analytics/view-model db)]
    [:div.analytics-layout
     [ui/surface-hero
      {:kicker "Routing Intelligence"
       :title "Provider + model analytics"
       :description "Explore observed performance by model, by provider, and by provider × model pair. Suitability is a heuristic derived from TTFT, decode TPS, error rate, cache behavior, and confidence."
       :stats hero-stats}]
     (when error [:p.error-text error])
     (when coverage-warning [:p.error-text coverage-warning])
     [ui/metric-tile-grid
      (for [{:keys [label value detail variant]} tiles]
        ^{:key label} [ui/metric-tile (cond-> {:label label :value value :detail detail :loading loading?}
                                        variant (assoc :variant variant))])]
     [:section.analytics-panel.panel-sheen
      [ui/panel-header
       {:title "Controls"
        :description "Change the observed window, sort order, and pair-level focus."
        :actions (ui/element
                  [ui/filter-toolbar
                   [select "Window" window analytics/windows #(dispatch! [:analytics/set-window %])]
                   [select "Sort" sort analytics/sorts #(dispatch! [:analytics/set-sort %])]
                   [select "Provider focus" provider-focus (map (juxt identity identity) provider-options)
                    #(dispatch! [:analytics/set-provider %]) "All providers"]
                   [select "Model focus" model-focus (map (juxt identity identity) model-options)
                    #(dispatch! [:analytics/set-model %]) "All models"]])}]]
     [:section.analytics-panel.panel-sheen
      [ui/panel-header
       {:title "Analytics Views"
        :description "Switch between model, provider, and pair-level views without losing context."
        :actions (ui/element
                  [ui/filter-toolbar
                   [ui/input {:aria-label "Search models" :value model-search :placeholder "Search models…"
                              :on-change #(dispatch! [:analytics/set-model-search (ui/event-value %)])}]
                   [ui/input {:aria-label "Search providers" :value provider-search :placeholder "Search providers…"
                              :on-change #(dispatch! [:analytics/set-provider-search (ui/event-value %)])}]])}]
      [ui/tabs {:default-value "models" :variant "enclosed"
                :items (mapv (fn [{:keys [id label badge table empty wide?]}]
                               {:id id :label label :badge badge
                                :content (ui/element [data-table table empty wide?])})
                             tabs)}]]]))
