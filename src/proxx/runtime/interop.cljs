(ns proxx.runtime.interop
  "JS <-> data conversion for wire values.

  `js->clj` decides an object is a map by comparing its prototype constructor to
  Object, so any JSON object with an own `constructor` key (an alias table, a
  claims object, a provider payload) is silently returned unconverted. This
  reads own keys explicitly instead: arrays become vectors, objects string-keyed
  maps, null/undefined nil, everything else is left as it is.")

(defn js->data [x]
  (cond
    (nil? x) nil
    (js/Array.isArray x) (persistent! (reduce (fn [v e] (conj! v (js->data e))) (transient []) (array-seq x)))
    (= "object" (js* "typeof ~{}" x))
    (persistent! (reduce (fn [m k] (assoc! m k (js->data (aget x k)))) (transient {}) (js/Object.keys x)))
    :else x))
