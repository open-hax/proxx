(ns proxx.budget.store
  (:require [proxx.budget.law :as law]))

(defn- nonempty-string? [value]
  (and (string? value) (not (empty? value))))

(defn ^:async reserve-transaction!
  [^js tx queries scope-id request-id limits amount admitted-at]
  (await (.unsafe tx (:lock queries) #js [scope-id]))
  (let [rows (await (.unsafe tx (:usage queries) #js [scope-id admitted-at]))
        ^js row (aget rows 0)
        usage (when row
                {:daily-microusd (js/Number (.-daily_microusd row))
                 :monthly-microusd (js/Number (.-monthly_microusd row))})
        decision (law/admission limits usage amount)]
    (if (= :admit decision)
      (do
        (await (.unsafe tx (:insert queries) #js [request-id scope-id amount admitted-at]))
        {:status :admitted :reservation-id request-id :reserved-microusd amount})
      {:status decision})))

(defn ^:async reserve!
  "READ COMMITTED ensures a fresh usage snapshot after waiting for the scope
   lock, even when the connection defaults to REPEATABLE READ.
   SQL scope lock serializes usage read and reservation across all processes.
   Calendar ownership uses the caller's edge admission instant, not the lock
   acquisition time. Reused IDs fail their primary-key constraint instead of
   admitting twice."
  ([sql queries scope-id request-id limits amount]
   (reserve! sql queries scope-id request-id limits amount (.now js/Date)))
  ([^js sql queries scope-id request-id limits amount admitted-at]
  (if-not (and sql
               (every? nonempty-string? [scope-id request-id])
               (law/nonnegative-integer? amount)
               (law/nonnegative-integer? admitted-at))
    {:status :unavailable}
    (try
      (await (.begin sql "isolation level read committed"
                     (fn [tx]
                       (reserve-transaction! tx queries scope-id request-id limits amount admitted-at))))
      (catch :default _ {:status :unavailable})))))

(defn ^:async settle!
  "Only authoritative usage settles an admission. Unknown usage retains the
   original reservation indefinitely, including through process restarts."
  [^js sql queries scope-id reservation-id actual-microusd]
  (if-not (and sql
               (every? nonempty-string? [scope-id reservation-id])
               (law/nonnegative-integer? actual-microusd))
    {:status :unreconciled}
    (try
      (let [rows (await (.unsafe sql (:settle queries)
                                #js [reservation-id scope-id actual-microusd]))]
        (if (aget rows 0) {:status :settled} {:status :unchanged}))
      (catch :default _ {:status :unreconciled}))))


(defn ^:async snapshot! [^js sql queries scope-id]
  (when sql
    (try
      (let [rows (await (.unsafe sql (:snapshot queries) #js [scope-id]))
            ^js row (aget rows 0)]
        (when row
          {:dayUtc (.-day_utc row) :monthUtc (.-month_utc row)
           :dailyChargedMicrousd (js/Number (.-daily_charged_microusd row))
           :monthlyChargedMicrousd (js/Number (.-monthly_charged_microusd row))
           :heldMicrousd (js/Number (.-held_microusd row))
           :dailyCarriedMicrousd (js/Number (.-daily_carried_microusd row))
           :monthlyCarriedMicrousd (js/Number (.-monthly_carried_microusd row))
           :unresolvedCount (js/Number (.-unresolved_count row))}))
      (catch :default _ nil))))
