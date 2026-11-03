(ns proxx.compat.wire
  "Tolerant readers for untrusted, string-keyed wire data shared by the
  protocol-translation namespaces. Each returns nil rather than throwing, so
  call sites compose with `or` / `some->` instead of type-checking by hand."
  (:require [proxx.json :as json]))

(defn nes
  "`x` when it is a non-empty string, else nil."
  [x]
  (when (and (string? x) (seq x)) x))

(defn first-nes
  "First non-empty string among `xs`."
  [& xs]
  (some nes xs))

(defn str-or
  "`x` when it is a string (even empty), else `default`."
  [x default]
  (if (string? x) x default))

(defn finite-number [x]
  (when (and (number? x)
             #?(:cljs (js/Number.isFinite x)
                :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x))))))
    x))

(defn as-map [x] (when (map? x) x))

(defn stringify
  "Strings as themselves, everything else as JSON."
  [x]
  (if (string? x) x (json/write x)))

(defn now-seconds [now-ms]
  (long (Math/floor (/ now-ms 1000))))
