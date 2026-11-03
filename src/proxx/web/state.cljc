(ns proxx.web.state
  "Helpers over the single app-db map. Persisted UI preferences live in
  `(:stored db)` (mirror of localStorage); pages read them through `stored`
  and change them through `set-stored`, which also emits the write effect."
  (:require [proxx.web.fx :as fx]))

(defn stored
  "Validated stored value or default."
  [db k default validate]
  (let [v (validate (get-in db [:stored k]))]
    (if (nil? v) default v)))

(defn set-stored
  "`[db' fx]` pair fragment: update the mirror and persist."
  [db k v]
  [(assoc-in db [:stored k] v) [(fx/storage-write k v)]])

(defn page-slice [db page] (get-in db [:pages page]))
(defn update-page [db page f & args] (apply update-in db [:pages page] f args))
(defn assoc-page [db page & kvs] (apply update-in db [:pages page] assoc kvs))
