(ns proxx.epoch
  "Epoch timestamps arrive as seconds or milliseconds depending on the issuer.")

(def ^:private first-millisecond-epoch
  "Anything below this (2001-09-09 in ms; 33658 AD in s) is a seconds value."
  1000000000000)

(defn normalize-epoch-ms
  "Milliseconds since the epoch for a finite number given in seconds or
  milliseconds, truncated to a whole number; nil for anything else."
  [value]
  (when (and (number? value)
             #?(:cljs (js/Number.isFinite value)
                :clj (not (or (Double/isNaN (double value)) (Double/isInfinite (double value))))))
    (let [whole (long (if (neg? value) (Math/ceil value) (Math/floor value)))]
      (if (< whole first-millisecond-epoch) (* whole 1000) whole))))
