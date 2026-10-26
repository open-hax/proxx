(ns proxx.web.views.events
  (:require [proxx.web.pages.events :as events]
            [proxx.web.ui :as ui]))

(defn- filter-input [dispatch! label k value placeholder]
  [:label label
   [ui/input {:value value :placeholder placeholder
              :on-change #(dispatch! [:events/set-filter k (ui/event-value %)])}]])

(defn- detail [dispatch! {:keys [id header-meta rows tags payload-json meta-json]} tag-input]
  [:div.events-detail-card
   [:div.events-detail-header [:strong.events-mono id] [:small header-meta]]
   [:div.events-detail-meta
    (for [[label v] rows] ^{:key label} [:div [:strong label] " " [:span.events-mono v]])]
   [:div.events-detail-tags
    [:div.events-detail-tags-row
     (for [t tags]
       ^{:key t}
       [:button.events-tag-pill {:type "button" :on-click #(dispatch! [:events/remove-tag t])}
        [:span t] [:span.events-tag-pill-x "×"]])
     (when (empty? tags) [:span.events-muted "No tags"])]
    [:div.events-detail-tag-add
     [ui/input {:value tag-input :placeholder "add tag" :on-change #(dispatch! [:events/tag-input (ui/event-value %)])}]
     [ui/button {:variant "default" :on-click #(dispatch! [:events/add-tag])
                 :disabled (empty? (.trim (or tag-input "")))} "Add"]]]
   [:details {:open true} [:summary "payload"] [:pre.events-json payload-json]]
   [:details [:summary "meta"] [:pre.events-json meta-json]]])

(defn view [db dispatch!]
  (let [{:keys [filters offset limit loading? error can-prev? can-next? tag-summary rows selected-id
                selected-loading? tag-input] :as vm} (events/view-model db)
        dm (:detail vm)]
    [:div.events-page
     [ui/panel-header {:title "Events" :subtitle "Raw proxy events (request/response/error) from the SQL event store."}]
     [:div.events-controls
      [:div.events-filters
       [filter-input dispatch! "Kind" :kind (:kind filters) "request | response | error"]
       [filter-input dispatch! "Provider" :providerId (:providerId filters) "openai / ollama-cloud / …"]
       [filter-input dispatch! "Model" :model (:model filters) "gpt-4.1 / gemma4:31b / …"]
       [filter-input dispatch! "Tag" :tag (:tag filters) "label:train"]
       [filter-input dispatch! "Since" :since (:since filters) "2026-04-28"]
       [:div.events-filter-actions
        [ui/button {:variant "primary" :on-click #(dispatch! [:events/apply]) :disabled loading?} "Apply"]
        [ui/button {:variant "default" :on-click #(dispatch! [:events/clear]) :disabled loading?} "Clear"]]]
      [:div.events-pagination
       [:div.events-pagination-row
        [ui/button {:variant "default" :on-click #(dispatch! [:events/prev]) :disabled (or (not can-prev?) loading?)} "Prev"]
        [ui/button {:variant "default" :on-click #(dispatch! [:events/next]) :disabled (or (not can-next?) loading?)} "Next"]
        [:span.events-pagination-meta (:meta vm)]]
       [:label.events-limit "Limit"
        [ui/input {:value (str limit) :on-change #(dispatch! [:events/set-limit (ui/event-value %)])}]]]]
     (when tag-summary
       [:div.events-tag-summary
        [:div.events-tag-summary-header [:strong "Tag counts"] [:small (:since tag-summary)]]
        [:div.events-tag-summary-badges
         (for [{:keys [tag count]} (:pills tag-summary)]
           ^{:key tag}
           [:button.events-tag-summary-pill {:type "button" :on-click #(dispatch! [:events/pick-tag tag])}
            [:span tag] [ui/badge {:variant "default"} count]])]])
     (when error [:div.events-error error])
     [:div.events-grid
      [:section.events-list
       (if loading?
         [:div.events-loading [ui/spinner] " Loading events…"]
         [:table.events-table
          [:thead [:tr (for [h ["ts" "kind" "provider/account" "model" "status" "tags" "payload"]] ^{:key h} [:th h])]]
          [:tbody
           (for [{:keys [id selected? ts kind badge provider-account model status tags more-tags payload]} rows]
             ^{:key id}
             [:tr {:class (if selected? "events-row events-row-selected" "events-row")
                   :on-click #(dispatch! [:events/select id])}
              [:td.events-mono ts]
              [:td [ui/badge {:variant badge} kind]]
              [:td.events-mono provider-account]
              [:td.events-mono model]
              [:td.events-mono status]
              [:td.events-tags
               (for [t tags] ^{:key t} [ui/badge {:variant "default"} t])
               (when more-tags [:span.events-tags-more more-tags])]
              [:td.events-mono payload]])]])]
      [:aside.events-detail
       (cond
         (not selected-id) [:div.events-empty "Select an event to inspect its payload."]
         selected-loading? [:div.events-loading [ui/spinner] " Loading event…"]
         dm [detail dispatch! dm tag-input]
         :else [:div.events-empty "Failed to load event."])]]]))
