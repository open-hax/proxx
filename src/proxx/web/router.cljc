(ns proxx.web.router
  "Route table as data. Same paths, labels and order as the React console;
  unknown paths render the dashboard.
  Navigation is pure matching; `history` access lives in `proxx.web.runtime`."
  (:require [clojure.string :as str]))

(def routes
  [{:page :dashboard :path "/" :label "Dashboard" :end? true}
   {:page :chat :path "/chat" :label "Chat"}
   {:page :analytics :path "/analytics" :label "Analytics"}
   {:page :events :path "/events" :label "Events"}
   {:page :hosts :path "/hosts" :label "Hosts"}
   {:page :images :path "/images" :label "Images"}
   {:page :credentials :path "/credentials" :label "Credentials"}
   {:page :federation :path "/federation" :label "Federation"}
   {:page :tools :path "/tools" :label "Tools + MCP"}])

(defn normalize-path [path]
  (let [p (-> (or path "/") (str/replace #"[?#].*$" ""))]
    (if (and (> (count p) 1) (str/ends-with? p "/")) (subs p 0 (dec (count p))) (if (str/blank? p) "/" p))))

(defn match-page
  "Page id for `path` (unknown -> :dashboard)."
  [path]
  (let [p (normalize-path path)]
    (or (some (fn [{:keys [page path]}] (when (and (not= path "/") (or (= p path) (str/starts-with? p (str path "/")))) page)) routes)
        :dashboard)))

(defn dashboard-path? [path] (contains? #{"/" ""} (str path)))

(defn link-active?
  "NavLink semantics: `end?` routes match exactly, others match by segment prefix."
  [current-path {:keys [path end?]}]
  (let [p (normalize-path current-path)]
    (if end?
      (= p path)
      (or (= p path) (str/starts-with? p (str path "/"))))))

(defn nav-class [active?] (if active? "nav-link nav-link-active" "nav-link"))
