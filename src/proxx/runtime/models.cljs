(ns proxx.runtime.models
  "JS edge for src/lib/models.ts: reads models.json, hands the parsed document to
  proxx.routing.models, and turns ordered alias entries back into a JS object
  (entry by entry, so key order is the order the pure code computed)."
  (:require [proxx.runtime.interop :as interop]
            ["node:fs" :as fs]
            [proxx.routing.models :as models]))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn- read-document
  "{:raw clj-document :alias-entries [[k v]...]} for a models file, or nil when it
  does not exist. Other read/parse failures propagate unchanged."
  [file-path]
  (-> (.readFile (.-promises fs) file-path "utf8")
      (.then (fn [text]
               (let [^js parsed (js/JSON.parse text)
                     aliases (when (and (some? parsed) (not (js/Array.isArray parsed)) (= "object" (js* "typeof ~{}" parsed)))
                               (aget parsed "aliases"))]
                 {:raw (interop/js->data parsed)
                  :alias-entries (when (and (some? aliases) (not (js/Array.isArray aliases)) (= "object" (js* "typeof ~{}" aliases)))
                                   (interop/js->data (js/Object.entries aliases)))})))
      (.catch (fn [e] (if (= "ENOENT" (.-code e)) nil (throw e))))))

(defn- aliases->js [entries]
  (let [o #js {}]
    (doseq [[k v] entries] (aset o k v))
    o))

(defn- preferences->js [{:keys [preferred disabled aliases]}]
  #js {:preferred (to-array preferred) :disabled (to-array disabled) :aliases (aliases->js aliases)})

(defn- with-js-errors [f]
  (try (f) (catch :default e (rethrow-as-error e))))

(defn ^:async load-models-js [models-file-path fallback]
  (if-let [{:keys [raw]} (await (read-document models-file-path))]
    (to-array (with-js-errors #(models/load-models-result raw (interop/js->data fallback))))
    (to-array (interop/js->data fallback))))

(defn ^:async load-declared-models-js [models-file-path]
  (if-let [{:keys [raw]} (await (read-document models-file-path))]
    (to-array (with-js-errors #(models/normalize-declared-models raw)))
    (to-array [])))

(defn ^:async load-model-preferences-js [models-file-path fallback-preferred]
  (if-let [{:keys [raw alias-entries]} (await (read-document models-file-path))]
    (preferences->js (with-js-errors #(models/normalize-preferences raw (interop/js->data fallback-preferred) alias-entries)))
    (preferences->js {:preferred (interop/js->data fallback-preferred) :disabled [] :aliases []})))

(defn to-open-ai-model-js [model-id]
  (clj->js (models/openai-model model-id (js/Date.now))))
