(ns proxx.routing.ordered
  "Insertion-ordered maps, as plain data. JavaScript objects keep key order and
  clojure maps beyond eight keys do not; where the order of a JS object's keys is
  observable (model catalogs, alias tables) the pure code carries an ordered map
  and the edge rebuilds the JS object entry by entry.")

(def empty-om {:ks [] :m {}})

(defn om-assoc
  "Set `k`; a key already present keeps its original position (JS object semantics)."
  [om k v]
  (if (contains? (:m om) k)
    (assoc-in om [:m k] v)
    (-> om (update :ks conj k) (assoc-in [:m k] v))))

(defn om-get [om k] (get (:m om) k))

(defn om-contains? [om k] (contains? (:m om) k))

(defn om-entries [om] (mapv (fn [k] [k (get (:m om) k)]) (:ks om)))

(defn om-keys [om] (:ks om))

(defn from-entries [entries] (reduce (fn [om [k v]] (om-assoc om k v)) empty-om entries))

(defn om-merge
  "Entries of `b` laid over `a`: new keys append, existing keys keep their place."
  [a b]
  (reduce (fn [om [k v]] (om-assoc om k v)) a (om-entries b)))
