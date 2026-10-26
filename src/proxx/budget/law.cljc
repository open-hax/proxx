(ns proxx.budget.law)

(defn nonnegative-integer? [value]
  (and (number? value)
       #?(:cljs (js/Number.isSafeInteger value)
          :clj (and (integer? value) (<= value 9007199254740991)))
       (<= 0 value)))

(defn- nonnegative-finite? [value]
  (and (number? value)
       #?(:cljs (js/Number.isFinite value) :clj (Double/isFinite (double value)))
       (<= 0 value)))

(defn reservation-microusd
  "Conservative token upper bounds at USD-per-million prices, rounded upward.
   A dollar per million tokens is one microdollar per token. Unknown/invalid
   prices or bounds must deny a paid request rather than silently price it free."
  [input-bound output-bound input-price output-price]
  (when (and (nonnegative-integer? input-bound)
             (nonnegative-integer? output-bound)
             (nonnegative-finite? input-price)
             (nonnegative-finite? output-price))
    (let [amount (#?(:cljs js/Math.ceil :clj (fn [x] (long (Math/ceil x))))
                  (+ (* input-bound input-price) (* output-bound output-price)))]
      (when (nonnegative-integer? amount) amount))))

(defn admission
  "Usage already includes unsettled reservations. Both policy limits apply.
   The storage adapter must serialize reading usage and inserting a reservation."
  [limits usage reservation]
  (let [day-limit (:daily-microusd limits)
        month-limit (:monthly-microusd limits)
        day-used (:daily-microusd usage)
        month-used (:monthly-microusd usage)]
    (cond
      (not (every? nonnegative-integer?
                   [day-limit month-limit day-used month-used reservation])) :unavailable
      (> reservation (- day-limit day-used)) :daily-limit
      (> reservation (- month-limit month-used)) :monthly-limit
      :else :admit)))

(defn settled-charge
  "Retain the reserved upper bound when actual usage cannot be reconciled.
   Unexpected overruns remain visible and block subsequent admission."
  [reserved actual]
  (if (nonnegative-integer? actual) actual reserved))

(defn workload-free-before-paid?
  "Explicit-only routes are not workload candidates. For eligible workload
   routes, a terminal paid admission denial must never mask a later free route."
  [routes]
  (let [planned (remove #(= false (:plan? %)) routes)]
    (not-any? #(= :free (:billing %))
              (drop-while #(not= :paid (:billing %)) planned))))
