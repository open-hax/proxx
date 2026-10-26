(ns proxx.web.views.credentials
  (:require [proxx.web.pages.credentials :as creds]
            [proxx.web.ui :as ui]))

(defn- quota-row [{:keys [label percent-label width tone reset]}]
  [:div.credentials-quota-row
   [:div.credentials-quota-row-header [:span label] [:strong percent-label]]
   [:div.credentials-quota-bar [:span {:class (str "credentials-quota-fill " tone) :style {:width width}}]]
   (when reset [:small reset])])

(defn- quota-group [{:keys [title badge badge-text rows empty?]}]
  [:section.credentials-quota-group
   [:div.credentials-quota-group-header [:strong title] [ui/badge {:variant badge} badge-text]]
   [:div.credentials-quota-list
    (for [r rows] ^{:key (:label r)} [quota-row r])
    (when empty? [:p.credentials-quota-note "No window data returned for this rate-limit bucket."])]])

(defn- quota-card [{:keys [updated state groups error note]}]
  [:section.credentials-quota-card
   [:header.credentials-quota-card-header [:strong "Codex quota"] [:span updated]]
   (case state
     :ok [:div.credentials-quota-list (for [g groups] ^{:key (:title g)} [quota-group g])]
     :error [:p.credentials-quota-note.credentials-quota-note-error error]
     [:p.credentials-quota-note note])])

