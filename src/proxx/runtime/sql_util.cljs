(ns proxx.runtime.sql-util
  "Shared edge helpers for the SQL stores over a postgres.js client.

  Pure namespaces describe a statement as `{\"strings\" [...] \"values\" [...]}`
  (a tagged template taken apart) or `{\"text\" .. \"values\" ..}` (a `.unsafe`
  call); these functions run them. Rows and driver results stay JS values.")

(defn template-call
  "Run a tagged-template statement: `strings` are the literal parts, `values` the
  interpolations. postgres.js recognises a template by the `raw` property."
  [^js sql {:strs [strings values]}]
  (let [parts (to-array strings)]
    (aset parts "raw" (to-array strings))
    (.apply sql nil (.concat #js [parts] (to-array values)))))

(defn unsafe
  "`sql.unsafe(text, values)`; `values` is a seq or nil (no parameters)."
  ([^js sql text] (.unsafe sql text))
  ([^js sql text values] (.unsafe sql text (to-array values))))

(defn first-row [^js rows] (aget rows 0))

(defn rows->vec [^js rows] (vec (array-seq rows)))

(defn truthy?
  "JavaScript truthiness (0, \"\", NaN, null, undefined are false). Persisted
  columns were written under this rule, so Clojure's rule must not replace it."
  [x] (js* "!!(~{})" x))
