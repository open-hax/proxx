(ns proxx.runtime.routes.events
  "Event routes (src/routes/events). The store is a JS collaborator that may be
  absent; filters and tag parsing are proxx.http.events."
  (:require [proxx.http.events :as events]
            [proxx.http.guard :as guard]
            [proxx.runtime.ring :as ring]))

(defn- dates->js
  "Filter map -> the store's argument object (since/until become Dates)."
  [m]
  (clj->js (cond-> m
             (:since m) (update :since #(js/Date. %))
             (:until m) (update :until #(js/Date. %)))))

(defn routes
  [^js event-store]
  (let [need-store (fn [& msg] (when-not event-store (apply events/unavailable msg)))]
    [{:method :get :path "/api/v1/events"
      :handler (fn ^:async list-events [{:keys [query]}]
                 (or (need-store "Event store not available (no database connection)")
                     (let [found (await (.query event-store (dates->js (events/query-filter query))))
                           total (when (events/include-count? query)
                                   (await (.count event-store (dates->js (events/count-filter query)))))]
                       {:body (events/list-body found (.-length ^js found) total)})))}

     {:method :get :path "/api/v1/events/:id"
      :handler (fn ^:async get-event [{:keys [params]}]
                 (or (need-store)
                     (let [event (await (.getById event-store (get params "id")))]
                       (if event
                         {:body {"event" event}}
                         (guard/error 404 "Event not found")))))}

     {:method :get :path "/api/v1/events/tags"
      :handler (fn ^:async event-tags [_]
                 (or (need-store)
                     (let [since (js/Date. (- (js/Date.now) (* 7 24 60 60 1000)))
                           tags (await (.countByTag event-store since))]
                       {:body {"tags" tags "since" (.toISOString since)}})))}

     {:method :post :path "/api/v1/events/:id/tag"
      :handler (fn ^:async add-tag [{:keys [params body]}]
                 (or (need-store)
                     (let [[tag err] (events/tag-or-error body)]
                       (or err
                           (do (await (.addTag event-store (get params "id") tag))
                               {:body {"ok" true}})))))}

     {:method :delete :path "/api/v1/events/:id/tag"
      :handler (fn ^:async remove-tag [{:keys [params body]}]
                 (or (need-store)
                     (let [[tag err] (events/tag-or-error body)]
                       (or err
                           (do (await (.removeTag event-store (get params "id") tag))
                               {:body {"ok" true}})))))}]))

(defn register-event-routes-js [app ^js event-store]
  (ring/register! app (routes event-store)))
