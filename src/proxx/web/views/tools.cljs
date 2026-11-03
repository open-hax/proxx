(ns proxx.web.views.tools
  (:require [proxx.web.pages.tools :as tools]
            [proxx.web.ui :as ui]))

(defn view [db dispatch!]
  (let [{:keys [model error tools servers]} (tools/view-model db)]
    [:div.tools-layout
     [:section.tools-panel
      [:header
       [:h2 "Tool Manager"]
       [:p "Seeded from OpenCode defaults. GPT-family models use `apply_patch` policy."]]

      [:form.tools-model-form {:on-submit (fn [e] (.preventDefault e) (dispatch! [:tools/submit]))}
       [ui/input {:value model
                  :on-change #(dispatch! [:tools/model-changed (ui/event-value %)])
                  :placeholder "model id"}]
       [ui/button {:type "submit"} "Refresh"]]

      [:div.tools-grid
       (for [{:keys [id description card-variant badge-variant badge-text]} tools]
         ^{:key id}
         [ui/card {:variant card-variant}
          [:header {:style {:display "flex" :justify-content "space-between" :align-items "center"}}
           [:strong id]
           [ui/badge {:variant badge-variant} badge-text]]
          [:p description]])]]

     [:section.tools-panel
      [:header
       [:h2 "MCP Manager"]
       [:p "Seeded from PM2 ecosystem definitions; servers start as disconnected by default."]]

      [:div.mcp-grid
       (for [{:keys [id badge-variant badge-text cwd-line script-line port-line source-file]} servers]
         ^{:key id}
         [ui/card
          [:header {:style {:display "flex" :justify-content "space-between" :align-items "center"}}
           [:strong id]
           [ui/badge {:variant badge-variant} badge-text]]
          [:p cwd-line]
          [:p script-line]
          (when port-line [:p port-line])
          [:small source-file]])]]

     (when error [:p.error-text error])]))
