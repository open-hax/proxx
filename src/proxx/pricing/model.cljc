(ns proxx.pricing.model
  "Pure model pricing, energy and water estimation.

  Facts are data: the models.dev price snapshot (`resources/data/*.edn`) and the
  resolution rules (`16-model-pricing-resolution.edn`: provider aliases, vendor
  fallbacks, energy profiles) arrive as arguments; nothing here reads a file, the
  clock or the environment.

  Shapes
    snapshot  {:generated-at str :source-url str
               :providers {provider-id [[model-id cost] ...]}}   ;; model order is semantic
    cost      {:input :output :reasoning :cache-read :cache-write}  ;; USD / 1M tokens, any subset
    indexes   (build-indexes snapshot)
    profile   (profile-from-contracts contracts)
    overrides vector of rules from `parse-override-rules`

  Lookup is `exact alias` first, then the best fuzzy alias score (>= 400) among the
  preferred providers: the routed provider, then the canonical vendors for the model."
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; JavaScript-compatible string primitives. Ordering and trimming are observable
;; (they decide which catalogue entry wins a tie), so they match String.prototype.
;; ---------------------------------------------------------------------------

(defn- trim* [s] #?(:cljs (.trim s) :clj (str/trim s)))
(defn- lower* [s] #?(:cljs (.toLowerCase s) :clj (str/lower-case s)))
(defn- locale-compare [a b] #?(:cljs (.localeCompare a b) :clj (compare a b)))
(defn- split-slash [s] #?(:cljs (vec (.split s "/")) :clj (str/split s #"/" -1)))
(defn- colon->dash [s] (str/replace s ":" "-"))

(defn- finite-number? [x]
  (and (number? x)
       #?(:cljs (js/Number.isFinite x)
          :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x)))))))

(defn- by-length-desc-then-locale [l r]
  (let [d (- (count r) (count l))]
    (if (zero? d) (locale-compare l r) d)))

(defn- ordered-aliases
  "Distinct strings, longest first, ties by locale order (stable)."
  [xs]
  (vec (sort by-length-desc-then-locale (distinct xs))))

(defn- both-forms [s] (when (seq s) [s (colon->dash s)]))

;; ---------------------------------------------------------------------------
;; Model id normalisation
;; ---------------------------------------------------------------------------

(defn normalize-lookup-model
  "Drop a routing prefix (everything through the first `/`), trim, lower-case."
  [model]
  (let [i (str/index-of model "/")]
    (-> (if i (subs model (inc i)) model) trim* lower*)))

