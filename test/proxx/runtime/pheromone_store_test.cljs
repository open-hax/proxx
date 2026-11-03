(ns proxx.runtime.pheromone-store-test
  (:require ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [proxx.runtime.pheromone-store :as ps]))

(defn- tmp-file [] (.join path (.mkdtempSync fs (.join path (.tmpdir os) "proxx-pher-")) "nested" "p.json"))

(deftest ^:async persists-through-close-and-rehydrates
  (let [file (tmp-file)
        ^js store (ps/create-provider-route-pheromone-store-js file 0)]
    (await (.warmup store))
    (is (= 0.5 (.getPheromone store "ollama-a" "q")))
    (await (.noteSuccess store " Ollama-A " "Q" 0.9))
    (await (.noteFailure store "x" ""))             ; blank model: ignored
    (await (.close store))
    (let [text (.readFileSync fs file "utf8")
          parsed (js/JSON.parse text)]
      (is (= (str (js/JSON.stringify parsed nil 2) "\n") text) "pretty-printed, trailing newline")
      (is (= 1 (.. parsed -records -length)))
      (is (= ["providerId" "model" "pheromone" "successCount" "failureCount" "updatedAt"]
             (vec (js/Object.keys (aget (.-records parsed) 0)))) "persisted key order")
      (is (not (.existsSync fs (str file ".tmp"))))
      (let [^js reopened (ps/create-provider-route-pheromone-store-js file 0)]
        (await (.warmup reopened))
        (is (> (.getPheromone reopened "ollama-a" "q") 0.5))
        (await (.close reopened))))))

(deftest ^:async unreadable-file-means-empty
  (let [file (tmp-file)]
    (.mkdirSync fs (.dirname path file) #js {:recursive true})
    (.writeFileSync fs file "not json")
    (let [^js store (ps/create-provider-route-pheromone-store-js file 0)]
      (await (.warmup store))
      (is (= 0.5 (.getPheromone store "a" "b")))
      (await (.close store)))))

(deftest ^:async a-mutation-does-not-wait-for-the-write
  ;; Regression: the promise of the write-behind leaked out as the mutation's value, so every
  ;; `noteSuccess` (awaited in the attempt executor before the affinity note) waited for the disk.
  (let [file (tmp-file)
        ^js store (ps/create-provider-route-pheromone-store-js file 0)]
    (await (.warmup store))
    (await (.noteSuccess store "p" "m" 1))
    (is (not (.existsSync fs file)) "resolved before the file was written")
    (await (.close store))
    (is (.existsSync fs file) "close persists what is pending")))

(deftest ^:async persists-success-and-failure-updates
  ;; src/tests/provider-route-pheromone-store.test.ts
  (let [file (tmp-file)
        ^js store (ps/create-provider-route-pheromone-store-js file 0)]
    (await (.warmup store))
    (is (= 0.5 (.getPheromone store "ollama-a" "qwen3.5:2b-bf16")))
    (await (.noteSuccess store "ollama-a" "qwen3.5:2b-bf16" 0.9))
    (let [boosted (.getPheromone store "ollama-a" "qwen3.5:2b-bf16")]
      (is (> boosted 0.5))
      (await (.noteFailure store "ollama-a" "qwen3.5:2b-bf16"))
      (let [reduced (.getPheromone store "ollama-a" "qwen3.5:2b-bf16")]
        (is (< reduced boosted))
        (await (.close store))
        (let [^js reopened (ps/create-provider-route-pheromone-store-js file 0)]
          (await (.warmup reopened))
          (is (= reduced (.getPheromone reopened "ollama-a" "qwen3.5:2b-bf16")))
          (await (.close reopened)))))))
