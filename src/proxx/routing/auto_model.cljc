(ns proxx.routing.auto-model
  "Pure `auto:*` model selection.

  Selection is a ranking: filter the candidate models by what the request needs,
  score each against facts the caller supplies, and order by a per-strategy
  comparison table. Model facts (intelligence ranks, capability support, default
  candidates) are declared in 18-auto-model-profile.edn and arrive as `profile`;
  prices, observed latency and account health are explicit inputs, so nothing
  here reads a store or the clock."
  (:require [clojure.string :as str]))

(def ^:private prefix "auto:")

(def auto-types #{:cheapest :fastest :smartest :healthiest})

(defn auto-model? [model]
  (str/starts-with? (str/lower-case model) prefix))

(defn parse-auto-type
  "`:cheapest` | `:fastest` | `:smartest` | `:healthiest` for `auto:<type>`, else nil."
  [model]
  (let [normalized (str/lower-case (str/trim model))]
    (when (str/starts-with? normalized prefix)
      (auto-types (keyword (subs normalized (count prefix)))))))

;; ---------------------------------------------------------------------------
;; What the request needs
;; ---------------------------------------------------------------------------

(defn- truthy? [x]
  (not (or (nil? x) (false? x) (= 0 x) (= "" x) (and (number? x) (not= x x)))))

(defn- image-part? [part]
  (and (map? part) (= "image_url" (get part "type"))))

(defn detect-capabilities
  "The optional capabilities a chat request requires, as a set of
  `:vision` `:tools` `:thinking`."
  [body]
  (if-not (map? body)
    #{}
    (let [reasoning (get body "reasoning")]
      (cond-> #{}
        (some (fn [msg]
                (and (map? msg) (sequential? (get msg "content")) (some image-part? (get msg "content"))))
              (let [m (get body "messages")] (when (sequential? m) m)))
        (conj :vision)

        (let [tools (get body "tools")] (and (sequential? tools) (seq tools)))
        (conj :tools)

        (or (some #(string? (get body %)) ["reasoning_effort" "reasoningEffort" "reasoning_summary" "reasoningSummary"])
            (and (map? reasoning) (or (truthy? (get reasoning "effort")) (truthy? (get reasoning "max_tokens")))))
        (conj :thinking)))))

(defn- model-fact [profile model-id]
  (get-in profile [:auto/models (str/lower-case (str/trim model-id))]))

(defn supports?
  "Does the model support every capability in `needs`? Unknown models support none."
  [profile model-id needs]
  (every? #(contains? (:capabilities (model-fact profile model-id)) %) needs))

(defn intelligence [profile model-id]
  (or (:intelligence (model-fact profile model-id)) (:auto/default-intelligence profile)))

;; ---------------------------------------------------------------------------
;; Scoring
;; ---------------------------------------------------------------------------

(def default-health-score 50)

(defn aggregate-health
  "Mean of a provider's account health scores (0..1) as a 0..100 score, or the
  neutral default when it has none. `entries` are maps with \"providerId\" and \"score\"."
  [entries provider-id]
  (let [scores (keep #(when (= provider-id (get % "providerId")) (get % "score")) entries)]
    (if (empty? scores)
      default-health-score
      (* 100 (/ (reduce + scores) (count scores))))))

(defn- speed [ttft-ms]
  (if (and (number? ttft-ms) (pos? ttft-ms))
    {:speed-score (max 0 (- 100 (/ ttft-ms 100))) :observed-speed? true}
    {:speed-score 50 :observed-speed? false}))

(defn- overall-score [auto-type {:keys [cost-score speed-score intelligence-score health-score]}]
  (case auto-type
    :cheapest (- 100 cost-score)
    :fastest speed-score
    :smartest intelligence-score
    :healthiest health-score))

(defn score-model
  "Score one candidate. `facts` supplies {:pricing {:input :output :found?}
  :ttft-ms number-or-nil :health-score n}."
  [profile auto-type provider-id model-id {:keys [pricing ttft-ms health-score]}]
  (let [scored (merge {:model-id model-id
                       :provider-id provider-id
                       :cost-score (+ (:input pricing) (:output pricing))
                       :intelligence-score (intelligence profile model-id)
                       :health-score health-score
                       :pricing-found? (boolean (:found? pricing))}
                      (speed ttft-ms))]
    (assoc scored :score (overall-score auto-type scored))))

;; ---------------------------------------------------------------------------
;; Ordering: one comparison table per strategy; ties fall through to the next
;; column, and the sort is stable for whatever remains.
;; ---------------------------------------------------------------------------

(def ^:private columns
  {:cheapest   [[:true-first :pricing-found?] [:asc :cost-score] [:desc :health-score]
                [:desc :intelligence-score] [:locale :model-id]]
   :fastest    [[:true-first :observed-speed?] [:desc :speed-score] [:desc :health-score] [:locale :model-id]]
   :smartest   [[:desc :intelligence-score] [:desc :health-score] [:true-first :pricing-found?] [:asc :cost-score]]
   :healthiest [[:desc :health-score] [:true-first :observed-speed?] [:desc :speed-score] [:locale :model-id]]})

(defn- locale-compare [a b]
  #?(:cljs (.localeCompare a b) :clj (compare a b)))

(defn- compare-column [[direction k] a b]
  (let [x (get a k) y (get b k)]
    (case direction
      :asc (compare x y)
      :desc (compare y x)
      :true-first (if (= x y) 0 (if x -1 1))
      :locale (locale-compare x y))))

(defn- comparator-for [auto-type]
  (fn [a b]
    (or (some (fn [column] (let [c (compare-column column a b)] (when-not (zero? c) c)))
              (columns auto-type))
        0)))

(defn rank-auto-models
  "Candidate models best-first for `model` (an `auto:<type>` selector); [] when
  the selector is invalid or nothing qualifies.

  `candidates` defaults to the profile's list. `facts-for` maps a model id to
  the scoring facts described in `score-model` (minus :health-score, which is
  provider-wide and passed as `health-score`)."
  [profile model body candidates provider-id health-score facts-for]
  (if-let [auto-type (parse-auto-type model)]
    (let [needs (detect-capabilities body)]
      (->> (or candidates (:auto/default-candidates profile))
           (remove auto-model?)
           (filter #(supports? profile % needs))
           (map #(score-model profile auto-type provider-id %
                              (assoc (facts-for %) :health-score health-score)))
           (sort (comparator-for auto-type))
           vec))
    []))
