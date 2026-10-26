(ns proxx.web.update
  "The whole console as `(db, event) -> [db' effects]`.

  Pages are descriptors `{:init :enter :leave :handlers}` (see the page
  namespaces); the root merges their handler tables. Entering a page resets its
  slice (like a React remount), preserving persisted preferences in `:stored`."
  (:require [proxx.web.pages.events :as events]
            [proxx.web.pages.hosts :as hosts]
            [proxx.web.pages.images :as images]
            [proxx.web.pages.tools :as tools]
            [proxx.web.router :as router]
            [proxx.web.shell :as shell]))

(def pages
  {:tools tools/page
   :images images/page
   :hosts hosts/page
   :events events/page})

(def handlers
  (into shell/handlers (mapcat (comp :handlers val)) pages))

(defn init-db
  "Initial db from edge facts: `:stored` (localStorage mirror), `:token`, `:path`."
  [{:keys [stored token path]}]
  {:stored (or stored {})
   :route {:path path :page (router/match-page path)}
   :shell (shell/init stored token)
   :pages (into {} (map (fn [[id p]] [id ((:init p))])) pages)})

(defn- leave [db page-id]
  (if-let [f (get-in pages [page-id :leave])] (f db) []))

(defn- enter [db page-id]
  (let [db (assoc-in db [:pages page-id] ((get-in pages [page-id :init])))]
    (if-let [f (get-in pages [page-id :enter])] (f db) [db []])))

(defn- route-changed [db [_ path]]
  (let [old (get-in db [:route :page])
        new-page (router/match-page path)
        db (assoc db :route {:path path :page new-page})
        leave-fx (leave db old)]
    (if (contains? pages new-page)
      (let [[db' enter-fx] (enter db new-page)] [db' (into leave-fx enter-fx)])
      [db leave-fx])))

(defn- navigate [db [_ path]]
  (let [[db' fx*] (route-changed db [:route/changed path])]
    [db' (into [[:nav/push path]] fx*)]))

(defn- started
  "Boot: load tenant settings and enter the initial page."
  [db _]
  (let [page (get-in db [:route :page])
        [db' enter-fx] (if (contains? pages page) (enter db page) [db []])]
    [db' (into (shell/start db) enter-fx)]))

(defn handle
  "Total: unknown events are ignored."
  [db event]
  (case (first event)
    :app/started (started db event)
    :app/ignore [db []]
    :route/changed (route-changed db event)
    :route/navigate (navigate db event)
    (if-let [h (get handlers (first event))]
      (h db event)
      [db []])))
