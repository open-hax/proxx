(ns proxx.strategy.chains
  "Fallback-chain auto models: `auto:vision` and `auto:cephalon[:type]`.

  Unlike `auto:cheapest|fastest|...` (a ranking, see proxx.routing.auto-model),
  these name an ordered preference list. The lists, route priorities and limits are
  facts in the `:auto-model-chains` contract (79-auto-model-chains.edn); this
  namespace interprets them. Ranking itself (needing request logs and health) stays
  with the auto-model edge: cephalon asks for a ranking via `cephalon-plan` and
  picks from it with `cephalon-choice`."
  (:require [clojure.string :as str]))

(defn chains-from-contracts [contracts]
  (or (some #(when (= :auto-model-chains (:contract/kind %)) %) contracts)
      (throw (ex-info "Missing auto-model chains" {:error/type :policy/missing-auto-model-chains}))))

(defn- norm [model] (str/lower-case (str/trim (or model ""))))

;; --- shared ---------------------------------------------------------------------

(defn max-candidates
  "How many ranked candidates an auto model may try: the configured integer when
  it is positive, clamped to the ceiling, else the default. `raw` is the env text."
  [chains raw]
  (let [{:keys [default ceiling]} (:chains/max-candidates chains)
        parsed (when (string? raw) #?(:cljs (js/parseInt raw 10) :clj (try (Long/parseLong raw) (catch Exception _ nil))))]
    (if (and (number? parsed) (not #?(:cljs (js/isNaN parsed) :clj false)) (pos? parsed))
      (min parsed ceiling)
      default)))

(defn advance?
  "Should the next candidate be tried? `summary` maps the accumulator's flags."
  [chains {:keys [has-more? auto-model?]} summary]
  (boolean (and has-more? auto-model?
                (some #(true? (get summary %)) (:chains/advance-on chains)))))

;; --- vision ---------------------------------------------------------------------

(defn vision-model? [model] (= "auto:vision" (norm model)))

(defn vision-candidates
  "The vision chain filtered by what the catalog offers; the whole chain when none of it is offered."
  [chains available-models]
  (let [chain (get-in chains [:chains/vision :model-chain])
        available (set (map norm available-models))
        offered (filterv #(contains? available (norm %)) chain)]
    (if (seq offered) offered (vec chain))))

(defn- rule-matches? [model {:keys [models model-prefix model-contains]}]
  (cond models (contains? models model)
        model-prefix (str/starts-with? model model-prefix)
        model-contains (str/includes? model model-contains)))

(defn vision-route-order
  "Indices of `provider-ids` ordered for `model`: providers favoured by the first
  matching priority rule first, the rest after, each group in route order."
  [chains model provider-ids]
  (let [model (norm model)
        rule (some #(when (rule-matches? model %) %) (get-in chains [:chains/vision :route-priority]))
        favoured? (fn [id] (when rule
                             (or (contains? (:provider-ids rule) id)
                                 (some-> (:provider-prefix rule) (->> (str/starts-with? id))))))
        indices (range (count provider-ids))]
    (if rule
      (vec (concat (filter #(favoured? (nth provider-ids %)) indices)
                   (remove #(favoured? (nth provider-ids %)) indices)))
      (vec indices))))

;; --- cephalon -------------------------------------------------------------------

(defn cephalon-model? [model]
  (let [n (norm model)]
    (or (= "auto:cephalon" n) (str/starts-with? n "auto:cephalon:"))))

(def ^:private cephalon-prefix "auto:cephalon:")

(defn- auto-type
  "`fastest` | `smartest` | `cheapest` from the text after `auto:cephalon:`.
  (The TypeScript read the text after the *first* colon, `cephalon:fastest`, so
  fastest and smartest were never selected; pinned by a named test.)"
  [model]
  (let [n (norm model)
        suffix (if (str/starts-with? n cephalon-prefix) (str/trim (subs n (count cephalon-prefix))) "cheapest")]
    (case suffix "fastest" "fastest" "smartest" "smartest" "cheapest")))

(defn cephalon-plan
  "What to rank for a cephalon model: the inner auto model (`auto:<type>`) and the
  candidate pool (the catalog's models plus the preferred Ollama ones)."
  [chains model available-models]
  (let [type (auto-type model)]
    {:inner-model (str "auto:" type)
     :candidates (vec (distinct (concat available-models (get-in chains [:chains/cephalon :ollama-preferred]))))}))

(defn cephalon-choice
  "The cephalon pick among `ranked` model ids (best first)."
  [chains model ranked]
  (let [{:keys [preferred-models ollama-preferred ollama-fast-order ollama-smart-order empty-ranking-fallback]}
        (:chains/cephalon chains)
        smart? (= "smartest" (auto-type model))
        ranked-set (set (map norm ranked))
        by-norm (fn [ids] (let [s (set (map norm ids))] (some #(when (contains? s (norm %)) %) ranked)))]
    (if (empty? ranked)
      (or (first preferred-models) "gpt-5-nano")
      (or (some #(when (contains? ranked-set (norm %)) %) (if smart? ollama-smart-order ollama-fast-order))
          (by-norm ollama-preferred)
          (by-norm preferred-models)
          (first ranked)
          empty-ranking-fallback))))
