(ns proxx.http.params
  "JavaScript-faithful coercions for request values (query strings, JSON
  bodies) that the routes historically passed through `parseInt`, `String(x)`
  and truthiness checks. The wire contract depends on these accidents (e.g. a
  repeated query parameter arrives as an array and stringifies with commas), so
  they are named and pinned here rather than re-derived per route."
  (:require [clojure.string :as str]))

(def nan #?(:cljs js/NaN :clj Double/NaN))

(defn nan? [x] (and (number? x) (not= x x)))

(defn parse-int
  "Number.parseInt(s, 10): the leading base-10 integer of `s` (leading
  whitespace and a sign allowed) or NaN."
  [s]
  (if-let [[_ digits] (when (string? s) (re-find #"^\s*([+-]?\d+)" s))]
    #?(:cljs (js/parseInt digits 10)
       :clj (let [d (Double/parseDouble digits)] (if (< (Math/abs d) 9e15) (long d) d)))
    nan))

(defn js-string
  "String(x) for decoded JSON/query values: arrays join with commas (null and
  nested empties as empty), objects are \"[object Object]\", nil is \"null\"."
  [x]
  (cond (string? x) x
        (nil? x) "null"
        (map? x) "[object Object]"
        (sequential? x) (str/join "," (map #(if (nil? %) "" (js-string %)) x))
        :else (str x)))

(defn truthy-string?
  "JS truthiness of a query/body value that is expected to be a string: an
  empty string (and an absent value) is falsy; everything else present is truthy."
  [x]
  (and (some? x) (not= "" x)))
