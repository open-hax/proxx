(ns proxx.runtime.sql-tag
  "Tagged-template calls of a postgres.js handle from CLJS. A statement is its
  literal pieces; `values` fill the holes between them, exactly as in
  sql`a ${x} b`. The pieces are persisted contracts: copy them verbatim.")

(defn tagged
  "The `strings` argument of a tagged template (an array carrying `raw`)."
  [pieces]
  (let [arr (to-array pieces)]
    (aset arr "raw" (to-array pieces))
    arr))

(defn exec
  "sql`pieces[0] ${v0} pieces[1] ...`; a Promise of the rows."
  [^js sql pieces & values]
  (.apply sql nil (to-array (cons (tagged pieces) values))))
