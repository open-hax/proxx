(ns proxx.web.views.chat
  (:require [proxx.web.pages.chat :as chat]
            [proxx.web.ui :as ui]))

(defn- ->js-message [{:keys [timestamp-ms] :as m}]
  (cond-> (dissoc m :timestamp-ms)
    timestamp-ms (assoc :timestamp (js/Date. timestamp-ms))))

(defn view [db dispatch!]
  (let [{:keys [sessions title description has-active? model models sending? error search messages empty-title empty-text]}
        (chat/view-model db)]
    [:div.chat-layout
     [:aside.chat-sidebar
      [:div.chat-sidebar-header
       [:h2 "Sessions"]
       [ui/button {:type "button" :size "sm" :on-click #(dispatch! [:chat/new-session])} "New"]]
      [:form.chat-search-form {:on-submit (fn [e] (.preventDefault e) (dispatch! [:chat/search]))}
       [ui/input {:value (:query search) :placeholder "Semantic search history"
                  :on-change #(dispatch! [:chat/search-query (ui/event-value %)])}]
       [ui/button {:type "submit" :size "sm"} "Search"]]
      (when (seq (:results search))
        [:div.chat-search-results
         [:p "Search source: " [:strong (:source search)]]
         (for [{:keys [key session-id title content]} (:results search)]
           ^{:key key}
           [:button.chat-search-result {:type "button" :on-click #(dispatch! [:chat/load-session session-id])}
            [:strong title] [:span content]])])
      [:div.chat-session-list
       (for [{:keys [id title preview active?]} sessions]
         ^{:key id}
         [:button {:type "button"
                   :class (if active? "chat-session-item chat-session-item-active" "chat-session-item")
                   :on-click #(dispatch! [:chat/load-session id])}
          [:strong title] [:span preview]])]]

     [:section.chat-main
      [ui/panel-header
       {:title title
        :description description
        :actions (ui/element
                  [:<>
                   [:select {:value model :on-change #(dispatch! [:chat/set-model (ui/event-value %)])
                             :style {:padding "5px 10px" :border-radius "8px" :border "1px solid var(--border)"
                                     :background-color "var(--token-colors-surface-input)" :color "var(--text-main)"
                                     :font-size "0.82rem"}}
                    (for [o models] ^{:key o} [:option {:value o} o])]
                   [:div.chat-main-control-buttons
                    [ui/button {:type "button" :size "sm" :on-click #(dispatch! [:chat/refresh-models])} "Refresh models"]
                    [ui/button {:type "button" :size "sm" :variant "secondary" :disabled (not has-active?)
                                :on-click #(dispatch! [:chat/fork nil])} "Fork latest"]]])}]
      [ui/chat
       {:messages (mapv ->js-message messages)
        :on-send (fn [text] (dispatch! [:chat/send text]))
        :placeholder "Send a message..."
        :loading sending?
        :show-timestamps true
        :allow-markdown true
        :on-message-action (fn [action ^js message] (dispatch! [:chat/message-action action (.-id message)]))
        :empty-state (ui/element [:div.chat-empty-state [:h3 empty-title] [:p empty-text]])}]
      (when error [:p.chat-error error])]]))
