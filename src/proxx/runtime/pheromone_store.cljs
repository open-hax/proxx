(ns proxx.runtime.pheromone-store
  "The provider-route pheromone file store: the record array and the debounced,
  serialised, atomic (write-temp-then-rename) persistence. What a success or
  failure does to the records is proxx.runtime.aco; the file format is
  `{\"records\": [...]}` pretty-printed with two spaces and a trailing newline.
  Persistence is best-effort: a failure never reaches the proxy."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [proxx.runtime.aco :as aco]))

(defn create-pheromone-store-js
  "A store backed by `file-path`; writes are batched for `persist-interval-ms` (default 250; 0 = at once)."
  [file-path persist-interval-ms]
  (let [interval (if (nil? persist-interval-ms) 250 persist-interval-ms)
        state (atom {:records nil :pending? false :closed? false :timer nil})
        mutation-chain (atom (js/Promise.resolve js/undefined))
        persist-chain (atom (js/Promise.resolve js/undefined))
        read-db (fn ^:async read-db []
                  (or (:records @state)
                      (let [records (try (aco/pheromone-hydrate-db-js (js/JSON.parse (await (.readFile fsp file-path "utf8"))))
                                         (catch :default _ #js []))]
                        (swap! state assoc :records records)
                        records)))
        queue-persist (fn ^:async queue-persist [force?]
                        (when (or (:pending? @state) force?)
                          (swap! state assoc :pending? false)
                          (reset! persist-chain
                                  (.then @persist-chain
                                         (fn ^:async write []
                                           (try
                                             (let [records (await (read-db))
                                                   temp (str file-path ".tmp")]
                                               (await (.mkdir fsp (.dirname path file-path) #js {:recursive true}))
                                               (await (.writeFile fsp temp (str (js/JSON.stringify #js {"records" records} nil 2) "\n") "utf8"))
                                               (await (.rename fsp temp file-path)))
                                             (catch :default _ nil)))))
                          (await @persist-chain)))
        schedule-persist (fn []
                           (when-not (:closed? @state)
                             (swap! state assoc :pending? true)
                             (when-not (:timer @state)
                               (if (zero? interval)
                                 (queue-persist false)
                                 (let [t (js/setTimeout (fn [] (swap! state assoc :timer nil) (queue-persist false)) interval)]
                                   (when (fn? (.-unref t)) (.unref t))
                                   (swap! state assoc :timer t))))))
        mutate (fn ^:async mutate [f]
                 (reset! mutation-chain
                         (.then @mutation-chain
                                (fn ^:async step []
                                  (let [records (await (read-db))]
                                    (swap! state assoc :records (f records))
                                    (schedule-persist)))))
                 (await @mutation-chain))]
    #js {:warmup (fn ^:async warmup [] (await (read-db)) js/undefined)
         :getPheromone (fn [provider-id model]
                         (aco/pheromone-get-js (or (:records @state) #js []) provider-id model))
         :noteSuccess (fn ^:async note-success [provider-id model quality]
                        (when (aco/pheromone-key-valid-js provider-id model)
                          (await (mutate (fn [records] (aco/pheromone-note-success-js records provider-id model quality)))))
                        js/undefined)
         :noteFailure (fn ^:async note-failure [provider-id model]
                        (when (aco/pheromone-key-valid-js provider-id model)
                          (await (mutate (fn [records] (aco/pheromone-note-failure-js records provider-id model)))))
                        js/undefined)
         :close (fn ^:async close []
                  (swap! state assoc :closed? true)
                  (when-let [t (:timer @state)] (js/clearTimeout t) (swap! state assoc :timer nil))
                  (await @mutation-chain)
                  (try
                    (when (:pending? @state) (await (queue-persist true)))
                    (await @persist-chain)
                    (catch :default _ nil))
                  js/undefined)}))
