(ns proxx.runtime.quota-monitor
  "Stateful edge of the quota monitor: one atom holding the immutable state, the
  background timers, and the health-store / cooldown / logger side effects that
  proxx.quota.monitor asks for. Returns a JS object with the QuotaMonitor
  methods callers already use.

  Collaborators (credential store, logger, health store, cooldown controller)
  are host objects passed in; the manifest path locates the quota profile."
  (:require [proxx.jsval :as j]
            [proxx.quota.monitor :as monitor]
            [proxx.runtime.quota :as quota]))

(def ^:private initial-check-delay-ms 10000)

(defn- config-of
  "Defaults overlaid by the JS config object. A key that is present overrides its
  default even when undefined, as an object spread would."
  [js-config]
  (let [given (js->clj (or js-config #js {}))
        pick (fn [k default] (if (contains? given k) (get given k) default))
        d monitor/default-config]
    {:check-interval-ms (pick "checkIntervalMs" (:check-interval-ms d))
     :batch-size (pick "batchSize" (:batch-size d))
     :provider-id (pick "providerId" (:provider-id d))
     :warning-threshold (pick "quotaWarningThreshold" (:warning-threshold d))
     :critical-threshold (pick "quotaCriticalThreshold" (:critical-threshold d))}))

(defn quota-monitor-default-config-js []
  (let [{:keys [check-interval-ms batch-size provider-id warning-threshold critical-threshold]} monitor/default-config]
    #js {:checkIntervalMs check-interval-ms :batchSize batch-size :providerId provider-id
         :quotaWarningThreshold warning-threshold :quotaCriticalThreshold critical-threshold}))

(defn- record->js [{:keys [account-id provider-id five-hour-used-percent weekly-used-percent five-hour-resets-at
                           five-hour-reset-after-seconds weekly-resets-at weekly-reset-after-seconds exhausted? fetched-at]}]
  #js {:accountId account-id :providerId provider-id
       :fiveHourUsedPercent five-hour-used-percent :weeklyUsedPercent weekly-used-percent
       :fiveHourResetsAt five-hour-resets-at :fiveHourResetAfterSeconds five-hour-reset-after-seconds
       :weeklyResetsAt weekly-resets-at :weeklyResetAfterSeconds weekly-reset-after-seconds
       :isExhausted exhausted? :fetchedAt fetched-at})

(defn- undefined-if-nil [x] (if (nil? x) js/undefined x))

(defn- unref-timer [^js t] (when (fn? (.-unref t)) (.unref t)) t)

(defn create-quota-monitor-js
  "Build a quota monitor. `config` is the partial QuotaMonitorConfig object."
  [manifest-path credential-store ^js logger config ^js health-store ^js cooldown-controller]
  (let [cfg (config-of config)
        provider-id (:provider-id cfg)
        state (atom monitor/empty-state)
        timer (atom nil)
        stopped (atom false)
        now #(js/Date.now)
        log! (fn [level obj msg] (.call (aget logger level) logger obj msg))
        run-effect! (fn [[kind provider account arg]]
                      (case kind
                        :quota-exhausted (when health-store (.recordQuotaExhausted health-store provider account arg))
                        :set-cooldown (when cooldown-controller (.setAccountCooldownUntil cooldown-controller provider account arg))
                        :quota-reset (when health-store (.resetQuotaExhausted health-store provider account))
                        :clear-cooldown (when cooldown-controller (.clearAccountCooldown cooldown-controller provider account))
                        :log-reset (log! "info" #js {:accountId provider :usedPercent (case account :null nil :undefined js/undefined account)}
                                         "quota-monitor: detected quota reset, resetting account health")))
        ;; Commit the state, then run the snapshot's effects: an effect that throws
        ;; leaves earlier snapshots applied, as the mutable original did.
        apply! (fn [snapshot]
                 (let [{:keys [record warning? effects] :as r} (monitor/apply-snapshot @state snapshot cfg (now))]
                   (reset! state (:state r))
                   (doseq [e effects] (run-effect! e))
                   {:record record :warning? warning?}))
        fetch-snapshots (fn [account-id]
                          (let [o #js {:providerId provider-id :fetchFn (.-fetch js/globalThis)}]
                            (when account-id (aset o "accountId" account-id))
                            (quota/fetch-openai-quota-snapshots manifest-path credential-store o)))
        check-quotas (fn ^:async check-quotas []
                       (let [snapshots (await (fetch-snapshots nil))
                             {:keys [checked exhausted warning reset new-exhausted]}
                             (loop [[snapshot & more] (:accounts snapshots)
                                    acc {:checked 0 :exhausted 0 :warning 0 :reset 0 :new-exhausted #{}}]
                               (if-not snapshot
                                 acc
                                 (let [previous (get-in @state [:statuses (:account-id snapshot)])
                                       {:keys [record warning?]} (apply! snapshot)]
                                   (recur more
                                          (cond-> (update acc :checked inc)
                                            (:exhausted? record) (-> (update :exhausted inc)
                                                                     (update :new-exhausted conj (:account-id snapshot)))
                                            (and (not (:exhausted? record)) warning?) (update :warning inc)
                                            (and (:exhausted? previous) (not (:exhausted? record))) (update :reset inc))))))]
                         (swap! state assoc :exhausted new-exhausted)
                         (when (pos? checked)
                           (log! "info" #js {:checked checked :exhausted exhausted :warning warning :reset reset}
                                 "quota-monitor: quota check completed"))
                         js/undefined))]
    #js {:start
         (fn []
           (when-not @timer
             (reset! stopped false)
             (log! "info" #js {:intervalMs (:check-interval-ms cfg)} "quota-monitor: starting background quota checking")
             (reset! timer
                     (unref-timer
                      (js/setInterval
                       (fn ^:async tick []
                         (when-not @stopped
                           (try (await (check-quotas))
                                (catch :default e
                                  (log! "error" #js {:error (str e)} "quota-monitor: background quota check failed")))))
                       (:check-interval-ms cfg))))
             (js/setTimeout
              (fn []
                (when-not @stopped
                  (.catch (check-quotas)
                          (fn [e] (log! "error" #js {:error (str e)} "quota-monitor: initial quota check failed")))))
              initial-check-delay-ms)
             js/undefined))
         :stop
         (fn []
           (reset! stopped true)
           (when-let [t @timer] (js/clearInterval t) (reset! timer nil))
           js/undefined)
         :checkQuotas (fn [] (check-quotas))
         :refreshAccountQuota
         (fn ^:async refresh [account-id]
           (let [id (j/trim account-id)]
             (if (seq id)
               (let [snapshots (await (fetch-snapshots id))]
                 (if-let [snapshot (first (:accounts snapshots))]
                   (record->js (:record (apply! snapshot)))
                   (undefined-if-nil (some-> (get-in @state [:statuses id]) record->js))))
               js/undefined)))
         :tracksProvider (fn [pid] (monitor/tracks-provider? cfg pid))
         :getQuotaStatus (fn [id] (undefined-if-nil (some-> (get-in @state [:statuses id]) record->js)))
         :getAllQuotaStatuses (fn [] (to-array (map record->js (monitor/all-records @state))))
         :isAccountExhausted (fn [id] (contains? (:exhausted @state) id))
         :markAccountExhausted (fn [id] (swap! state update :exhausted conj id) js/undefined)
         :getCooldownMs (fn [id] (undefined-if-nil (monitor/exhausted-cooldown-ms (get-in @state [:statuses id]) (now))))
         :getCooldownMsFromQuota
         (fn [id] (undefined-if-nil (some-> (get-in @state [:statuses id]) (monitor/cooldown-ms (now)))))}))
