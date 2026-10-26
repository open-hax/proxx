(ns proxx.jsval
  "JavaScript-faithful value helpers for porting untrusted-wire parsing.

  Wire data is string-keyed maps. These helpers reproduce the observable
  semantics of the TypeScript guards they replace (`typeof x === \"string\"`,
  `Number.isFinite`, `??` skipping only null/undefined, `String.prototype.trim`,
  `Math.round`), so ported parsers agree with the originals on degenerate input.
  JVM branches exist only for completeness; the runtime is ClojureScript.")

(defn trim "String.prototype.trim." [s] #?(:cljs (.trim s) :clj (clojure.string/trim s)))
(defn lower "String.prototype.toLowerCase." [s] #?(:cljs (.toLowerCase s) :clj (clojure.string/lower-case s)))
(defn locale-compare "String.prototype.localeCompare." [a b] #?(:cljs (.localeCompare a b) :clj (compare a b)))

(defn finite? "Number.isFinite." [x]
  (and (number? x)
       #?(:cljs (js/Number.isFinite x)
          :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x)))))))

(defn as-string [x] (when (string? x) x))
(defn as-number [x] (when (finite? x) x))
(defn as-boolean [x] (when (boolean? x) x))

(defn rec
  "TypeScript's `isRecord` guard (`typeof x === \"object\" && x !== null`): a map
  is itself; an array counts as a record with no properties (every read is
  undefined), which matters when a fallback hangs off the guard; anything else is nil."
  [x]
  (cond (map? x) x
        (sequential? x) {}))

(defn first-non-nil
  "`a ?? b ?? c`: the first argument that is neither null nor undefined."
  [& xs]
  (reduce (fn [_ x] (when (some? x) (reduced x))) nil xs))

(defn truthy?
  "JavaScript truthiness (empty string, 0 and NaN are falsy, unlike in Clojure)."
  [v]
  (not (or (nil? v) (false? v) (= v "") (= v 0) (and (number? v) (not= v v)))))

(defn nes "`x` when it is a non-empty string." [x] (when (and (string? x) (seq x)) x))

(defn round "Math.round (ties toward +infinity)." [x] #?(:cljs (js/Math.round x) :clj (Math/round (double x))))

(defn js-number "Number(x) for a string." [s] #?(:cljs (js/Number s) :clj (try (Double/parseDouble s) (catch Exception _ ##NaN))))

(defn iso-string
  "new Date(ms).toISOString(); throws RangeError for out-of-range input like the original."
  [ms]
  #?(:cljs (.toISOString (js/Date. ms))
     :clj (throw (UnsupportedOperationException. "proxx.jsval/iso-string requires the ClojureScript runtime"))))

(defn parse-date-ms
  "new Date(s).getTime(), or nil when it is NaN."
  [s]
  #?(:cljs (let [t (.getTime (js/Date. s))] (when-not (js/isNaN t) t))
     :clj (throw (UnsupportedOperationException. "proxx.jsval/parse-date-ms requires the ClojureScript runtime"))))
