(ns proxx.oauth.flow
  "OAuth flow bookkeeping as an immutable value with pure transitions.

  Both the OpenAI and the Factory (WorkOS) managers keep the same three tables:

    :browser-pending      {state {:created-at ms ...}}   authorize URL handed out
    :browser-completions  {state {:tokens t :expires-at ms}}  exchanged, cached
    :devices              {id {:created-at ms :interval-ms n :next-poll-at ms
                               :cached-result r :cached-expires-at ms ...}}

  Time is always a `now-ms` argument. Promises (an exchange or poll in flight)
  are not data: the edge keeps them beside this value and passes only the
  question \"is one in flight?\" to the decisions below. Each `plan` function
  returns a vector whose head names the effect the edge must perform next."
  (:require [clojure.string :as str]))

(def empty-flows {:browser-pending {} :browser-completions {} :devices {}})

(def default-browser-state-ttl-ms (* 5 60 1000))
(def default-browser-completion-ttl-ms (* 5 60 1000))
(def default-device-state-ttl-ms (* 15 60 1000))
(def default-device-poll-interval-ms 5000)

(defn finite-number? [x]
  (and (number? x)
       #?(:cljs (js/Number.isFinite x)
          :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x)))))))

(defn parse-int
  "`Number.parseInt(v, 10)`: leading whitespace, optional sign, leading digits,
  anything after is ignored; nil where JavaScript says NaN."
  [v]
  (let [s (if (string? v) v (str v))]
    (when-let [[_ digits] (re-find #"^\s*([+-]?\d+)" s)]
      #?(:cljs (js/parseInt digits 10)
         :clj (Double/parseDouble digits)))))

(defn prune
  "Drop expired entries. A device flow with a poll in flight (its id is in
  `in-flight-device-ids`) is never pruned."
  [flows now-ms {:keys [browser-state-ttl-ms browser-completion-ttl-ms device-state-ttl-ms]}
   in-flight-device-ids]
  (let [browser-cutoff (- now-ms browser-state-ttl-ms)
        device-cutoff (- now-ms device-state-ttl-ms)
        keep-entries (fn [m keep?] (into {} (filter (fn [[k v]] (keep? k v))) m))]
    (-> flows
        (update :browser-pending keep-entries (fn [_ p] (not (< (:created-at p) browser-cutoff))))
        (update :browser-completions keep-entries (fn [_ c] (not (<= (:expires-at c) now-ms))))
        (update :devices keep-entries (fn [id d] (or (not (< (:created-at d) device-cutoff))
                                                     (contains? in-flight-device-ids id)))))))

;; ---------------------------------------------------------------------------
;; Browser flow
;; ---------------------------------------------------------------------------

(defn add-browser-pending [flows state entry]
  (assoc-in flows [:browser-pending state] entry))

(defn browser-completion-plan
  "What `completeBrowserFlow` must do for `state`:
    [:cached tokens]   a completed exchange is still cached
    [:in-flight]       join the exchange already running
    [:exchange pending] consume the pending entry and exchange the code
    [:unknown]         never issued, or expired"
  [flows state now-ms in-flight?]
  (let [completion (get-in flows [:browser-completions state])
        pending (get-in flows [:browser-pending state])]
    (cond
      (and completion (> (:expires-at completion) now-ms)) [:cached (:tokens completion)]
      in-flight? [:in-flight]
      pending [:exchange pending]
      :else [:unknown])))

(defn take-browser-pending [flows state]
  (update flows :browser-pending dissoc state))

(defn record-browser-completion [flows state tokens now-ms completion-ttl-ms]
  (assoc-in flows [:browser-completions state] {:tokens tokens :expires-at (+ now-ms completion-ttl-ms)}))

;; ---------------------------------------------------------------------------
;; Device flow
;; ---------------------------------------------------------------------------

(defn new-device-flow [now-ms interval-ms extra]
  (merge {:created-at now-ms :interval-ms interval-ms :next-poll-at 0} extra))

(defn add-device-flow [flows id flow]
  (assoc-in flows [:devices id] flow))

(defn device-poll-plan
  "What `pollDeviceFlow` must do for a known `flow`:
    [:cached result] [:in-flight] [:pending] (too early) or [:poll]."
  [flow now-ms in-flight?]
  (cond
    (and (:cached-result flow) (number? (:cached-expires-at flow)) (> (:cached-expires-at flow) now-ms))
    [:cached (:cached-result flow)]
    in-flight? [:in-flight]
    (< now-ms (:next-poll-at flow)) [:pending]
    :else [:poll]))

(defn- when-present [flows id f]
  (if (contains? (:devices flows) id) (update-in flows [:devices id] f) flows))

(defn defer-next-poll
  "The provider said \"not yet\": wait one interval."
  [flows id now-ms]
  (when-present flows id #(assoc % :next-poll-at (+ now-ms (:interval-ms %)))))

(defn slow-down
  "RFC 8628 `slow_down`: one more second between polls."
  [flows id now-ms]
  (when-present flows id (fn [d] (let [interval (+ (:interval-ms d) 1000)]
                                   (assoc d :interval-ms interval :next-poll-at (+ now-ms interval))))))

(defn cache-device-result [flows id result now-ms ttl-ms]
  (when-present flows id #(assoc % :cached-result result :cached-expires-at (+ now-ms ttl-ms))))

(defn drop-device [flows id]
  (update flows :devices dissoc id))

(defn blank->nil [s]
  (when (string? s) (let [t (str/trim s)] (when (seq t) t))))
