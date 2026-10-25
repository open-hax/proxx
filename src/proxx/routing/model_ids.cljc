(ns proxx.routing.model-ids
  "Model-id helpers behind provider routing (the pure half of
  src/lib/provider-routing.ts): prefixes, local-Ollama detection, catalog
  payload parsing, largest-tag aliases and Ollama catalog routes. Provider facts
  come from the `:provider-surface-facts` contract (see proxx.routing.surface)."
  (:require [clojure.string :as str]
            [proxx.routing.ordered :as om]
            [proxx.routing.surface :as surface]))

(defn- lower [s] (str/lower-case (str s)))

(defn has-model-prefix?
  "Does the model start (case-insensitively) with any non-empty prefix?"
  [model prefixes]
  (let [m (lower model)]
    (boolean (some #(and (seq %) (str/starts-with? m (lower %))) prefixes))))

(defn strip-model-prefix
  "The model without its first matching prefix, or unchanged when nothing remains.
  The prefix is cut by its own length, as it was written."
  [model prefixes]
  (let [m (lower model)]
    (or (some (fn [prefix]
                (when (and (seq prefix) (str/starts-with? m (lower prefix)))
                  (let [n (count prefix)
                        rest (str/trim (if (> n (count model)) "" (subs model n)))]
                    (if (seq rest) rest model))))
              prefixes)
        model)))

(defn local-ollama-model?
  "Does the model look like one the local Ollama serves, per the configured patterns?
  Hosted OpenAI families never do. Size tags like `:e4b` also match their `:4b` form."
  [facts model patterns]
  (and (not (surface/hosted-openai-family? facts model))
       (let [m (lower model)
             size-normalized (str/replace m #":([a-z]+)(\d+(?:\.\d+)?[bt])" ":$2")]
         (boolean
          (some (fn [pattern]
                  (let [p (lower pattern)]
                    (if (str/starts-with? p ":")
                      (or (str/includes? m p) (str/includes? size-normalized p))
                      (or (= m p)
                          (str/ends-with? m (str "-" p))
                          (str/ends-with? m (str "/" p))
                          (str/ends-with? m (str ":" p))))))
                patterns)))))

(defn request-routing-state
  "How a requested model is routed. `config` is {:factory-model-prefixes :ollama-model-prefixes
  :openai-model-prefixes :local-ollama-enabled :local-ollama-model-patterns}; the first
  matching prefix family wins in the order factory, explicit Ollama, OpenAI."
  [facts config requested-model]
  (let [{:keys [factory-model-prefixes ollama-model-prefixes openai-model-prefixes
                local-ollama-enabled local-ollama-model-patterns]} config
        factory? (has-model-prefix? requested-model factory-model-prefixes)
        explicit-ollama? (and (not factory?) (has-model-prefix? requested-model ollama-model-prefixes))
        openai? (and (not factory?) (has-model-prefix? requested-model openai-model-prefixes))
        local-ollama? (boolean (or explicit-ollama?
                                   (and (not openai?) (not factory?) local-ollama-enabled
                                        (local-ollama-model? facts requested-model local-ollama-model-patterns))))
        routed (cond factory? (strip-model-prefix requested-model factory-model-prefixes)
                     explicit-ollama? (strip-model-prefix requested-model ollama-model-prefixes)
                     openai? (strip-model-prefix requested-model openai-model-prefixes)
                     :else requested-model)]
    {:explicit-ollama explicit-ollama? :openai-prefixed openai? :factory-prefixed factory?
     :local-ollama local-ollama? :routed-model routed}))

(defn dedupe-model-ids
  "Trimmed, non-empty, distinct ids in first-seen order."
  [model-ids]
  (->> model-ids (map str/trim) (remove empty?) distinct vec))

(defn- string-or-nil [x] (when (string? x) x))

(defn parse-model-ids-from-catalog-payload
  "Model ids from a provider's /models payload: a bare list of ids, {\"data\": [{\"id\"}]}
  or {\"models\": [id | {\"id\"|\"name\"|\"model\"}]}. `data` wins over `models`."
  [payload]
  (cond
    (sequential? payload) (dedupe-model-ids (filter string? payload))
    (not (map? payload)) []
    (sequential? (get payload "data"))
    (dedupe-model-ids (keep #(when (map? %) (string-or-nil (get % "id"))) (get payload "data")))
    (sequential? (get payload "models"))
    (dedupe-model-ids
     (keep (fn [entry]
             (cond (string? entry) entry
                   (map? entry) (some string-or-nil [(get entry "id") (get entry "name") (get entry "model")])))
           (get payload "models")))
    :else []))

(defn- model-scale-score
  "Parameter count of a tag in billions (`7b`, `1.5b`, `2t` = 2000), or nil."
  [model-tag]
  (when-let [[_ amount unit] (re-find #"(?i)(\d+(?:\.\d+)?)([bt])" model-tag)]
    (let [n (parse-double amount)]
      (when (and (number? n) (pos? n) (< n ##Inf))
        (if (= "t" (str/lower-case unit)) (* n 1000) n)))))

(defn- prefer?
  "Does a candidate replace the incumbent? Larger scale, then shorter tag, then smaller id."
  [{:keys [score tag-length model-id]} current]
  (or (> score (:score current))
      (and (= score (:score current)) (< tag-length (:tag-length current)))
      (and (= score (:score current)) (= tag-length (:tag-length current))
           (neg? (compare model-id (:model-id current))))))

(defn largest-model-aliases
  "Ordered alias entries [[alias model-id] ...] mapping `name` to its largest `name:<size>`
  tag (when `name` is not itself a model) and `name:latest` to that same tag."
  [model-ids]
  (let [known (set model-ids)
        {:keys [best latest]}
        (reduce
         (fn [{:keys [best latest] :as acc} model-id]
           (let [i (str/index-of model-id ":")]
             (if (or (nil? i) (<= i 0) (>= i (dec (count model-id))))
               acc
               (let [alias (subs model-id 0 i)
                     tag (subs model-id (inc i))
                     latest (if (= "latest" (str/lower-case (str/trim tag))) (assoc latest alias model-id) latest)
                     score (model-scale-score tag)
                     candidate {:model-id model-id :score score :tag-length (count tag)}]
                 (cond
                   (not (and score (pos? score))) (assoc acc :latest latest)
                   (or (not (om/om-contains? best alias)) (prefer? candidate (om/om-get best alias)))
                   (assoc acc :latest latest :best (om/om-assoc best alias candidate))
                   :else (assoc acc :latest latest))))))
         {:best om/empty-om :latest {}}
         model-ids)]
    (om/om-entries
     (reduce (fn [targets [alias {selected :model-id}]]
               (let [targets (if (contains? known alias) targets (om/om-assoc targets alias selected))
                     latest-alias (get latest alias)]
                 (if (and latest-alias (not= latest-alias selected))
                   (om/om-assoc targets latest-alias selected)
                   targets)))
             om/empty-om
             (om/om-entries best)))))

(defn- strip-trailing-slashes [s] (str/replace s #"/+$" ""))

(defn ollama-catalog-routes
  "Routes to probe for Ollama models: the local one (when enabled and it has a url),
  then every configured provider whose id says Ollama; one per distinct trimmed id.
  `config` is {:ollama-base-url :local-ollama-enabled :upstream-provider-base-urls}
  with the urls as ordered [[provider-id base-url] ...] entries."
  [facts {:keys [ollama-base-url local-ollama-enabled upstream-provider-base-urls]}]
  (let [local-url (strip-trailing-slashes (str/trim (str ollama-base-url)))
        local (when (and local-ollama-enabled (seq local-url))
                {"providerId" (:surface/local-ollama-provider-id facts) "baseUrl" local-url})
        configured (->> upstream-provider-base-urls
                        (filter (fn [[provider-id _]]
                                  (re-find (re-pattern (:surface/ollama-provider-id-pattern facts)) (lower provider-id))))
                        (map (fn [[provider-id base-url]] {"providerId" provider-id "baseUrl" (strip-trailing-slashes base-url)}))
                        (filter #(seq (get % "baseUrl"))))
        merged (if local (cons local configured) configured)]
    (:out (reduce (fn [{:keys [seen] :as acc} route]
                    (let [id (str/trim (get route "providerId"))]
                      (if (or (empty? id) (contains? seen id))
                        acc
                        (cond-> (update acc :seen conj id)
                          (seq (str/trim (get route "baseUrl"))) (update :out conj route)))))
                  {:seen #{} :out []}
                  merged))))
