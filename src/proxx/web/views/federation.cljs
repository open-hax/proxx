(ns proxx.web.views.federation
  (:require [proxx.web.pages.federation :as fed]
            [proxx.web.ui :as ui]))

(defn- kv [rows]
  [:dl.federation-kv (for [[k v] rows] ^{:key k} [:<> [:dt k] [:dd v]])])

(defn- knowledge-tab [{:keys [id count-text variant providers]}]
  [:div [:p count-text]
   [:ul.federation-pills
    (for [{:keys [providerId count]} providers]
      ^{:key (str id "-" providerId)} [:li [ui/badge {:variant variant} providerId] " · " count])]])

(defn- form-input [dispatch! form k label attrs]
  [:label label
   [ui/input (merge {:value (get form k) :on-change #(dispatch! [:federation/form k (ui/event-value %)])} attrs)]])

(defn view [db dispatch!]
  (let [{:keys [owner loading? error submitting? form hero-stats self-rows bridges routing-rows knowledge-tabs
                last-sync routed peers]} (fed/view-model db)]
    [:section.federation-page
     [ui/surface-hero
      {:kicker "Federation" :title "Brethren control surface"
       :description "Inspect self-state, peers, projected accounts, bridge sessions, and pull syncs without spelunking through curl, psql, and host tunnels."
       :stats hero-stats}]

     [:section.federation-toolbar.panel-sheen
      [ui/filter-toolbar
       [:label "Owner subject"
        [ui/input {:type "text" :value owner :placeholder "did:web:proxx.promethean.rest:brethren"
                   :on-change #(dispatch! [:federation/owner (ui/event-value %)])}]]
       [ui/action-strip
        [ui/button {:type "button" :variant "primary" :loading loading? :on-click #(dispatch! [:federation/load])}
         (if loading? "Refreshing…" "Refresh")]
        [ui/button {:type "button" :variant "secondary" :on-click #(dispatch! [:federation/reset-owner])}
         "Default brethren subject"]]]]

     (when error [:div.federation-error.panel-sheen error])

     [:div.federation-grid
      [ui/card {:variant "elevated" :padding "md" :style {:min-height "100%"}}
       [ui/panel-header {:title "Self"}] [kv self-rows]]
      [ui/card {:variant "elevated" :padding "md" :style {:min-height "100%"}}
       [ui/panel-header {:title "Bridge sessions"}]
       (if (empty? bridges)
         [:p.federation-empty "No live bridge sessions reported."]
         [:ul.federation-list
          (for [{:keys [key label state detail]} bridges]
            ^{:key key} [:li [:strong label] [:span state] [:small detail]])])]
      [ui/card {:variant "elevated" :padding "md" :style {:min-height "100%"}}
       [ui/panel-header {:title "Routing"}] [kv routing-rows]]
      [:div.federation-card.federation-card-wide
       [ui/card {:variant "elevated" :padding "md"}
        [ui/panel-header {:title "Account knowledge"}]
        [ui/tabs {:default-value "local" :variant "enclosed"
                  :items (mapv (fn [t] {:id (:id t) :label (:label t) :badge (:badge t)
                                        :content (ui/element [knowledge-tab t])})
                               knowledge-tabs)}]
        (when last-sync [:div.federation-sync-result last-sync])]]]

     [:article.federation-card.panel-sheen.federation-card-wide
      [ui/panel-header {:title "Recent routed requests"}]
      (if (empty? routed)
        [:p.federation-empty "No routed federation or bridge requests captured in the recent request log sample."]
        [:ul.federation-list
         (for [{:keys [id title detail meta]} routed]
           ^{:key id} [:li [:strong title] [:span detail] [:small meta]])])]

     [:article.federation-card.panel-sheen.federation-card-wide
      [ui/panel-header {:title "Peers" :description "Register and sync peers without shell gymnastics."}]
      (when (empty? peers) [:p.federation-empty "No peers registered for this owner subject."])
      (when (seq peers)
        [:div.federation-peer-grid
         (for [{:keys [id label status badge rows sync-text]} peers]
           ^{:key id}
           [:article.federation-peer-card
            [:div.federation-peer-title-row [:h4 label] [ui/badge {:variant badge} status]]
            [kv rows]
            [:div.federation-peer-actions
             [ui/button {:type "button" :size "sm" :on-click #(dispatch! [:federation/sync id])} "Sync pull"]
             [:small sync-text]]])])]

     [:article.federation-card.panel-sheen.federation-card-wide
      [ui/panel-header {:title "Add peer"}]
      [:form.federation-form {:on-submit (fn [e] (.preventDefault e) (dispatch! [:federation/submit]))}
       [form-input dispatch! form :ownerCredential "Owner credential"
        {:type "password" :placeholder "admin key or DID used to derive owner subject" :required true}]
       [form-input dispatch! form :label "Label" {:type "text" :placeholder "Big Ussy Cephalon Proxx" :required true}]
       [form-input dispatch! form :baseUrl "Base URL" {:type "url" :placeholder "http://big.ussy.promethean.rest:8789" :required true}]
       [form-input dispatch! form :controlBaseUrl "Control base URL" {:type "url" :placeholder "optional separate control plane URL"}]
       [form-input dispatch! form :peerDid "Peer DID" {:type "text" :placeholder "did:web:big.ussy.promethean.rest"}]
       [form-input dispatch! form :authCredential "Auth credential" {:type "password" :placeholder "peer admin token / bearer credential"}]
       [:div.federation-form-actions
        [ui/button {:type "submit" :variant "primary" :loading submitting?} (if submitting? "Adding…" "Add peer")]]]]]))
