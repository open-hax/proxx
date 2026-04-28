(ns proxx.ledger.projector
  (:require [clojure.string :as str]))

(def terminal-outcomes
  #{:quota-exhausted
    :quota-exhausted-in-body
    :auth-failure
    :all-strategies-exhausted
    :empty-response
    :unrecognized-schema})

(def terminal-event-types
  #{:empty-provider-response
    :unrecognized-response-schema
    :account-cooldown-initiated
    :session-account-changed
    :session-model-changed})

(defn failure-event?
  "Returns true if this ledger event represents a terminal / abandonment signal."
  [event]
  (or (terminal-event-types (:event-type event))
      (terminal-outcomes (:outcome event))))

(defn epoch-key
  "Canonical tuple used to scope epoch queries."
  [{:keys [session-id provider-id account-id model-id]}]
  [session-id provider-id account-id model-id])

(defn derive-epoch-id
  "Returns epoch-id (string) for the most recent failure event in `events`.
   Events must be pre-filtered to the relevant (session,provider,account,model)
   and sorted oldest->newest.
   Returns ::epoch-0 sentinel when no failure has occurred."
  [events]
  (let [last-failure (->> events
                          (filter failure-event?)
                          last)]
    (if last-failure
      (str/join "|"
                [(:event-id last-failure)
                 (:ts last-failure)
                 (name (:event-type last-failure))
                 (some-> last-failure :outcome name)])
      ::epoch-0)))

(defn current-epoch
  "Given a full ledger and a tuple map
   {:session-id :provider-id :account-id :model-id},
   return the current epoch-id."
  [ledger tuple]
  (let [k (epoch-key tuple)
        relevant (->> ledger
                      (filter #(= k (epoch-key %)))
                      (sort-by :ts))]
    (derive-epoch-id relevant)))

(defn epoch-unchanged?
  "Returns true when stored-epoch-id still matches the derived epoch-id
   from the current ledger slice."
  [stored-epoch-id ledger tuple]
  (= stored-epoch-id (current-epoch ledger tuple)))

(defn session-events
  "All ledger events for a given session-id, sorted oldest->newest."
  [ledger session-id]
  (->> ledger
       (filter #(= session-id (:session-id %)))
       (sort-by :ts)))

(defn last-success-at
  "Timestamp of most recent :success outcome event for a tuple, or nil."
  [ledger tuple]
  (->> ledger
       (filter #(= (epoch-key tuple) (epoch-key %)))
       (filter #(= :success (:outcome %)))
       (sort-by :ts)
       last
       :ts))

(defn last-failure-at
  "Timestamp of most recent failure event for a tuple, or nil."
  [ledger tuple]
  (->> ledger
       (filter #(= (epoch-key tuple) (epoch-key %)))
       (filter failure-event?)
       (sort-by :ts)
       last
       :ts))

(def provider-cache-config
  {:openai       {:cache-ttl-ms          (* 24 60 60 1000)
                  :short-quota-window-ms (* 5  60 60 1000)
                  :long-quota-window-ms  (* 7  24 60 60 1000)}
   :anthropic    {:cache-ttl-ms          (* 24 60 60 1000)
                  :short-quota-window-ms (* 1  60 60 1000)
                  :long-quota-window-ms  (* 30 24 60 60 1000)}
   :ollama-cloud {:cache-ttl-ms          (* 4  60 60 1000)
                  :short-quota-window-ms (* 4  60 60 1000)
                  :long-quota-window-ms  (* 7  24 60 60 1000)}})

(defn cache-recoverable?
  "Returns true when within provider cache TTL since last success AND
   enough time has elapsed since failure for the short quota window to reset.
   Returns false if churn or context overflow occurred after last success."
  [ledger tuple provider-id now-ms]
  (let [cfg          (get provider-cache-config (keyword provider-id))
        success-ts   (last-success-at ledger tuple)
        failure-ts   (last-failure-at ledger tuple)
        churn-after? (->> (session-events ledger (:session-id tuple))
                          (filter #(#{:session-churn-detected
                                      :context-overflow-detected} (:event-type %)))
                          (filter #(> (:ts %) (or success-ts 0)))
                          seq
                          boolean)]
    (boolean
     (and cfg
          success-ts
          failure-ts
          (not churn-after?)
          (< (- now-ms success-ts) (:cache-ttl-ms cfg))
          (>= (- now-ms failure-ts) (:short-quota-window-ms cfg))))))

(defn prefix-similarity
  "Returns 0..1 similarity between two message-count snapshots."
  [count-at-success count-now]
  (if (or (nil? count-at-success) (zero? count-at-success) (nil? count-now))
    0.0
    (/ (min count-at-success count-now)
       (max count-at-success count-now))))

(defn project-account-metrics
  "Aggregates ledger signals into a metric map for
   (session, provider, account, model) at now-ms."
  [ledger tuple now-ms]
  (let [provider-id      (:provider-id tuple)
        relevant         (->> ledger
                              (filter #(= (epoch-key tuple) (epoch-key %)))
                              (sort-by :ts))
        success-ts       (last-success-at ledger tuple)
        failure-ts       (last-failure-at ledger tuple)
        cooldown-active? (some (fn [ev]
                                 (and (= :account-cooldown-initiated (:event-type ev))
                                      (> (:cooldown-until ev 0) now-ms)))
                               relevant)
        cooldown-expired? (boolean
                           (some (fn [ev]
                                   (and (= :account-cooldown-expired (:event-type ev))
                                        (> (:ts ev) (or failure-ts 0))))
                                 relevant))
        quota-reset?      (boolean
                           (some (fn [ev]
                                   (and (= :quota-reset-detected (:event-type ev))
                                        (> (:ts ev) (or failure-ts 0))))
                                 relevant))
        context-overflows (count (filter #(= :context-overflow-detected (:event-type %)) relevant))
        churn-events      (count (filter #(= :session-churn-detected (:event-type %)) relevant))]
    {:cooldown-active?              (boolean cooldown-active?)
     :cooldown-expired?             cooldown-expired?
     :quota-reset?                  quota-reset?
     :time-since-last-success-ms    (when success-ts (- now-ms success-ts))
     :time-since-last-failure-ms    (when failure-ts (- now-ms failure-ts))
     :cache-recoverable?            (cache-recoverable? ledger tuple provider-id now-ms)
     :context-overflow-count        context-overflows
     :churn-count                   churn-events
     :epoch-id                      (current-epoch ledger tuple)}))
