(ns proxx.runtime.chroma
  "JS facade over proxx.chroma.index for the TypeScript Chroma/Ollama classes,
  which keep the clients, fetch calls and the disabled latch."
  (:require [proxx.chroma.index :as idx]))

(defn- rethrow [f]
  (try (f)
       (catch :default e
         (throw (if (some? (ex-data e)) (js/Error. (ex-message e)) e)))))

(defn- ->jsobj [m]
  (let [o #js {}] (doseq [[k v] m] (aset o k v)) o))

(defn ollama-batch-vectors-js [payload expected-count]
  (rethrow #(to-array (map to-array (idx/batch-vectors (js->clj payload) expected-count)))))

(defn ollama-legacy-vector-js [payload]
  (rethrow #(to-array (idx/legacy-vector (js->clj payload)))))

(defn ollama-validate-config-js [config]
  (rethrow #(idx/validate-config (js->clj config)))
  js/undefined)

(defn ollama-build-config-js [config]
  (->jsobj (idx/build-config (js->clj config))))

(defn chroma-connection-options-js [^js url]
  (rethrow #(->jsobj (idx/connection-options {"protocol" (.-protocol url) "hostname" (.-hostname url) "port" (.-port url)}))))

(defn chroma-search-results-js [ids docs metas distances now]
  (to-array (map ->jsobj (idx/search-results (js->clj ids) (js->clj docs) (js->clj metas) (js->clj distances) now))))
