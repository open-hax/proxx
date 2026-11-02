(ns proxx.runtime.pheromone-store
  "Edge of the provider-route pheromone store (`src/lib/provider-route-pheromone-store.ts`):
  one atom of records (pure data, `proxx.routing.pheromone`), a promise chain that
  serialises mutations, a debounced write-behind to one JSON file.

  Persistence contract: the file is `JSON.stringify({records}, null, 2) + \"\\n\"`,
  written to `<file>.tmp` and renamed into place; persisting is best-effort (a
  failing filesystem never reaches the proxy); `close` persists whatever is
  pending."
  (:require ["node:fs" :as fs]
            ["node:path" :as path]
            [proxx.routing.pheromone :as pheromone]
            [proxx.runtime.aco :as aco]
            [proxx.runtime.interop :as interop]))

(defn- file-text [records]
  (str (js/JSON.stringify #js {"records" (aco/records->js records)} nil 2) "\n"))

(defn- write-file! [file-path records]
  (let [p (.-promises fs)
        tmp (str file-path ".tmp")]
    (-> (.mkdir p (.dirname path file-path) #js {"recursive" true})
        (.then (fn [_] (.writeFile p tmp (file-text records) "utf8")))
        (.then (fn [_] (.rename p tmp file-path))))))

(defn create-provider-route-pheromone-store-js
  "The facade `ProviderRoutePheromoneStore` forwards to."
  ([file-path] (create-provider-route-pheromone-store-js file-path 250))
  ([file-path persist-interval-ms]
   (let [cache (atom nil)            ; vector of records once loaded
         mutation-chain (atom (js/Promise.resolve))
         persist-chain (atom (js/Promise.resolve))
         timer (atom nil)
         pending (atom false)
         closed (atom false)
         read-db!
         (fn ^:async read-db []
           (or @cache
               (let [records (try
                               (let [contents (await (.readFile (.-promises fs) file-path "utf8"))]
                                 (pheromone/hydrate-db (interop/js->data (js/JSON.parse contents)) (js/Date.now)))
                               (catch :default _ []))]
                 (reset! cache records)
                 records)))
         queue-persist!
         (fn ^:async queue-persist [force?]
           (when (or @pending force?)
             (reset! pending false)
             (reset! persist-chain
                     (.then @persist-chain
                            (fn ^:async persist-once [_]
                              (try (await (write-file! file-path (await (read-db!))))
                                   (catch :default _ nil)))))
             (await @persist-chain)))
         schedule-persist!
         (fn []
           (when-not @closed
             (reset! pending true)
             (when-not @timer
               (if (zero? persist-interval-ms)
                 (queue-persist! false)
                 (let [t (js/setTimeout (fn [] (reset! timer nil) (queue-persist! false)) persist-interval-ms)]
                   (some-> ^js t .unref)
                   (reset! timer t)))))
           ;; Fire and forget: a mutation never waits for the write (the promise `queue-persist!`
           ;; returns must not leak out as this function's value).
           nil)
         mutate!
         (fn [f]
           (let [result (.then @mutation-chain
                               (fn ^:async apply-mutation [_]
                                 (reset! cache (f (await (read-db!))))
                                 (schedule-persist!)))]
             (reset! mutation-chain (.then result (fn [_] nil) (fn [_] nil)))
             result))]
     #js {"warmup" (fn ^:async warmup [] (await (read-db!)) nil)

          "getPheromone" (fn [provider-id model]
                           (pheromone/pheromone (or @cache []) provider-id model))

          "noteSuccess" (fn [provider-id model quality]
                          (if (pheromone/key-valid? provider-id model)
                            (mutate! #(pheromone/note-success % provider-id model quality (js/Date.now)))
                            (js/Promise.resolve)))

          "noteFailure" (fn [provider-id model]
                          (if (pheromone/key-valid? provider-id model)
                            (mutate! #(pheromone/note-failure % provider-id model (js/Date.now)))
                            (js/Promise.resolve)))

          "close" (fn ^:async close []
                    (reset! closed true)
                    (when-let [t @timer] (js/clearTimeout t) (reset! timer nil))
                    (await @mutation-chain)
                    (try
                      (when @pending (await (queue-persist! true)))
                      (await @persist-chain)
                      (catch :default _ nil)))})))
