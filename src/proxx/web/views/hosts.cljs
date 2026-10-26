(ns proxx.web.views.hosts
  (:require [proxx.web.pages.hosts :as hosts]
            [proxx.web.ui :as ui]))

(def ^:private route-columns
  [{:key "host" :header "Host"} {:key "match" :header "Match"} {:key "upstream" :header "Upstream"}])

(defn- name-cell [^js row] (ui/element [:strong (.-name row)]))

(def ^:private container-columns
  [{:key "name" :header "Name" :render name-cell}
   {:key "image" :header "Image"} {:key "status" :header "Status"} {:key "ports" :header "Ports"}])

(defn- table [columns rows]
  [ui/data-table-shell {:columns columns :rows rows :dense true :sticky-header false
                        :row-key (fn [^js row _] (.-key row))}])

(defn- host-card [{:keys [id label self? pill subtitle stats last-error routes routes-meta containers containers-meta]}]
  [:article.hosts-card.panel-sheen
   [:header.hosts-card-header
    [:div
     [:div.hosts-card-title-row
      [:h3 label]
      (when self? [ui/badge {:variant "info"} "This console"])
      [ui/badge {:variant (:variant pill)} (:text pill)]]
     [:p subtitle]]
    [:div.hosts-card-stats
     [:div [:strong (:running stats)] [:span "running"]]
     [:div [:strong (:healthy stats)] [:span "healthy"]]
     [:div [:strong (:routes stats)] [:span "routes"]]]]
   (when last-error [:div.hosts-card-error last-error])
   [:div.hosts-card-body
    [:section.hosts-section
     [ui/panel-header {:title "Subdomains" :meta (ui/element [:small routes-meta])}]
     (if (empty? routes)
       [:div.hosts-section-empty "No routed subdomains detected."]
       [table route-columns routes])]
    [:section.hosts-section
     [ui/panel-header {:title "Containers" :meta (ui/element [:small containers-meta])}]
     (if (empty? containers)
       [:div.hosts-section-empty "No container data available."]
       [table container-columns containers])]]])

(defn view [db _dispatch!]
  (let [{:keys [hero-stats loading? error hosts]} (hosts/view-model db)]
    [:section.hosts-page
     [ui/surface-hero
      {:kicker "Host Fleet"
       :title "Promethean ussy host dashboard"
       :description "One view for container inventory and routed subdomains across the ussy hosts. Remote hosts stay visible even when access or auth is broken."
       :stats hero-stats}]
     (when loading? [:div.hosts-empty [ui/spinner {:size "md" :label "Loading host inventory…"}]])
     (when error [:div.hosts-empty.hosts-empty-error error])
     [:div.hosts-grid
      (for [h hosts] ^{:key (:id h)} [host-card h])]]))
