(ns proxx.queue.runtime
  (:refer-clojure :exclude [run!])
  (:require [proxx.queue.policy :as policy]))

;; ── Registry ──────────────────────────────────────────────────

(defonce ^:private registry (atom {}))

(defn- policy-key [p]
  (pr-str (select-keys p policy/queue-policy-keys)))

(defn- new-queue-state []
  {:active 0 :queued 0 :waiting []})

(defn get-or-create-queue! [policy]
  (let [k (policy-key policy)]
    (when-not (get @registry k)
      (swap! registry assoc k (atom (new-queue-state))))
    (get @registry k)))

;; ── Slot management ───────────────────────────────────────────

(defn- try-acquire! [state-atom limit]
  (let [{:keys [active]} @state-atom]
    (when (< active limit)
      (swap! state-atom update :active inc)
      true)))

(defn- pop-next-waiter! [state-atom]
  (let [waiter (atom nil)]
    (swap! state-atom (fn [s]
                        (reset! waiter (first (:waiting s)))
                        (-> s
                            (update :active #(max 0 (dec %)))
                            (update :waiting (comp vec rest)))))
    @waiter))

(defn release! [state-atom]
  (when-let [w (pop-next-waiter! state-atom)]
    (w)))

;; ── Overflow errors ───────────────────────────────────────────

(defn- queue-full-error [policy active-count]
  (ex-info "Request queue full"
           {:code           :queue/full
            :retry-after-ms (policy/drain-estimate-ms policy active-count)
            :limit          (:queue/max-queue-size policy)}))

(defn- queue-dropped-error []
  (ex-info "Request dropped: queue at capacity"
           {:code :queue/dropped}))

(defn- queue-wait-timeout-error []
  (ex-info "Timed out waiting in queue"
           {:code :queue/total-timeout :attempt 0}))

(defn- attempt-timeout-error [attempt]
  (ex-info (str "Attempt " attempt " timed out")
           {:code :queue/attempt-timeout :attempt attempt}))

(defn- exhausted-error []
  (ex-info "Max retries exhausted"
           {:code :queue/exhausted}))

(defn- total-timeout-error [attempt]
  (ex-info "Total timeout exceeded"
           {:code :queue/total-timeout :attempt attempt}))

;; ── Waiter construction ───────────────────────────────────────

(defn- make-waiter [state-atom total-deadline resolve reject]
  (fn []
    (swap! state-atom (fn [s]
                        (-> s
                            (update :queued #(max 0 (dec %)))
                            (update :active inc))))
    (if (and total-deadline (>= (js/Date.now) total-deadline))
      (reject (queue-wait-timeout-error))
      (resolve nil))))

(defn- park-caller! [state-atom total-deadline]
  (swap! state-atom update :queued inc)
  (js/Promise.
   (fn [resolve reject]
     (swap! state-atom update :waiting
            conj (make-waiter state-atom total-deadline resolve reject)))))

;; ── Acquire ───────────────────────────────────────────────────

(defn ^:async acquire! [state-atom policy total-deadline]
  (let [{:keys [active queued]} @state-atom
        limit                   (:queue/concurrency-limit policy)
        max-q                   (:queue/max-queue-size policy)]
    (cond
      (try-acquire! state-atom limit)
      nil

      (>= queued max-q)
      (throw (if (= (:queue/overflow-policy policy) :reject)
               (queue-full-error policy active)
               (queue-dropped-error)))

      :else
      (await (park-caller! state-atom total-deadline)))))

;; ── Per-attempt execution ─────────────────────────────────────

(defn- effective-timeout-ms [policy total-deadline]
  (let [attempt-tms (:queue/attempt-timeout-ms policy 120000)
        remaining   (if total-deadline
                      (- total-deadline (js/Date.now))
                      js/Infinity)]
    (min attempt-tms remaining)))

(defn- make-abort-promise [signal attempt]
  (js/Promise.
   (fn [_ reject]
     (.addEventListener signal "abort"
                         #(reject (attempt-timeout-error attempt))))))

(defn- arm-abort-timer! [controller timeout-ms]
  (js/setTimeout #(.abort controller) timeout-ms))

(defn ^:async run-attempt [task attempt policy total-deadline]
  (let [controller (js/AbortController.)
        tms        (effective-timeout-ms policy total-deadline)
        timer-ref  (atom (arm-abort-timer! controller tms))
        completed? (atom false)
        extend-timeout! (fn []
                          (when-not @completed?
                            (let [stream-tms (:queue/stream-timeout-ms policy 120000)]
                              (js/clearTimeout @timer-ref)
                              (reset! timer-ref (arm-abort-timer! controller stream-tms)))))
        abort-p    (make-abort-promise (.-signal controller) attempt)]
    ;; Attach extendTimeout as a JS property for TS interop
    (set! (.-extendTimeout controller) extend-timeout!)
    (set! (.-extendTimeout (.-signal controller)) extend-timeout!)
    (try
      (await (js/Promise.race #js [(task controller) abort-p]))
      (finally
        (reset! completed? true)
        (js/clearTimeout @timer-ref)))))

;; ── Retry classification ──────────────────────────────────────

(defn- retry-after-ms [err]
  (some-> (get (ex-data err) :headers)
          (policy/parse-retry-after-ms)))

(defn- should-use-retry-after? [policy err n max-attempts]
  (and (:queue/retry-after-respect? policy)
       (policy/retryable-status? (get (ex-data err) :status))
       (< (inc n) max-attempts)))

(defn- retryable-error? [err]
  (let [{:keys [code status]} (ex-data err)]
    (or (= code :queue/attempt-timeout)
        (and (some? status) (policy/retryable-status? status)))))

;; ── Delay ─────────────────────────────────────────────────────

(defn ^:async sleep [ms]
  (await (js/Promise. (fn [resolve] (js/setTimeout resolve ms)))))

;; ── Total deadline guard ──────────────────────────────────────

(defn- deadline-exceeded? [total-deadline]
  (and total-deadline (>= (js/Date.now) total-deadline)))

;; ── Retry loop ────────────────────────────────────────────────

(declare attempt-loop)

(defn ^:async handle-attempt-error [task policy n max-attempts total-deadline err]
  (cond
    (:queue/fail-fast? policy)
    (throw err)

    (should-use-retry-after? policy err n max-attempts)
    (do (await (sleep (or (retry-after-ms err) 0)))
        (await (attempt-loop task policy (inc n) max-attempts total-deadline err)))

    (retryable-error? err)
    (await (attempt-loop task policy (inc n) max-attempts total-deadline err))

    :else
    (throw err)))

(defn ^:async attempt-loop [task policy n max-attempts total-deadline last-err]
  (when (>= n max-attempts)
    (throw (or last-err (exhausted-error))))
  (when (deadline-exceeded? total-deadline)
    (throw (total-timeout-error n)))
  (await (sleep (policy/backoff-ms policy n)))
  (await (-> (run-attempt task n policy total-deadline)
                (.catch #(handle-attempt-error task policy n max-attempts total-deadline %)))))

;; ── Public entry point ────────────────────────────────────────

(defn ^:async run!
  "Execute task through the queue governed by policy.
   task is a fn of [AbortController] → Promise<T>.
   Returns Promise<T>."
  [task policy]
  (let [state-atom     (get-or-create-queue! policy)
        total-tms      (:queue/total-timeout-ms policy)
        total-deadline (when total-tms (+ (js/Date.now) total-tms))
        max-attempts   (inc (or (:queue/max-retries policy) 0))]
    (await (acquire! state-atom policy total-deadline))
    (try
      (await (attempt-loop task policy 0 max-attempts total-deadline nil))
      (finally
        (release! state-atom)))))
