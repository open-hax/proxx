(ns proxx.runtime.mcp-seed
  "JS edge for src/lib/tool-mcp-seed.ts: lists an ecosystems directory and reads
  its .cljs files, then hands the text to proxx.mcp.seed."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [proxx.mcp.seed :as seed]))

(defn- ordered-js
  "A JS object with `m`'s entries in the order of `ks` (skipping absent ones)."
  [ks m]
  (let [o #js {}]
    (doseq [k ks :when (contains? m k)] (aset o (name k) (clj->js (get m k))))
    o))

(defn get-tool-seed-for-model-js [model-id]
  (let [out (array)]
    (doseq [tool (seed/tool-seed-for-model model-id)]
      (.push out (ordered-js [:id :description :enabled] tool)))
    out))

(defn ^:async load-mcp-seeds-js
  "Seeds for the MCP servers declared in `ecosystems-dir`'s .cljs files."
  [ecosystems-dir]
  (let [entries (await (.readdir fsp ecosystems-dir #js {:withFileTypes true}))
        files (->> (array-seq entries)
                   (filter (fn [^js e] (and (.isFile e) (.endsWith (.-name e) ".cljs"))))
                   (map (fn [^js e] (.-name e))))
        seeds (loop [files files acc []]
                (if-let [file-name (first files)]
                  (let [absolute (.join path ecosystems-dir file-name)
                        content (await (.readFile fsp absolute "utf8"))]
                    (recur (rest files)
                           (into acc (keep (fn [{:keys [name body]}] (seed/mcp-seed name body absolute)))
                                 (seed/defapp-blocks content))))
                  acc))
        out (array)]
    (doseq [s (seed/dedupe-and-sort seeds)]
      (.push out (ordered-js [:id :script :cwd :args :port :sourceFile :running]
                             (-> s (assoc :sourceFile (:source-file s)) (dissoc :source-file)))))
    out))