(defn- detail-item [dispatch! {:keys [label value copy]}]
  (if copy
    [:div.credentials-account-detail-item.credentials-account-detail-item-copyable
     [:div [:dt label] [:dd value]]
     [:button {:type "button" :on-click #(dispatch! [:credentials/copy (:value copy) (:key copy)])} (:text copy)]]
    [:div.credentials-account-detail-item [:dt label] [:dd value]]))

(defn- account-tile [dispatch! {:keys [key provider-id account-id display-name subtitle chips workspace-chip expiry-chip token-chip
                                       can-reauth? reauth-label reauth-ctx can-probe? probe-loading? probe show-quota? quota details disabled?]}]
  [:article.credentials-account-tile
   [:header.credentials-account-header
    [:div.credentials-account-title-wrap
     [:strong display-name]
     (when subtitle [:span.credentials-account-subtitle subtitle])]
    [:div.credentials-provider-badges [ui/status-chip-stack {:items chips}]]]
   [:div.credentials-account-chip-row
    (when workspace-chip [:span.credentials-chip workspace-chip])
    (when expiry-chip [:span.credentials-chip expiry-chip])
    [:span.credentials-chip token-chip]]
   (when (or can-reauth? can-probe?)
     [:div.credentials-account-actions
      (when can-reauth?
        [:button.credentials-shortcut-button {:type "button" :on-click #(dispatch! [:credentials/start-browser reauth-ctx])} reauth-label])
      (when can-probe?
        [:button.credentials-shortcut-button {:type "button" :disabled probe-loading?
                                              :on-click #(dispatch! [:credentials/probe provider-id account-id])}
         (if probe-loading? [:<> [ui/spinner {:size "sm"}] " Testing…"] "Test live")])
      (when probe [ui/badge {:variant (:badge probe)} (:badge-text probe)])])
   (when probe [:p {:class (:note-class probe)} (:note probe)])
   (when show-quota? [quota-card quota])
   [:details.credentials-account-details
    [:summary "Details"]
    [:dl.credentials-account-detail-list
     (for [d (remove nil? details)] ^{:key (:label d)} [detail-item dispatch! d])]
    [:div.credentials-account-actions-stack
     (if disabled?
       [:button.credentials-enable-button {:type "button" :on-click #(dispatch! [:credentials/enable provider-id account-id display-name])} "Enable account"]
       [:button.credentials-disable-button {:type "button" :on-click #(dispatch! [:credentials/disable provider-id account-id display-name])} "Disable account"])
     [:button.credentials-remove-button {:type "button" :on-click #(dispatch! [:credentials/remove provider-id account-id display-name])}
      "Remove credential"]]]])

(defn- creds-pool [{:keys [summary badge badge-text tone width metrics]}]
  [:details.credentials-section-details
   [:summary
    [:div [:h3 "OpenAI OAuth quota pool"] [:p summary]]
    [:div.credentials-provider-badges [ui/badge {:variant badge} badge-text]]]
   [:div.credentials-quota-bar.credentials-pool-bar [:span {:class (str "credentials-quota-fill " tone) :style {:width width}}]]
   [:div.credentials-pool-grid
    (for [{:keys [title value note]} metrics]
      ^{:key title} [:dl.credentials-pool-metric [:dt title] [:dd value] [:small note]])]
   [:p.credentials-pool-meta "Combined pool averages all accounts. Critical accounts have ≤ 5% remaining but are still usable for the current turn."]])

(defn- audit-row [{:keys [hash-short hash model-line ok-badge ok-short fail-badge fail-short requests cache-pct last-seen
                          ok-long ok-ids fail-long fail-ids counts tokens first-seen]}]
  [:details.credentials-audit-details
   [:summary
    [:span [:strong hash-short] (when model-line [:small model-line])]
    [:span [ui/badge {:variant ok-badge} ok-short]]
    [:span [ui/badge {:variant fail-badge} fail-short]]
    [:span [:strong requests] [:small "req"]]
    [:span [:strong cache-pct] [:small "cache"]]
    [:span [:strong last-seen]]]
   [:div.credentials-audit-row
    [:div [:strong hash] (when model-line [:small model-line])]
    [:div [ui/badge {:variant ok-badge} ok-long] [:small ok-ids]]
    [:div [ui/badge {:variant fail-badge} fail-long] [:small fail-ids]]
    [:div [:strong requests] [:small counts]]
    [:div [:strong cache-pct] [:small tokens]]
    [:div [:strong last-seen] [:small first-seen]]]])

(defn- audit-section [{:keys [summary rows]}]
  [:details.credentials-section-details
   [:summary [:div [:h3 "Prompt cache affinity audit"] [:p summary]]]
   (if (seq rows)
     [:div.credentials-audit-table-wrap
      [:div.credentials-audit-table (for [r rows] ^{:key (:key r)} [audit-row r])]]
     [:p.credentials-pool-meta "No prompt-cache hashes have been recorded in recent OpenAI OAuth request logs yet."])])

(defn- watchlist [watch]
  [:details.credentials-section-details
   [:summary [:div [:h3 "Cache stability watchlist"]
              [:p "Single-success-account hashes with one stable request shape and enough traffic to judge cache reliability."]]]
   (if (seq watch)
     [:div.credentials-watch-grid
      (for [{:keys [key hash model-line cache-badge cache-text success-text account prompt-tokens cached-tokens shapes]} watch]
        ^{:key key}
        [:article.credentials-pool-metric.credentials-watch-card
         [:div [:strong hash] [:small model-line]]
         [:div.credentials-provider-badges [ui/badge {:variant cache-badge} cache-text] [ui/badge {:variant "default"} success-text]]
         [:dl.credentials-watch-metrics
          [:div [:dt "Successful account"] [:dd account]]
          [:div [:dt "Prompt tokens"] [:dd prompt-tokens]]
          [:div [:dt "Cached prompt tokens"] [:dd cached-tokens]]
          [:div [:dt "Shape fingerprints"] [:dd shapes]]]])]
     [:p.credentials-pool-meta "No stable same-account hashes currently look anomalous enough to flag."])])

(defn- device-hint [{:keys [url code]}]
  [:p "Visit " [:a {:href url :target "_blank" :rel "noreferrer"} url] " and enter code " [:strong code] "."])

(defn- oauth-block [dispatch! title provider {:keys [device poll-label poll-disabled?]} start-browser-event]
  [:div.credentials-oauth
   [:h3 title]
   [:div.credentials-oauth-row
    [:button {:type "button" :on-click #(dispatch! start-browser-event)} "Start browser flow"]
    [:button {:type "button" :on-click #(dispatch! [:credentials/start-device provider])} "Start device flow"]
    [:button {:type "button" :on-click #(dispatch! [:credentials/poll-device]) :disabled (poll-disabled? provider)} (poll-label provider)]]
   (when (and device (= provider (:provider device))) [device-hint device])])

(defn view [db dispatch!]
  (let [vm (creds/view-model db (js/Date.now))
        {:keys [reveal? search grouping quota-loading? reauth-button reauth-disabled? showing quota-line diag-line quota-error pool
                audit sections provider-health api-key status error log-provider log-account account-ids logs]} vm]
    [:div.credentials-layout
     [:section.credentials-panel
      [:header
       [:h2 "Credentials Manager"]
       [:label.toggle-row
        [:input {:type "checkbox" :checked reveal? :on-change #(dispatch! [:credentials/set-reveal (ui/event-checked %)])}]
        "Reveal secrets"]]

      [:div.credentials-toolbar
       [:input {:value search :placeholder "Search accounts, emails, plans, workspace IDs"
                :on-change #(dispatch! [:credentials/set-search (ui/event-value %)])}]
       [:label.credentials-inline-control
        [:span "Group by"]
        [:select {:value grouping :on-change #(dispatch! [:credentials/set-grouping (ui/event-value %)])}
         [:option {:value "provider"} "Provider"] [:option {:value "plan"} "Plan"] [:option {:value "domain"} "Email domain"]]]
       [:button {:type "button" :on-click #(dispatch! [:credentials/refresh-quota]) :disabled quota-loading?}
        (if quota-loading? "Refreshing Codex quotas..." "Refresh Codex quotas")]
       [:button {:type "button" :on-click #(dispatch! [:credentials/toggle-reauth-only]) :disabled reauth-disabled?} reauth-button]]

      [:div.credentials-toolbar-meta-stack
       [:p.credentials-toolbar-meta showing]
       [:p.credentials-toolbar-meta quota-line]
       [:p.credentials-toolbar-meta diag-line]]

      (when quota-error [:p.error-text quota-error])
      (when pool [creds-pool pool])
      (when audit [audit-section audit])
      (when audit [watchlist (:watch audit)])

      (if (seq sections)
        [:div.credentials-provider-stack
         (for [{:keys [key title description badge badge-muted accounts]} sections]
           ^{:key key}
           [:details.credentials-section-details
            [:summary
             [:div [:h3 title] [:p description]]
             [:div.credentials-provider-badges [ui/badge {:variant "default"} badge] [ui/badge {:variant "default"} badge-muted]]]
            [:div.credentials-account-grid
             (for [t accounts] ^{:key (:key t)} [account-tile dispatch! t])]])]
        [:article.credentials-card [:p "No credential accounts match the current filter."]])

      [:div.credentials-provider-grid
       (for [{:keys [id recent last pool]} provider-health]
         ^{:key (str "health-" id)}
         [:article.credentials-card
          [:h3 id] [:p recent] (when last [:p last])
          (if pool (for [line pool] ^{:key line} [:p line]) [:p "No key pool status yet."])])]

      [:form.credentials-form {:on-submit (fn [e] (.preventDefault e) (dispatch! [:credentials/submit-api-key]))}
       [:h3 "Add API key account"]
       [:div.credentials-form-shortcuts
        [:button.credentials-shortcut-button {:type "button" :on-click #(dispatch! [:credentials/api-key-shortcut "factory"])} "Add Factory Key"]
        [:button.credentials-shortcut-button {:type "button" :on-click #(dispatch! [:credentials/api-key-shortcut "xiaomi"])} "Add Xiaomi MiMo Key"]]
       [:select {:value (:provider api-key) :on-change #(dispatch! [:credentials/api-key-field :provider (ui/event-value %)])}
        (for [[v t] creds/api-key-providers] ^{:key v} [:option {:value v} t])]
       [:input {:value (:account api-key) :placeholder "account id (optional — auto-generated if empty)"
                :on-change #(dispatch! [:credentials/api-key-field :account (ui/event-value %)])}]
       [:input {:type "password" :value (:value api-key) :placeholder "api key"
                :on-change #(dispatch! [:credentials/api-key-field :value (ui/event-value %)])}]
       [:button {:type "submit"} "Save API key"]]

      [oauth-block dispatch! "OpenAI OAuth" :openai vm [:credentials/start-browser {:kind :openai}]]
      [oauth-block dispatch! "Factory.ai OAuth" :factory vm [:credentials/start-browser {:kind :factory}]]

      (when status [:p.status-text status])
      (when error [:p.error-text error])]

     [:section.credentials-panel
      [:header [:h2 "Request Logs"]]
      [:div.credentials-log-filters
       [:input {:value log-provider :placeholder "filter provider" :on-change #(dispatch! [:credentials/set-log-provider (ui/event-value %)])}]
       [:input {:list "account-ids" :value log-account :placeholder "filter account" :on-change #(dispatch! [:credentials/set-log-account (ui/event-value %)])}]
       [:datalist#account-ids (for [id account-ids] ^{:key id} [:option {:value id}])]
       [:button {:type "button" :on-click #(dispatch! [:credentials/refresh-logs])} "Refresh logs"]]
      [:div.credentials-log-table
       (for [{:keys [id title status-line detail error]} logs]
         ^{:key id}
         [:article [:header [:strong title] [:span status-line]] [:p detail] (when error [:small error])])]]]))
