(ns proxx.runtime.pheromone-store-test
  (:require ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [cljs.test :refer [deftest is async]]
            [proxx.runtime.pheromone-store :as ps]))

(defn- tmp-file [] (.join path (.mkdtempSync fs (.join path (.tmpdir os) "proxx-pher-")) "nested" "p.json"))

(deftest persists-through-close-and-rehydrates
  (async done
    (let [file (tmp-file)
          ^js store (ps/create-provider-route-pheromone-store-js file 0)]
      (-> (.warmup store)
          (.then (fn [_]
                   (is (= 0.5 (.getPheromone store "ollama-a" "q")))
                   (.noteSuccess store " Ollama-A " "Q" 0.9)))
          (.then (fn [_] (.noteFailure store "x" "")))             ; blank model: ignored
          (.then (fn [_] (.close store)))
          (.then (fn [_]
                   (let [text (.readFileSync fs file "utf8")
                         parsed (js/JSON.parse text)]
                     (is (= (str (js/JSON.stringify parsed nil 2) "\n") text) "pretty-printed, trailing newline")
                     (is (= 1 (.. parsed -records -length)))
                     (is (= ["providerId" "model" "pheromone" "successCount" "failureCount" "updatedAt"]
                            (vec (js/Object.keys (aget (.-records parsed) 0)))) "persisted key order")
                     (is (not (.existsSync fs (str file ".tmp"))))
                     (let [^js reopened (ps/create-provider-route-pheromone-store-js file 0)]
                       (-> (.warmup reopened)
                           (.then (fn [_]
                                    (is (> (.getPheromone reopened "ollama-a" "q") 0.5))
                                    (.close reopened)))
                           (.then (fn [_] (done))))))))))))

(deftest unreadable-file-means-empty
  (async done
    (let [file (tmp-file)]
      (.mkdirSync fs (.dirname path file) #js {:recursive true})
      (.writeFileSync fs file "not json")
      (let [^js store (ps/create-provider-route-pheromone-store-js file 0)]
        (-> (.warmup store)
            (.then (fn [_]
                     (is (= 0.5 (.getPheromone store "a" "b")))
                     (.close store)))
            (.then (fn [_] (done))))))))

(deftest a-mutation-does-not-wait-for-the-write
  ;; Regression: the promise of the write-behind leaked out as the mutation's value, so every
  ;; `noteSuccess` (awaited in the attempt executor before the affinity note) waited for the disk.
  (async done
    (let [file (tmp-file)
          ^js store (ps/create-provider-route-pheromone-store-js file 0)]
      (-> (.warmup store)
          (.then (fn [_] (.noteSuccess store "p" "m" 1)))
          (.then (fn [_]
                   (is (not (.existsSync fs file)) "resolved before the file was written")
                   (.close store)))
          (.then (fn [_]
                   (is (.existsSync fs file) "close persists what is pending")
                   (done)))))))