(defn candidate-aliases
  "Spellings of `model` to look up, best (longest) first. Includes the `:latest`-less
  form, colon-to-dash forms, and the `glm-5v*` -> `glm-5*` alias models.dev tracks."
  [model]
  (let [normalized (normalize-lookup-model model)
        without-latest (str/replace normalized #":latest$" "")
        glm-aliases (when (str/starts-with? normalized "glm-5v")
                      (let [glm5 (-> normalized
                                     (str/replace #"^glm-5v(?=[-:])" "glm-5")
                                     (str/replace #"^glm-5v$" "glm-5"))
                            glm5-no-v (str/replace normalized #"^glm-5v" "glm-5")]
                        (mapcat (fn [c] (when (not= c normalized) [c (colon->dash c)]))
                                [glm5 glm5-no-v])))]
    (ordered-aliases (concat (mapcat both-forms [normalized without-latest]) glm-aliases))))

(defn- model-id-aliases
  "Every `/`-suffix of a catalogue model id, plus the whole id, with colon variants."
  [model-id]
  (let [normalized (-> model-id trim* lower*)
        parts (split-slash normalized)
        suffixes (map #(str/join "/" (drop % parts)) (range (count parts)))]
    (ordered-aliases (concat (mapcat both-forms suffixes)
                             [normalized (colon->dash normalized)]))))

;; ---------------------------------------------------------------------------
;; Snapshot indexes
;; ---------------------------------------------------------------------------

(defn- index-alias
  "Prefer the entry with the shorter model id when two entries share an alias."
  [alias-index entry alias]
  (let [existing (get alias-index alias)]
    (if (or (nil? existing) (> (count (:model-id existing)) (count (:model-id entry))))
      (assoc alias-index alias entry)
      alias-index)))

(defn build-indexes
  "{:entries {provider [entry]} :alias-index {provider {alias entry}}} for a snapshot."
  [snapshot]
  (reduce-kv
   (fn [acc provider-key models]
     (let [entries (mapv (fn [[model-id cost]]
                           (let [aliases (model-id-aliases model-id)]
                             {:provider-key provider-key :model-id model-id :cost cost
                              :aliases aliases :alias-set (set aliases)}))
                         models)
           alias-index (reduce (fn [idx entry] (reduce #(index-alias %1 entry %2) idx (:aliases entry)))
                               {} entries)]
       (-> acc
           (assoc-in [:entries provider-key] entries)
           (assoc-in [:alias-index provider-key] alias-index))))
   {:entries {} :alias-index {}}
   (:providers snapshot)))

(defn snapshot-status
  "{:generated-at :source-url :provider-count :model-count}."
  [snapshot]
  {:generated-at (:generated-at snapshot)
   :source-url (:source-url snapshot)
   :provider-count (count (:providers snapshot))
   :model-count (transduce (map count) + 0 (vals (:providers snapshot)))})

;; ---------------------------------------------------------------------------
;; Compacting an upstream models.dev payload (string-keyed wire data)
;; ---------------------------------------------------------------------------

(def ^:private cost-fields
  [["input" :input] ["output" :output] ["reasoning" :reasoning]
   ["cache_read" :cache-read] ["cache_write" :cache-write]])

(defn- compact-cost [raw]
  (when (map? raw)
    (let [cost (into {} (keep (fn [[k kw]] (let [v (get raw k)] (when (finite-number? v) [kw v])))) cost-fields)]
      (when (seq cost) cost))))

(defn- raw-cost-of-model [model]
  (when (map? model)
    (let [cost (get model "cost")] (if (map? cost) cost model))))

(defn- sorted-by-key [m] (sort-by key locale-compare m))

(defn compact-snapshot
  "Reduce a models.dev payload (optionally wrapped in {\"providers\" ...}) to a
  snapshot, keeping only priced models, providers and models sorted by locale.
  Throws when nothing is priced."
  [payload generated-at source-url]
  (let [raw-root (if (and (map? payload) (map? (get payload "providers"))) (get payload "providers") payload)
        root (if (map? raw-root) raw-root {})
        providers (into {}
                        (keep (fn [[provider-id provider]]
                                (when (and (map? provider) (map? (get provider "models")))
                                  (let [models (into [] (keep (fn [[model-id model]]
                                                                (when-let [cost (compact-cost (raw-cost-of-model model))]
                                                                  [model-id cost])))
                                                     (sorted-by-key (get provider "models")))]
                                    (when (seq models) [provider-id models])))))
                        (sorted-by-key root))]
    (when (empty? providers)
      (throw (ex-info "models.dev pricing payload did not contain any priced models"
                      {:error/type ::no-priced-models})))
    {:generated-at generated-at :source-url source-url :providers providers}))

;; ---------------------------------------------------------------------------
;; Resolution profile (from policy contracts)
;; ---------------------------------------------------------------------------

(defn- compile-regex [pattern] #?(:cljs (js/RegExp. pattern) :clj (re-pattern pattern)))

(defn- contracts-of [contracts kind] (filter #(= kind (:contract/kind %)) contracts))

(defn snapshot-path
  "Path of the price snapshot named by the `:model-pricing-snapshot` contract."
  [contracts]
  (or (:snapshot/path (first (contracts-of contracts :model-pricing-snapshot)))
      (throw (ex-info "Policy has no :model-pricing-snapshot contract"
                      {:error/type ::missing-snapshot-contract}))))

(defn profile-from-contracts
  "Compile the pricing resolution contracts: provider rules, ordered vendor
  fallbacks and ordered energy profiles with a mandatory default."
  [contracts]
  (let [energy (contracts-of contracts :model-energy-profile)
        ->energy (fn [c] {:joules-per-input-token (:energy/joules-per-input-token c)
                          :joules-per-output-token (:energy/joules-per-output-token c)})
        default (or (some #(when-not (:match/model-pattern %) (->energy %)) energy)
                    (throw (ex-info "Policy has no default :model-energy-profile"
                                    {:error/type ::missing-default-energy-profile})))]
    {:provider-rules (into {} (map (fn [c] [(:match/provider-id c)
                                            {:local? (boolean (:pricing/local c))
                                             :models-dev-provider (:pricing/models-dev-provider c)}]))
                           (contracts-of contracts :model-pricing-provider-rule))
     :vendor-fallbacks (mapv (fn [c] {:prefixes (:match/model-prefixes c)
                                      :providers (:pricing/vendor-providers c)})
                             (contracts-of contracts :model-pricing-vendor-fallback))
     :energy-profiles (into [] (keep (fn [c] (when-let [p (:match/model-pattern c)]
                                               (assoc (->energy c) :pattern (compile-regex p)))))
                            energy)
     :default-energy default}))

;; ---------------------------------------------------------------------------
;; Policy overrides (wire data: string keys, camelCase, untrusted)
;; ---------------------------------------------------------------------------

(defn- non-negative-number [v] (when (and (finite-number? v) (>= v 0)) v))
(defn- nes [v] (when (and (string? v) (seq v)) v))

(defn- compile-edn-regex
  "Compile an EDN-style pattern ((?i) prefix flags allowed) case-insensitively."
  [pattern]
  (let [stripped (-> (trim* pattern)
                     (str/replace #"^\(\?iu\)" "")
                     (str/replace #"^\(\?ui\)" "")
                     (str/replace #"^\(\?i\)" ""))]
    #?(:cljs (js/RegExp. stripped "iu")
       :clj (re-pattern (str "(?iu)" stripped)))))

(defn parse-override-rule
  "A compiled override rule from one wire object, or nil when it cannot be honoured
  (not an object, no model pattern, or a missing/negative input or output price)."
  [value]
  (when (map? value)
    (let [model-pattern (nes (get value "modelPattern"))
          input (non-negative-number (get value "inputPer1MTokens"))
          output (non-negative-number (get value "outputPer1MTokens"))
          string-or-nil #(let [v (get value %)] (when (string? v) v))]
      (when (and model-pattern (some? input) (some? output))
        {:contract-id (or (string-or-nil "contractId") "policy-override")
         :model-pattern (compile-edn-regex model-pattern)
         :provider-pattern (some-> (nes (get value "providerPattern")) compile-edn-regex)
         :mode (if (contains? #{"force" ":force"} (get value "mode")) :force :fallback-unpriced)
         :input input
         :output output
         :reasoning (or (non-negative-number (get value "reasoningPer1MTokens")) 0)
         :cache-read (or (non-negative-number (get value "cacheReadPer1MTokens")) 0)
         :cache-write (or (non-negative-number (get value "cacheWritePer1MTokens")) 0)
         :source (string-or-nil "source")
         :notes (string-or-nil "notes")}))))

(defn parse-override-rules
  "Compiled rules for a sequence of wire objects; anything unusable is dropped."
  [values]
  (into [] (keep parse-override-rule) values))

(defn- matches? [re s] (some? (re-find re s)))

(defn- resolve-override [overrides provider-id model]
  (let [provider (-> provider-id trim* lower*)
        model (normalize-lookup-model model)]
    (some (fn [{:keys [provider-pattern model-pattern] :as rule}]
            (when (and (or (nil? provider-pattern) (matches? provider-pattern provider))
                       (matches? model-pattern model))
              rule))
          overrides)))

;; ---------------------------------------------------------------------------
;; Lookup
;; ---------------------------------------------------------------------------

(defn- direct-provider-key [{:keys [provider-rules]} indexes provider-id]
  (let [normalized (-> provider-id trim* lower*)
        {:keys [local? models-dev-provider]} (get provider-rules normalized)]
    (cond
      local? nil
      models-dev-provider models-dev-provider
      (contains? (:entries indexes) normalized) normalized)))

(defn- vendor-fallback-providers [{:keys [vendor-fallbacks]} model]
  (let [normalized (normalize-lookup-model model)]
    (or (some (fn [{:keys [prefixes providers]}]
                (when (some #(str/starts-with? normalized %) prefixes) providers))
              vendor-fallbacks)
        [])))

(defn preferred-providers
  "models.dev providers to consult, in order: the routed provider, then the vendors."
  [profile indexes provider-id model]
  (reduce (fn [acc provider-key]
            (if (or (some #{provider-key} acc) (not (contains? (:entries indexes) provider-key)))
              acc
              (conj acc provider-key)))
          (if-let [direct (direct-provider-key profile indexes provider-id)] [direct] [])
          (vendor-fallback-providers profile model)))

(defn- scored-candidates
  "Per candidate, the three prefix/substring probes `match-score` needs, computed once."
  [candidates]
  (mapv (fn [c] {:candidate c :dashed (str c "-")}) candidates))

(defn- match-score [{:keys [aliases model-id alias-set]} {:keys [candidate dashed]}]
  (if (contains? alias-set candidate)
    (- 1000 (count model-id))
    (or (some (fn [alias]
                (cond
                  (str/starts-with? alias dashed) (- 850 (count alias))
                  (str/starts-with? alias candidate) (- 750 (count alias))
                  (str/includes? alias candidate) (- 500 (count alias))))
              aliases)
        ##-Inf)))

(defn- find-cost [indexes provider-key candidates scored]
  (when-let [alias-index (get-in indexes [:alias-index provider-key])]
    (or (some #(get alias-index %) candidates)
        (let [[best score] (reduce (fn [acc entry]
                                     (reduce (fn [[_ best-score :as acc] candidate]
                                               (let [score (match-score entry candidate)]
                                                 (if (> score best-score) [entry score] acc)))
                                             acc scored))
                                   [nil ##-Inf]
                                   (get-in indexes [:entries provider-key]))]
          (when (>= score 400) best)))))

(defn- resolve-cost [profile indexes provider-id model]
  (let [candidates (candidate-aliases model)
        scored (scored-candidates candidates)]
    (some #(find-cost indexes % candidates scored)
          (preferred-providers profile indexes provider-id model))))

(defn resolve-energy
  "Joules per input/output token for `model`: first matching energy profile, else the default."
  [{:keys [energy-profiles default-energy]} model]
  (let [normalized (normalize-lookup-model model)]
    (select-keys (or (some #(when (matches? (:pattern %) normalized) %) energy-profiles) default-energy)
                 [:joules-per-input-token :joules-per-output-token])))

;; ---------------------------------------------------------------------------
;; Pricing and estimation
;; ---------------------------------------------------------------------------

(def ^:private zero-prices {:input 0 :output 0 :reasoning 0 :cache-read 0 :cache-write 0})

(defn model-pricing
  "Price and energy profile of `model` as served by `provider-id`.

  {:input :output :reasoning :cache-read :cache-write  ;; USD per 1M tokens
   :joules-per-input-token :joules-per-output-token
   :found? bool :source \"models.dev\"|\"local\"|\"policy\"|\"unpriced\"
   :provider-id? :model-id?}

  Local providers are free. A `:force` override beats the catalogue; a
  `:fallback-unpriced` one applies only when the catalogue has no price."
  [profile indexes overrides provider-id model]
  (let [energy (resolve-energy profile model)
        provider (-> provider-id trim* lower*)]
    (if (:local? (get (:provider-rules profile) provider))
      (merge zero-prices energy {:found? true :source "local"})
      (let [override (resolve-override overrides provider-id model)
            resolved (resolve-cost profile indexes provider-id model)
            policy-price (fn [{:keys [input output reasoning cache-read cache-write]}]
                           (merge {:input input :output output :reasoning reasoning
                                   :cache-read cache-read :cache-write cache-write}
                                  energy
                                  {:found? true :source "policy" :provider-id "policy"
                                   :model-id (normalize-lookup-model model)}))]
        (cond
          (and (nil? resolved) override (not= :force (:mode override))) (policy-price override)
          (nil? resolved) (merge zero-prices energy {:found? false :source "unpriced"})
          (= :force (:mode override)) (policy-price override)
          :else (let [{:keys [cost provider-key model-id]} resolved]
                  (merge zero-prices cost
                         energy
                         {:found? true :source "models.dev"
                          :provider-id provider-key :model-id model-id})))))))

(defn estimate-cost
  "{:cost-usd :energy-joules :water-evaporated-ml} for a request given a pricing
  from `model-pricing` and the data-centre water use efficiency in mL/kWh."
  [pricing prompt-tokens completion-tokens water-ml-per-kwh]
  (let [cost (+ (/ (* prompt-tokens (:input pricing)) 1000000)
                (/ (* completion-tokens (:output pricing)) 1000000))
        energy (+ (* prompt-tokens (:joules-per-input-token pricing))
                  (* completion-tokens (:joules-per-output-token pricing)))]
    {:cost-usd cost
     :energy-joules energy
     :water-evaporated-ml (* (/ energy 3600000) water-ml-per-kwh)}))
