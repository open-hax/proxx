(ns proxx.routing.aco
  "Ant-colony ordering of dedicated provider routes (the decision half of
  src/lib/provider-route-aco.ts): which credentials are healthy, how a route's
  health, latency, recency and confidence combine with its pheromone, and the
  weighted random order that results. Everything observed (credential health,
  latency summaries, pheromones, the time) arrives as data and the random numbers
  as an explicit vector of draws, so the whole ranking is a pure function."
  (:require [proxx.routing.surface :as surface]))

(def default-params
  {:health-min 0.35 :alpha 0.4 :beta 0.6
   :weights {:health 0.55 :latency 0.25 :recency 0.1 :confidence 0.1}})

(def ^:private recency-window-ms (* 6 60 60 1000))
(def ^:private min-weight 0.0001)

(defn- clamp [x] (Math/min 1 (Math/max 0 x)))

(defn dedicated-route?
  "A route to a dedicated Ollama host, per the surface facts."
  [facts route]
  (surface/dedicated-ollama-provider? facts (get route "providerId")))

(defn credential-health
  "{:healthy? :health-score} for one credential. `facts` carry what the stores reported:
  :expires-at, :health-score (nil without a health store), :quota-exhausted?. Without a
  stored score an expired credential counts as 0.1 and any other as 0.5."
  [{:keys [expires-at health-score quota-exhausted?]} now-ms min-health]
  (let [expired? (and (number? expires-at) (== expires-at expires-at) (not (infinite? expires-at)) (<= expires-at now-ms))
        score (if (some? health-score) health-score (if expired? 0.1 0.5))]
    {:healthy? (and (not expired?) (not quota-exhausted?) (>= score min-health))
     :health-score score}))

(defn- latency-score [perf min-ttft max-ttft]
  (cond (nil? perf) 0.5
        (<= max-ttft min-ttft) 1
        :else (clamp (- 1 (/ (- (:ewma-ttft-ms perf) min-ttft) (- max-ttft min-ttft))))))

(defn- recency-score [perf now-ms]
  (if (nil? perf)
    0.5
    (clamp (- 1 (/ (Math/max 0 (- now-ms (:updated-at perf))) recency-window-ms)))))

(defn- confidence-score [perf]
  (if (nil? perf) 0 (clamp (/ (:sample-count perf) 10))))

(defn- score-candidate [{:keys [alpha beta weights]} now-ms min-ttft max-ttft {:keys [perf health-score pheromone] :as candidate}]
  (let [latency (latency-score perf min-ttft max-ttft)
        recency (recency-score perf now-ms)
        confidence (confidence-score perf)
        heuristic (clamp (+ (* (:health weights) health-score) (* (:latency weights) latency)
                            (* (:recency weights) recency) (* (:confidence weights) confidence)))]
    (assoc candidate
           :latency-score latency :recency-score recency :confidence-score confidence
           :heuristic-score heuristic
           :combined-score (clamp (+ (* alpha pheromone) (* beta heuristic))))))

(defn weighted-random-order
  "`items` drawn one at a time without replacement, each with probability proportional to its
  :combined-score (floored). Consumes one number of `draws` per item."
  [items draws]
  (loop [remaining (vec items) draws draws ordered []]
    (if (empty? remaining)
      ordered
      (let [weights (mapv #(Math/max (:combined-score %) min-weight) remaining)
            target (* (first draws) (reduce + weights))
            picked (loop [i 0 t target]
                     (cond (>= i (count weights)) 0
                           (<= (- t (nth weights i)) 0) i
                           :else (recur (inc i) (- t (nth weights i)))))]
        (recur (into (subvec remaining 0 picked) (subvec remaining (inc picked)))
               (rest draws)
               (conj ordered (nth remaining picked)))))))

(defn- signal [{:keys [provider-id health-score latency-score recency-score confidence-score heuristic-score
                       pheromone combined-score healthy-account-count perf]}]
  {:provider-id provider-id :health-score health-score :latency-score latency-score :recency-score recency-score
   :confidence-score confidence-score :heuristic-score heuristic-score :pheromone pheromone
   :combined-score combined-score :healthy-account-count healthy-account-count
   :sample-count (or (:sample-count perf) 0)})

(defn untouched-signal
  "The signal reported for a lone dedicated route, which is never reordered."
  [provider-id pheromone]
  {:provider-id provider-id :health-score 0.5 :latency-score 0.5 :recency-score 0.5 :confidence-score 0
   :heuristic-score 0.5 :pheromone pheromone :combined-score 0.5 :healthy-account-count 0 :sample-count 0})

(defn rank
  "Order healthy dedicated candidates. A candidate is {:index :provider-id :perf :health-score
  :healthy-account-count :pheromone} with :perf {:ewma-ttft-ms :updated-at :sample-count} or nil.
  Returns {:order [candidate index ...] :signals [...]} in the chosen order."
  [{:keys [params now-ms candidates draws]}]
  (let [ttfts (into [] (comp (keep #(get-in % [:perf :ewma-ttft-ms])) (filter #(and (number? %) (== % %) (not (infinite? %))))) candidates)
        min-ttft (if (seq ttfts) (apply min ttfts) 0)
        max-ttft (if (seq ttfts) (apply max ttfts) 0)
        ordered (weighted-random-order (mapv #(score-candidate params now-ms min-ttft max-ttft %) candidates) draws)]
    {:order (mapv :index ordered) :signals (mapv signal ordered)}))
