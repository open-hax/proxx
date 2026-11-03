(ns proxx.runtime.account-health
  "Edge of the account health store: an atom with the pure health value
  (`proxx.credentials.health`), the pending-write queue, the flush timer, and
  the database. The JS facade keeps the method names of `AccountHealthStore`."
  (:require [proxx.credentials.health :as health]))


(defn- cred-ids [^js c] [(.-providerId c) (.-accountId c)])

(defn create-account-health-store-js
  "`sql` is the postgres client (only `.unsafe` is used); `select-all-sql` is
  the SELECT_ALL_ACCOUNT_HEALTH text from db/schema.ts (a persisted contract
  that stays in TypeScript)."
  [^js sql flush-interval-ms select-all-sql]
  (let [state (atom {})
        pending (atom [])
        timer (atom nil)
        initialized (atom false)
        now #(js/Date.now)
        enqueue! (fn [w] (swap! pending conj w))
        flush!
        (fn ^:async flush []
          (when (seq @pending)
            (let [writes @pending
                  _ (reset! pending [])]
              (loop [[[kind chunk] & more] (health/flush-plan writes)]
                (when kind
                  (try
                    (let [[text values] ((if (= kind :success) health/success-chunk-query health/failure-chunk-query)
                                         chunk (now))]
                      (await (.unsafe sql text (to-array values))))
                    (catch :default _ nil))
                  (recur more)))))
          js/undefined)
        start-timer!
        (fn []
          (when-not @timer
            (reset! timer (js/setInterval (fn [] (.catch (flush!) (fn [_] nil))) flush-interval-ms))))]
    #js {"init"
         (fn ^:async init []
           (when-not @initialized
             (try
               (let [rows (await (.unsafe sql select-all-sql))]
                 (doseq [row (array-seq rows)]
                   (let [h (health/parse-health-row (js->clj row))]
                     (swap! state assoc (health/health-key (:provider-id h) (:account-id h)) h))))
               (catch :default e
                 (if (= "42P01" (when (and (some? e) (= "object" (goog/typeOf e))) (.-code ^js e)))
                   nil
                   (do (js/console.error "AccountHealthStore.init failed" #js {"query" select-all-sql "error" e})
                       (throw e)))))
             (start-timer!)
             (reset! initialized true))
           js/undefined)

         "recordSuccess"
         (fn [credential status]
           (let [[p a] (cred-ids credential) t (now)]
             (swap! state health/record-success p a status t)
             (enqueue! {:type :success :provider-id p :account-id a :timestamp t :status status})
             js/undefined))

         "recordFailure"
         (fn [credential status error]
           (let [[p a] (cred-ids credential) t (now)]
             (swap! state health/record-failure p a status error t)
             (enqueue! {:type :failure :provider-id p :account-id a :timestamp t :status status :error error})
             js/undefined))

         "recordQuotaExhausted"
         (fn [p a used-percent] (swap! state health/record-quota-exhausted p a used-percent (now)) js/undefined)

         "getQuotaStatus"
         (fn [p a]
           (let [{:keys [exhausted-at used-percent]} (health/quota-status @state p a)]
             #js {"exhaustedAt" (if (some? exhausted-at) exhausted-at nil)
                  "usedPercent" (if (some? used-percent) used-percent nil)}))

         "isQuotaExhausted"
         (fn [p a cooldown-ms]
           (let [[exhausted? state'] (health/quota-exhausted? @state p a
                                                              (if (some? cooldown-ms) cooldown-ms health/default-quota-cooldown-ms)
                                                              (now))]
             (reset! state state')
             exhausted?))

         "getGrowingCooldown"
         (fn [p a base-ms]
           (let [[cooldown state'] (health/growing-cooldown @state p a base-ms (now))]
             (reset! state state')
             cooldown))

         "resetQuotaExhausted" (fn [p a] (swap! state health/reset-quota-exhausted p a) js/undefined)

         "getHealthScore" (fn [p a expires-at] (health/health-score @state p a (now) expires-at))

         "getAllHealthScores"
         (fn []
           (to-array (map (fn [{:keys [provider-id account-id score success-count failure-count]}]
                            #js {"providerId" provider-id "accountId" account-id "score" score
                                 "successCount" success-count "failureCount" failure-count})
                          (health/all-scores @state (now)))))

         "sortCredentialsByHealth"
         (fn [credentials]
           (let [t (now)]
             (->> (array-seq credentials)
                  (map (fn [^js c] [c (health/health-score @state (.-providerId c) (.-accountId c) t nil)]))
                  (sort-by second >)
                  (map first)
                  to-array)))

         "flushPendingWrites" flush!

         "close"
         (fn ^:async close []
           (when-let [t @timer] (js/clearInterval t) (reset! timer nil))
           (await (flush!))
           js/undefined)}))
