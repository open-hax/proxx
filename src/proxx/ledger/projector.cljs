(ns proxx.ledger.projector
  (:require [clojure.string :as str]
            [proxx.ledger.schema :as ls]))

;; ── Failure event detection ───────────────────────────────────────────────────
;; These are the event types / outcomes that advance an epoch.

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

;; ── Epoch projection ──────────────────────────────────────────────────────────
;; An epoch is the stable identity of a (session, provider, account, model)
;; between failure events.  Epoch-id is derived from the most recent failure
;; event for that tuple — not an incrementing counter.

(defn epoch-key
  "Canonical tuple used to scope epoch queries."
  [{:keys [session-id provider-id account-id model-id]}]
  [session-id provider-id account-id model-id])

(defn derive-epoch-id
  "Returns epoch-id (string) for the most recent failure event in `events`.
   Events must be pre-filtered to the relevant (session,provider,account,model)
   and sorted oldest → newest.
   Returns ::epoch-0 sentinel when no failure has occurred."
  [events]
  (let [last-failure (->> events
                          (filter failure-event?)
                          last)]
    (if last-failure
      ;; deterministic hash over the failure event's identity fields
      (let [raw (str/join "|"
                          [(:event-id last-failure)
                           (:ts last-failure)
                           (name (:event-type last-failure))
                           (some-> last-failure :outcome name)])]
        ;; In CLJS we have no built-in sha256; callers should provide a hasher.
        ;; We store raw for now and note that the hash fn is injected.
        raw)
      ::epoch-0)))

(defn current-epoch
  "Given a full ledger (seq of all events) and a tuple map
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
   from the current ledger slice.  Used to validate affinity binding
   staleness."
  [stored-epoch-id ledger tuple]
  (= stored-epoch-id (current-epoch ledger tuple)))

;; ── Session timeline projection ───────────────────────────────────────────────

(defn session-events
  "All ledger events for a given session-id, sorted oldest → newest."
  [ledger session-id]
  (->> ledger
       (filter #(= session-id (:session-id %)))
       (sort-by :ts)))

(defn last-success-at
  "Timestamp of most recent :success outcome event for
   (session, provider, account, model), or nil."
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

;; ── Cache recoverability ──────────────────────────────────────────────────────
;; Provider-level cache TTL and quota window config.
;; These values are consulted when deciding whether to re-attach to account A
;; after having used account B for a while.

(def provider-cache-config
  {:openai      {:cache-ttl-ms          (* 24 60 60 1000)
                 :short-quota-window-ms (* 5  60 60 1000)
                 :long-quota-window-ms  (* 7  24 60 60 1000)}
   :anthropic   {:cache-ttl-ms          (* 24 60 60 1000)
                 :short-quota-window-ms (* 1  60 60 1000)
                 :long-quota-window-ms  (* 30 24 60 60 1000)}
   :ollama-cloud {:cache-ttl-ms          (* 4  60 60 1000)
                  :short-quota-window-ms (* 4  60 60 1000)
                  :long-quota-window-ms  (* 7  24 60 60 1000)}})

(defn cache-recoverable?
  "Returns true when:
   - we are still within the provider's cache TTL since last success with A, and
   - enough time has passed since the abandonment for the short quota window to reset.
   If session churn or context overflow occurred after last-success, returns false
   regardless — the cache prefix is likely gone."
  [ledger tuple provider-id now-ms]
  (let [cfg            (get provider-cache-config (keyword provider-id))
        success-ts     (last-success-at ledger tuple)
        failure-ts     (last-failure-at ledger tuple)
        churn-after?   (->> (session-events ledger (:session-id tuple))
                            (filter #(#{:session-churn-detected
                                        :context-overflow-detected} (:event-type %)))
                            (filter #(> (:ts %) (or success-ts 0)))
                            seq
                            boolean)]
    (and cfg
         success-ts
         failure-ts
         (not churn-after?)
         ;; still inside provider cache TTL
         (< (- now-ms success-ts) (:cache-ttl-ms cfg))
         ;; short quota window has had time to reset
         (>= (- now-ms failure-ts) (:short-quota-window-ms cfg)))))

;; ── Prefix similarity ─────────────────────────────────────────────────────────
;; Simple token-count heuristic: length of common prefix / length of original.
;; Replace with vector similarity when embeddings are available.

(defn prefix-similarity
  "Returns 0..1 similarity between two message-count snapshots.
   This is a rough heuristic; replace with embedding cosine similarity later."
  [count-at-success count-now]
  (if (or (nil? count-at-success) (zero? count-at-success) (nil? count-now))
    0.0
    (/ (min count-at-success count-now)
       (max count-at-success count-now))))

;; ── Scoring metrics projection ────────────────────────────────────────────────
;; Aggregates all relevant ledger signals into a metric map suitable
;; for the router scoring pipeline (proxx.processor/compute-score).

(defn project-account-metrics
  "Returns a metric map for (session, provider, account, model) at `now-ms`.
   These feed into the Boltzmann scoring pipeline alongside pheromone / health."
  [ledger tuple now-ms]
  (let [provider-id        (:provider-id tuple)
        relevant           (->> ledger
                                (filter #(= (epoch-key tuple) (epoch-key %)))
                                (sort-by :ts))
        success-ts         (last-success-at ledger tuple)
        failure-ts         (last-failure-at ledger tuple)
        cooldown-active?   (->> relevant
                                (filter #(= :account-cooldown-initiated (:event-type %)))
                                (some (fn [ev]
                                        (> (:cooldown-until ev 0) now-ms))))
        cooldown-expired?  (boolean
                            (->> relevant
                                 (filter #(= :account-cooldown-expired (:event-type %)))
                                 (filter #(> (:ts %) (or failure-ts 0)))
                                 seq))
        quota-reset?       (boolean
                            (->> relevant
                                 (filter #(= :quota-reset-detected (:event-type %)))
                                 (filter #(> (:ts %) (or failure-ts 0)))
                                 seq))
        context-overflows  (->> relevant
                                (filter #(= :context-overflow-detected (:event-type %)))
                                count)
        churn-events       (->> relevant
                                (filter #(= :session-churn-detected (:event-type %)))
                                count)]
    {:cooldown-active?     (boolean cooldown-active?)
     :cooldown-expired?    cooldown-expired?
     :quota-reset?         quota-reset?
     :time-since-last-success-ms (when success-ts (- now-ms success-ts))
     :time-since-last-failure-ms (when failure-ts (- now-ms failure-ts))
     :cache-recoverable?   (cache-recoverable? ledger tuple provider-id now-ms)
     :context-overflow-count context-overflows
     :churn-count          churn-events
     :epoch-id             (current-epoch ledger tuple)}))
