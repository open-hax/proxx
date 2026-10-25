(ns proxx.routing.catalog
  "Model catalog decisions (the pure half of src/lib/provider-catalog.ts,
  catalog-resolution.ts and catalog-alias-resolver.ts): assembling the resolved
  catalog from what each provider reported, deciding which models are concrete,
  and applying aliases / disabled models to a requested model.

  Catalog values keep the wire shape the TypeScript callers read (string keys:
  \"modelIds\", \"aliasTargets\", ...); ordered tables are [[k v] ...] entry
  vectors that the edge rebuilds as JS objects."
  (:require [clojure.string :as str]
            [proxx.routing.auto-model :as auto]
            [proxx.routing.model-ids :as ids]
            [proxx.routing.ordered :as om]
            [proxx.routing.surface :as surface]))

;; ---------------------------------------------------------------------------
;; assembling the catalog
;; ---------------------------------------------------------------------------

(defn- trimmed-set [xs] (into #{} (comp (map str/trim) (remove empty?)) xs))

(defn- filter-disabled [models disabled]
  (if (empty? disabled)
    (vec models)
    (let [d (trimmed-set disabled)] (filterv #(not (contains? d %)) models))))

(defn- order-preferred-first [models preferred]
  (if (empty? preferred)
    (vec models)
    (let [p (trimmed-set preferred)
          {yes true no false} (group-by #(contains? p %) models)]
      (into (vec yes) no))))

(defn- merge-provider-catalogs
  "Fold the per-route results into ordered provider catalogs and the discovered model list.
  A provider reported twice keeps the first position; Ollama results extend an existing
  entry's model list and otherwise open one with the Ollama probe paths."
  [facts route-results ollama-results]
  (let [with-routes (reduce (fn [{:keys [catalogs discovered] :as acc} {:keys [provider-id model-ids] :as result}]
                              (if (seq model-ids)
                                {:catalogs (om/om-assoc catalogs provider-id
                                                        {:provider-id provider-id :model-ids model-ids
                                                         :fetched-at (:fetched-at result) :stale false
                                                         :source-endpoints (:source-endpoints result)})
                                 :discovered (into discovered model-ids)}
                                acc))
                            {:catalogs om/empty-om :discovered []}
                            route-results)]
    (reduce (fn [{:keys [catalogs discovered] :as acc} {:keys [provider-id model-ids fetched-at]}]
              (if (seq model-ids)
                {:catalogs (om/om-assoc catalogs provider-id
                                        (if-let [existing (om/om-get catalogs provider-id)]
                                          (assoc existing :model-ids (ids/dedupe-model-ids (concat (:model-ids existing) model-ids)))
                                          {:provider-id provider-id :model-ids model-ids :fetched-at fetched-at :stale false
                                           :source-endpoints (surface/ollama-catalog-paths facts)}))
                 :discovered (into discovered model-ids)}
                acc))
            with-routes
            ollama-results)))

(defn assemble-catalog
  "The resolved catalog from declared models, preferences and what each route reported.

  `preferences` {:preferred :disabled :aliases [[alias target] ...]}; `declared` the models
  declared in models.json; `route-results` / `ollama-results` [{:provider-id :model-ids
  :fetched-at (:source-endpoints)}] in route order; `ollama-route-ids` the provider ids of
  the Ollama routes. Disabled models are dropped, preferred ones lead, declared models
  nobody reported are appended, and aliases (largest tag of each Ollama model, then
  the preferred aliases whose target exists) are added as models of their own."
  [facts {:keys [preferences declared route-results ollama-results ollama-route-ids]}]
  (let [{:keys [preferred disabled aliases]} preferences
        {:keys [catalogs discovered]} (merge-provider-catalogs facts route-results ollama-results)
        disabled-filtered (filter-disabled (ids/dedupe-model-ids discovered) disabled)
        preferred-discovered (filterv (set disabled-filtered) preferred)
        ordered-discovered (order-preferred-first disabled-filtered preferred-discovered)
        declared-filtered (filter-disabled declared disabled)
        known (set disabled-filtered)
        declared-only (filterv #(not (contains? known %)) declared-filtered)
        ordered-models (ids/dedupe-model-ids (concat ordered-discovered declared-only))
        ollama-model-ids (ids/dedupe-model-ids
                          (mapcat #(:model-ids (om/om-get catalogs %)) ollama-route-ids))
        ordered-set (set ordered-models)
        alias-targets (om/om-merge (om/from-entries (ids/largest-model-aliases ollama-model-ids))
                                   (om/from-entries (filter (fn [[_ target]] (contains? ordered-set target)) aliases)))]
    {:model-ids (ids/dedupe-model-ids (concat ordered-models (om/om-js-keys alias-targets)))
     :alias-targets (om/om-entries alias-targets)
     :dynamic-ollama-model-ids ollama-model-ids
     :declared-model-ids declared-filtered
     :provider-catalogs (om/om-entries catalogs)
     :preferences {:preferred preferred-discovered :disabled (vec disabled) :aliases (vec aliases)}}))

(defn local-ollama-route?
  "Is `route-base-url` the configured local Ollama url (case-insensitively, ignoring slashes)?"
  [route-base-url configured-local-url]
  (let [norm (fn [u] (str/lower-case (str/replace (str/trim (str u)) #"/+$" "")))
        route (norm route-base-url) local (norm configured-local-url)]
    (and (seq route) (seq local) (= route local))))

;; ---------------------------------------------------------------------------
;; concrete models
;; ---------------------------------------------------------------------------

(defn- concrete? [alias-targets model-id]
  (not (or (auto/auto-model? model-id) (contains? alias-targets model-id))))

(defn concrete-model-ids
  "Catalog models that are neither auto:* nor aliases; nil without a catalog."
  [catalog]
  (when catalog
    (let [aliases (get catalog "aliasTargets")]
      (filterv #(concrete? aliases %) (get catalog "modelIds")))))

(defn concrete-model-ids-for-providers
  "Concrete models declared (and accepted by `include-declared?`) plus those the given
  providers reported, de-duplicated; nil without a bundle."
  [bundle provider-ids include-declared?]
  (when bundle
    (let [catalog (get bundle "catalog")
          aliases (get catalog "aliasTargets")
          declared (filter #(and (concrete? aliases %) (or (nil? include-declared?) (include-declared? %)))
                           (get catalog "declaredModelIds"))
          reported (mapcat (fn [provider-id]
                             (filter #(concrete? aliases %)
                                     (get-in bundle ["providerCatalogs" provider-id "modelIds"])))
                           provider-ids)]
      (vec (distinct (concat declared reported))))))

;; ---------------------------------------------------------------------------
;; aliases and disabled models
;; ---------------------------------------------------------------------------

(defn resolve-alias
  "How a requested model is treated by the catalog: {:error {...}} when it (or its alias
  target) is disabled, else {:routing-model :alias-applied?}. With
  `preserve-explicit-ollama?`, an explicit Ollama request is not redirected to a
  non-Ollama alias target."
  [facts bundle requested preserve-explicit-ollama?]
  (let [aliases (get-in bundle ["catalog" "aliasTargets"])
        disabled (set (get-in bundle ["preferences" "disabled"]))
        target (get aliases requested)]
    (if (or (contains? disabled requested) (contains? disabled (or target "")))
      {:error {:status 403 :message (str "Model is disabled: " requested)
               :type "invalid_request_error" :code "model_disabled"}}
      (let [routing (if (and (string? target) (seq target))
                      (if (and preserve-explicit-ollama?
                               (surface/explicit-ollama-model? facts requested)
                               (not (surface/explicit-ollama-model? facts target)))
                        requested
                        target)
                      requested)]
        {:routing-model routing :alias-applied? (not= routing requested)}))))
