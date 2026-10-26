(ns proxx.web.views.dashboard
  (:require [proxx.web.pages.dashboard :as dash]
            [proxx.web.ui :as ui]
            [reagent.core :as r]))

(defn- sentinel
  "Fires `on-visible` while the element is inside its `.dashboard-panel-scroll`
  ancestor (+200px margin). The observer is re-created whenever `:version`
  changes, so a still-visible sentinel keeps loading (as the infinite lists
  always did)."
  [_props & _children]
  (let [obs (atom nil) el (atom nil)
        disconnect! (fn [] (when-let [^js o @obs] (.disconnect o) (reset! obs nil)))
        setup! (fn [on-visible]
                 (disconnect!)
                 (when-let [^js node @el]
                   (when-let [root (.closest node ".dashboard-panel-scroll")]
                     (let [o (js/IntersectionObserver.
                              (fn [entries] (when (some-> (aget entries 0) .-isIntersecting) (on-visible)))
                              #js {:root root :rootMargin "200px"})]
                       (.observe o node)
                       (reset! obs o)))))]
    (r/create-class
     {:component-did-mount (fn [this] (setup! (:on-visible (r/props this))))
      :component-did-update (fn [this old-argv]
                              (when (not= (:version (second old-argv)) (:version (r/props this)))
                                (setup! (:on-visible (r/props this)))))
      :component-will-unmount disconnect!
      :reagent-render (fn [{:keys [class]} & children]
                        (into [:div {:class class :ref #(reset! el %)}] children))})))

(defn- spark-bars [bars]
  [:div.dashboard-sparkbars {:aria-hidden "true"}
   (for [{:keys [key height]} bars] ^{:key key} [:span {:style {:height (str height "%")}}])])

(defn- donut-chart [segments]
  (if (nil? segments)
    [:div.dashboard-donut-empty "No token activity yet"]
    [:svg.dashboard-donut-chart {:view-box "0 0 120 120" :aria-hidden "true"}
     [:circle.dashboard-donut-track {:cx 60 :cy 60 :r 42}]
     (for [{:keys [key index dasharray dashoffset]} segments]
       ^{:key key}
       [:circle {:cx 60 :cy 60 :r 42 :class (str "dashboard-donut-segment dashboard-donut-segment-" (mod index 6))
                 :stroke-dasharray dasharray :stroke-dashoffset dashoffset}])]))

(defn- tier-mix [bars]
  (if (nil? bars)
    [:div.dashboard-account-empty "No tiered request activity yet."]
    [:div.dashboard-tier-summary
     (for [{:keys [label class text width]} bars]
       ^{:key label}
       [:div.dashboard-tier-summary-row
        [:div.dashboard-tier-summary-labels [:strong label] [:small text]]
        [:div.dashboard-tier-summary-track {:aria-hidden "true"}
         [:span {:class (str "dashboard-tier-summary-fill " class) :style {:width width}}]]])]))

(defn- window-select [value on-change]
  [:label "Window " [:select {:value value :on-change #(on-change (ui/event-value %))}
                     [:option {:value "daily"} "Daily (24h)"]
                     [:option {:value "weekly"} "Weekly (7d)"]
                     [:option {:value "monthly"} "Monthly (30d)"]]])

(defn view [db dispatch!]
  (let [{:keys [window window-label account-sort provider-filter loading? error coverage-note tiles donut legend tier-bars
                overview? trends providers logs loading-more? log-version provider-options accounts accounts-empty
                more-health? has-filtered? health-version]} (dash/view-model db)]
    [:div.dashboard-layout
     (when error [:p.error-text error])
     (when coverage-note [:span.dashboard-coverage-note coverage-note])

     [ui/metric-tile-grid {:class "dashboard-metrics-grid"}
      (for [{:keys [label value detail sparkbar variant]} tiles]
        ^{:key label}
        [ui/metric-tile (cond-> {:label label :variant variant
                                 :value (if loading? (ui/element [ui/spinner {:size "sm"}]) value)}
                          detail (assoc :detail detail)
                          sparkbar (assoc :sparkbar sparkbar))])]

     [:div.dashboard-area-left
      [:article.dashboard-panel.panel-sheen
       [ui/panel-header {:title "Account Token Share" :description "Who is carrying the last 24h load."}]
       [:div.dashboard-panel-scroll
        [:div.dashboard-donut-wrap
         [donut-chart donut]
         [:div.dashboard-donut-legend
          (for [{:keys [key index name tokens]} legend]
            ^{:key key}
            [:div.dashboard-legend-row
             [:span {:class (str "dashboard-legend-swatch dashboard-donut-segment-" index)}]
             [:div [:strong name] [:small tokens]]])]]]]

      [:article.dashboard-panel.panel-sheen
       [ui/panel-header {:title "Service Tier Mix"}]
       [:div.dashboard-panel-scroll
        (if overview? [tier-mix tier-bars] [:div.dashboard-account-empty "Loading tier mix…"])]]

      [:article.dashboard-panel.panel-sheen
       [ui/panel-header {:title "Traffic Trend"
                         :actions (ui/element [:div.dashboard-panel-controls
                                               [window-select window #(dispatch! [:dashboard/set-window %])]])}]
       [:div.dashboard-panel-scroll
        [:div.dashboard-trend-grid
         [:div [:span.dashboard-chart-label "Requests"]
          (if overview? [spark-bars (:requests trends)] [:div.dashboard-sparkbars.dashboard-sparkbars-placeholder])]
         [:div [:span.dashboard-chart-label "Tokens"]
          (if overview? [spark-bars (:tokens trends)] [:div.dashboard-sparkbars.dashboard-sparkbars-placeholder])]]]]

      [:article.dashboard-panel.panel-sheen
       [:header.dashboard-panel-header [:div [:h3 "Provider Pool"]]]
       [:div.dashboard-panel-scroll
        [:div.dashboard-provider-grid
         (if (empty? providers)
           [:div.dashboard-account-empty "No provider status available yet."]
           (for [{:keys [id badge auth rows]} providers]
             ^{:key id}
             [:article.dashboard-provider-card
              [:div.dashboard-provider-card-header [:strong id] [ui/badge {:variant badge} auth]]
              [:dl (for [[k v] rows] ^{:key k} [:div [:dt k] [:dd v]])]]))]]]]

     [:article.dashboard-panel.panel-sheen.dashboard-area-logs
      [:header.dashboard-panel-header
       [:div [:h3 "Recent Request Log"]
        [:p "The last few upstream attempts, useful for spotting fallback churn and model failures."]]]
      [:div.dashboard-panel-scroll
       [:div.dashboard-log-table
        [:div.dashboard-log-header (for [h ["When" "Provider / Route" "Model" "Tier" "Status" "Latency"]] ^{:key h} [:span h])]
        (if (empty? logs)
          [:div.dashboard-account-empty "No request log entries yet."]
          (for [{:keys [id when route model tier tier-badge status-badge status-text latency]} logs]
            ^{:key id}
            [:div.dashboard-log-row
             [:span when] [:span route] [:span model]
             [ui/badge {:variant tier-badge} tier]
             [ui/badge {:variant status-badge} status-text]
             [:span latency]]))
        [sentinel {:class "dashboard-log-sentinel" :version log-version :on-visible #(dispatch! [:dashboard/load-more-logs])}
         (when loading-more? [:span.dashboard-log-loading "Loading more…"])]]]]

     [:article.dashboard-panel.panel-sheen.dashboard-area-health
      [:header.dashboard-panel-header
       [:div [:h3 "Account Health"]
        [:p "Ordered by health by default; filter to a provider or sort by tokens, requests, TTFT, decode TPS, or end-to-end TPS."]]
       [:div.dashboard-panel-controls
        [:label "Sort " [:select {:value account-sort :on-change #(dispatch! [:dashboard/set-sort (ui/event-value %)])}
                         (for [[v t] dash/account-sorts] ^{:key v} [:option {:value v} t])]]
        [:label "Provider " [:select {:value provider-filter :on-change #(dispatch! [:dashboard/set-provider (ui/event-value %)])}
                             [:option {:value dash/all-providers} "All providers"]
                             (for [p provider-options] ^{:key p} [:option {:value p} p])]]]]
      [:div.dashboard-panel-scroll
       [:div.dashboard-account-table
        [:div.dashboard-account-table-header
         (for [h ["Account" "Status" "Health" "TTFT" "Decode TPS" "End-to-End TPS" "Cache" "Requests" "Tokens" "Last Seen"]]
           ^{:key h} [:span h])]
        (if (empty? accounts)
          [:div.dashboard-account-empty accounts-empty]
          (for [{:keys [key name auth badge status health ttft decode e2e cache requests tokens last-seen]} accounts]
            ^{:key key}
            [:div.dashboard-account-row
             [:div [:strong name] [:small auth]]
             [ui/badge {:variant badge} status]
             [:span health] [:span ttft] [:span decode] [:span e2e] [:span cache] [:span requests] [:span tokens] [:span last-seen]]))
        (when more-health?
          [sentinel {:class "dashboard-log-sentinel" :version health-version :on-visible #(dispatch! [:dashboard/more-health])}
           [:span.dashboard-log-loading "Loading more…"]])
        (when (and (not more-health?) has-filtered?)
          [sentinel {:class "dashboard-log-sentinel" :version health-version :on-visible #(dispatch! [:dashboard/more-health])}])]]]]))
