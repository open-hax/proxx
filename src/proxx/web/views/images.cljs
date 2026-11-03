(ns proxx.web.views.images
  (:require [proxx.web.pages.images :as images]
            [proxx.web.ui :as ui]))

(defn view [db dispatch!]
  (let [{:keys [model prompt urls raw sending? error button-label no-data? waiting?]} (images/view-model db)]
    [:div.tools-layout
     [:section.tools-panel
      [:header [:h2 "Images"] [:p "OpenAI-compatible image generation (POST /v1/images/generations)."]]
      [:form.chat-input-form {:on-submit (fn [e] (.preventDefault e) (dispatch! [:images/submit]))}
       [ui/input {:value model :on-change #(dispatch! [:images/model-changed (ui/event-value %)])
                  :placeholder "model (e.g. gpt-image-1)"}]
       [ui/textarea {:value prompt :rows 4 :on-change #(dispatch! [:images/prompt-changed (ui/event-value %)])
                     :placeholder "prompt"}]
       [ui/button {:type "submit" :variant "primary" :loading sending?} button-label]]
      (when error [:p.error-text error])
      (when (seq urls)
        [:div.credentials-provider-grid
         (for [url urls]
           ^{:key url}
           [ui/card {:variant "outlined" :padding "sm"}
            [:img {:src url :alt "generated" :style {:width "100%" :border-radius 12}}]])])
      (when no-data? [:p.status-text "No image data found in response payload."])]
     [:section.tools-panel
      [:header [:h2 "Raw response"]
       [:p "Rendered from the proxied upstream response (useful for debugging provider quirks)."]]
      (when waiting? [ui/spinner {:size "md" :label "Waiting for image response…"}])
      [ui/textarea {:read-only true :value raw :rows 24 :placeholder "(response will appear here)"}]]]))
