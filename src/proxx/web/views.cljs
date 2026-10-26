(ns proxx.web.views
  "Reagent views: pure functions of the app-db (and `dispatch!`)."
  (:require [proxx.web.router :as router]
            [proxx.web.runtime :as rt]
            [proxx.web.shell :as shell]
            [proxx.web.ui :as ui]
            [proxx.web.views.analytics :as analytics-view]
            [proxx.web.views.chat :as chat-view]
            [proxx.web.views.events :as events-view]
            [proxx.web.views.federation :as federation-view]
            [proxx.web.views.hosts :as hosts-view]
            [proxx.web.views.images :as images-view]
            [proxx.web.views.tools :as tools-view]))

(defn nav-link [path-now {:keys [path label] :as route}]
  (let [active? (router/link-active? path-now route)]
    [:a (cond-> {:href path
                 :class (router/nav-class active?)
                 :on-click (fn [^js e]
                             (when (and (zero? (.-button e)) (not (or (.-metaKey e) (.-ctrlKey e) (.-shiftKey e) (.-altKey e))))
                               (.preventDefault e)
                               (rt/dispatch! [:route/navigate path])))}
          active? (assoc :aria-current "page"))
     label]))

(defn- header [{:keys [token-input unsaved? hint fast-mode? fast-saving? fast-message theme]}]
  [:header.shell-header
   [:div.shell-brand [:h1 "Proxx"]]
   [:div.shell-auth
    [:label {:for "proxy-token"} "Proxy Token"]
    [:div.shell-auth-row
     [:input {:id "proxy-token" :type "password" :value token-input
              :on-change #(rt/dispatch! [:shell/token-input (ui/event-value %)])
              :placeholder "Bearer token for /api and /v1"}]
     [:button {:type "button" :on-click #(rt/dispatch! [:shell/save-token]) :disabled (not unsaved?)} "Save"]]
    [:small hint]
    [:div.shell-settings-card
     [:label.toggle-row
      [:input {:type "checkbox" :checked fast-mode? :disabled fast-saving?
               :on-change #(rt/dispatch! [:shell/fast-toggle (ui/event-checked %)])}]
      "Fast mode (priority tier)"]
     [:label.toggle-row.shell-theme-row
      [:span "Theme"]
      [:select {:value theme :on-change #(rt/dispatch! [:shell/set-theme (ui/event-value %)])}
       [:option {:value "monokai"} "Monokai"]
       [:option {:value "night-owl"} "Night Owl"]]]
     (when fast-message [:small fast-message])]]])

(defn- onboarding [{:keys [show-onboarding? token-input onboarding-cta]}]
  [ui/modal {:open show-onboarding? :on-close #(rt/dispatch! [:shell/close-onboarding]) :size "sm"}
   [:h3 {:style {:margin "0 0 8px"}} "Welcome to Proxx"]
   [:p {:style {:margin "0 0 16px" :color "var(--text-muted)"}}
    "Set your proxy token to get started. You can change this later from the header."]
   [ui/input {:type "password" :value token-input
              :on-change #(rt/dispatch! [:shell/token-input (ui/event-value %)])
              :placeholder "Bearer token for /api and /v1"}]
   [:div {:style {:display "flex" :gap "8px" :margin-top "16px"}}
    [ui/button {:type "button" :variant "primary" :on-click #(rt/dispatch! [:shell/dismiss-onboarding])}
     onboarding-cta]]])

(def ^:private page-views
  {:tools tools-view/view
   :images images-view/view
   :hosts hosts-view/view
   :events events-view/view
   :chat chat-view/view
   :analytics analytics-view/view
   :federation federation-view/view})

(defn- placeholder [page]
  [:p.status-text (str "The " (name page) " page is being ported.")])

(defn app
  "Root view. `db-ref` is a reagent atom holding the app-db."
  [db-ref]
  (let [db @db-ref
        vm (shell/view-model db)
        path (get-in db [:route :path])
        page (get-in db [:route :page])
        view (get page-views page)]
    [ui/toast-provider {:position "top-right"}
     [ui/theme-provider {:theme (:theme vm) :as "div" :class "app-theme-root" :style {:min-height "100vh"}}
      [:div {:class (str "shell-root" (when (router/dashboard-path? path) " shell-root-dashboard"))}
       [header vm]
       [:nav.shell-nav
        (for [route router/routes] ^{:key (:path route)} [nav-link path route])]
       [:main.shell-main
        (if view [view db rt/dispatch!] [placeholder page])]
       [onboarding vm]]]]))
