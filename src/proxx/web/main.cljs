(ns proxx.web.main
  (:require [proxx.web.runtime :as rt]
            [proxx.web.views :as views]
            [reagent.core :as r]
            [reagent.dom.client :as rdc]))

(defonce ^:private root (atom nil))

(defn mount!
  "Render the console into `container` (an element)."
  [container]
  (let [r* (rdc/create-root container)]
    (reset! root r*)
    (rdc/render r* [views/app rt/db])))

(defn init []
  (let [container (.getElementById js/document "root")]
    (when-not container (throw (js/Error. "Missing root container")))
    (rt/init-db!)
    (rt/listen-popstate!)
    (mount! container)
    (rt/dispatch! [:app/started])))
