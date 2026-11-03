(ns proxx.support.tmp
  "Scratch directories, pinned clocks and captured console output for tests.
  Not a `*-test` namespace, so the node-test runner does not load it as tests."
  (:require ["node:fs/promises" :as fsp]
            ["node:os" :as os]
            ["node:path" :as path]))

(defn ^:async with-tmp-dir
  "Run async `f` with a fresh temporary directory path; always remove it."
  [prefix f]
  (let [dir (await (.mkdtemp fsp (.join path (.tmpdir os) prefix)))]
    (try
      (await (f dir))
      (finally
        (await (.rm fsp dir #js {:recursive true :force true}))))))

(defn ^:async with-json-file
  "Run async `f` with the path of a JSON file holding `payload` (a JS value)."
  [prefix payload f]
  (await (with-tmp-dir prefix
           (fn ^:async cb [dir]
             (let [file (.join path dir "keys.json")]
               (await (.writeFile fsp file (js/JSON.stringify payload nil 2) "utf8"))
               (await (f file)))))))

(defn ^:async with-now
  "Pin `Date.now` to the value in `clock` (an atom of ms) while async `f` runs."
  [clock f]
  (let [original (.-now js/Date)]
    (aset js/Date "now" (fn [] @clock))
    (try
      (await (f))
      (finally
        (aset js/Date "now" original)))))

(defn ^:async with-captured-console
  "Run async `f` with console method `method` (\"warn\"/\"error\"/...) recording
  its joined arguments into `sink` (an atom of strings)."
  [method sink f]
  (let [original (aget js/console method)]
    (aset js/console method (fn [& args] (swap! sink conj (apply str (interpose " " (map str args))))))
    (try
      (await (f))
      (finally
        (aset js/console method original)))))

(defn sleep [ms]
  (js/Promise. (fn [resolve _] (js/setTimeout resolve ms))))

(defn ^:async with-env
  "Set (string) or delete (nil) `process.env` entries from the map `values` while
  async `f` runs; the previous values are restored afterwards."
  [values f]
  (let [previous (into {} (map (fn [k] [k (aget js/process.env k)])) (keys values))]
    (doseq [[k v] values]
      (if (nil? v) (js-delete js/process.env k) (aset js/process.env k v)))
    (try
      (await (f))
      (finally
        (doseq [[k v] previous]
          (if (nil? v) (js-delete js/process.env k) (aset js/process.env k v)))))))
