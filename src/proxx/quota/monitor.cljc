(ns proxx.quota.monitor
  "Pure state machine of the OpenAI quota monitor.

  State is {:statuses {account-id record} :exhausted #{account-id} :order [account-id]}. Each
  operation returns data and the effects the edge must run (health-store writes,
  cooldown changes, log lines); nothing here reads the clock (`now-ms` is an
  argument), fetches, or notifies.

  Exhaustion trusts only OpenAI's explicit signals (`limit_reached` /
  `allowed=false`): a low remaining percentage does not exhaust an account,
  because in-flight conversations are allowed to finish."
  (:require [proxx.jsval :as j]))

(def default-config
  {:check-interval-ms (* 20 60 1000)
   :batch-size 10
   :provider-id "openai"
   :warning-threshold 90
   :critical-threshold 98})

(def empty-state
  "`:order` keeps first-seen account order, which `all-records` reports."
  {:statuses {} :exhausted #{} :order []})

(defn quota-status
  "{:five-hour-used-percent :weekly-used-percent :exhausted? :warning?} of a snapshot.
  A missing window borrows the other one's usage."
  [snapshot {:keys [warning-threshold]}]
  (let [five-used (get-in snapshot [:five-hour :used-percent])
        weekly-used (get-in snapshot [:weekly :used-percent])
        five (j/first-non-nil five-used weekly-used)
        weekly (j/first-non-nil weekly-used five)
        rate-limit (:rate-limit snapshot)
        exhausted? (or (true? (:limit-reached rate-limit)) (false? (:allowed rate-limit)))
        over? #(and (some? %) (>= % warning-threshold))]
    {:five-hour-used-percent five
     :weekly-used-percent weekly
     :exhausted? exhausted?
     :warning? (and (not exhausted?) (or (over? five) (over? weekly)))}))

(defn- remaining-until [iso now-ms]
  (when (seq iso)
    (let [t (j/parse-date-ms iso)]
      (when (and t (> (- t now-ms) 0)) (- t now-ms)))))

(defn cooldown-ms
  "How long a record's quota says to wait: the relative reset of the five-hour
  window, else the weekly one, else the time left until an absolute reset; nil
  when nothing positive is known. A relative reset of 0 is an answer (0), not a
  reason to look further."
  [{:keys [five-hour-reset-after-seconds weekly-reset-after-seconds five-hour-resets-at weekly-resets-at]} now-ms]
  (cond
    (some? five-hour-reset-after-seconds) (* five-hour-reset-after-seconds 1000)
    (some? weekly-reset-after-seconds) (* weekly-reset-after-seconds 1000)
    :else (or (remaining-until five-hour-resets-at now-ms)
              (remaining-until weekly-resets-at now-ms))))

(defn exhausted-cooldown-ms
  "`cooldown-ms`, but only for an account recorded as exhausted: healthy
  accounts carry reset windows too and a stray 429 must not turn them into
  multi-day cooldowns."
  [record now-ms]
  (when (and record (:exhausted? record)) (cooldown-ms record now-ms)))

(defn- record-of [snapshot status provider-id now-ms]
  {:account-id (:account-id snapshot)
   :provider-id provider-id
   :five-hour-used-percent (:five-hour-used-percent status)
   :weekly-used-percent (:weekly-used-percent status)
   :five-hour-resets-at (get-in snapshot [:five-hour :resets-at])
   :five-hour-reset-after-seconds (get-in snapshot [:five-hour :reset-after-seconds])
   :weekly-resets-at (get-in snapshot [:weekly :resets-at])
   :weekly-reset-after-seconds (get-in snapshot [:weekly :reset-after-seconds])
   :exhausted? (:exhausted? status)
   :fetched-at now-ms})

(defn apply-snapshot
  "Fold one account snapshot into the state.
  => {:state :record :warning? :effects}. Effects, in the order to run them:
     [:quota-exhausted provider account used-percent]
     [:set-cooldown provider account until-ms]   (only when quota names a positive wait)
     [:quota-reset provider account]
     [:clear-cooldown provider account]
     [:log-reset account log-used]"
  [state snapshot {:keys [provider-id] :as config} now-ms]
  (let [account-id (:account-id snapshot)
        previous (get-in state [:statuses account-id])
        status (quota-status snapshot config)
        record (record-of snapshot status provider-id now-ms)
        five-used (get-in snapshot [:five-hour :used-percent])
        weekly-used (get-in snapshot [:weekly :used-percent])
        used-percent (j/first-non-nil five-used weekly-used)
        ;; `a?.x ?? b?.x`: null when the last operand is a window with no usage, undefined when it is no window
        log-used (cond (some? used-percent) used-percent
                       (:weekly snapshot) :null
                       :else :undefined)
        state' (-> state
                   (update :order #(if (contains? (:statuses state) account-id) % (conj % account-id)))
                   (assoc-in [:statuses account-id] record)
                   (update :exhausted (if (:exhausted? status) conj disj) account-id))
        effects (cond
                  (:exhausted? status)
                  (let [wait (exhausted-cooldown-ms record now-ms)]
                    (cond-> [[:quota-exhausted provider-id account-id (j/first-non-nil used-percent 100)]]
                      (and wait (not (zero? wait))) (conj [:set-cooldown provider-id account-id (+ now-ms wait)])))

                  (:exhausted? previous)
                  [[:quota-reset provider-id account-id]
                   [:clear-cooldown provider-id account-id]
                   [:log-reset account-id log-used]]

                  :else [])]
    {:state state' :record record :warning? (:warning? status) :effects effects}))

(defn tracks-provider? [config provider-id]
  (= (j/lower (j/trim provider-id)) (j/lower (:provider-id config))))

(defn all-records
  "Every account's latest record, in the order accounts were first seen."
  [state]
  (mapv (:statuses state) (:order state)))
