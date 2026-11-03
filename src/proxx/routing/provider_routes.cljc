(ns proxx.routing.provider-routes
  "Provider routes: parsing the shapes the policy runtime returns, layering
  configured base urls over declared ones, enriching filtered routes, and
  turning a policy decision into the routes to try (the decision half of
  src/lib/provider-routing.ts).

  A route is wire data: {\"providerId\" \"baseUrl\" \"authRequired\"? \"paths\"?}.
  Provider names are never mentioned here; the few that are facts (the provider
  whose url is the Ollama url) come from the `:provider-surface-facts` contract."
  (:require [clojure.string :as str]))

(defn- strip-trailing-slashes [s] (str/replace s #"/+$" ""))

(defn- coalesce
  "First value under `ks` that is not nil (`a ?? b ?? c`: false and \"\" stop the search)."
  [m ks]
  (reduce (fn [_ k] (let [v (get m k)] (if (some? v) (reduced v) nil))) nil ks))

(defn- text-of
  "`String(x)` for the values a provider id or url can sensibly be."
  [x]
  (cond (string? x) x
        (or (number? x) (boolean? x)) (str x)
        :else ""))

(def ^:private provider-id-keys ["providerId" "provider_id" "provider-id" "provider/id" "id"])
(def ^:private base-url-keys ["baseUrl" "base_url" "base-url" "provider/base-url"])
(def ^:private auth-required-keys
  ["authRequired" "auth_required" "auth-required" "auth-required?" "auth/required?" "required?"])

(defn route-from-raw
  "A route from one raw policy entry, or nil when it lacks a provider id or base url."
  [raw]
  (when (map? raw)
    (let [provider-id (str/trim (text-of (coalesce raw provider-id-keys)))
          base-url (strip-trailing-slashes (str/trim (text-of (coalesce raw base-url-keys))))
          auth-required (coalesce raw auth-required-keys)
          paths (when (map? (get raw "paths"))
                  (into {} (filter (fn [[_ v]] (and (string? v) (seq (str/trim v))))) (get raw "paths")))]
      (when (and (seq provider-id) (seq base-url))
        (cond-> {"providerId" provider-id "baseUrl" base-url}
          (boolean? auth-required) (assoc "authRequired" auth-required)
          (seq paths) (assoc "paths" paths))))))

(defn routes-from-raw
  "Routes from a raw list; nil when `raw` is not a list (distinct from an empty one)."
  [raw]
  (when (sequential? raw) (into [] (keep route-from-raw) raw)))

(defn apply-configured-route-facts
  "Configured base urls win over declared ones. `config` is
  {:openai-provider-id :openai-base-url :ollama-base-url :upstream-provider-base-urls}."
  [facts routes config]
  (if (nil? config)
    (vec routes)
    (mapv (fn [route]
            (let [provider-id (get route "providerId")
                  configured (cond
                               (= provider-id (:openai-provider-id config)) (:openai-base-url config)
                               (= provider-id (:surface/ollama-base-url-provider facts)) (:ollama-base-url config)
                               :else (get (:upstream-provider-base-urls config) provider-id))]
              (if (and (string? configured) (seq (str/trim configured)))
                (assoc route "baseUrl" (strip-trailing-slashes (str/trim configured)))
                route)))
          routes)))

(defn- richness [route]
  (+ (if (false? (get route "authRequired")) 2 0) (if (some? (get route "paths")) 1 0)))

(defn- richest [routes] (first (sort-by richness > routes)))

(defn enrich-filtered-route
  "Fill a filtered route from the richest input route with the same identity
  (provider id and base url), else the richest with the same provider id; the
  filtered route's own fields win."
  [route input-routes]
  (let [identity-of (juxt #(get % "providerId") #(get % "baseUrl"))
        exact (richest (filter #(= (identity-of %) (identity-of route)) input-routes))
        source (or exact (richest (filter #(= (get % "providerId") (get route "providerId")) input-routes)))]
    (if source (merge source route) route)))

(defn filtered-routes
  "Routes the policy kept: the raw list parsed and enriched, or the input routes
  when the result carries no usable list."
  [raw input-routes]
  (mapv #(enrich-filtered-route % input-routes) (or (routes-from-raw raw) (vec input-routes))))

(defn- upstream-mode [modes value]
  (let [raw (if (map? value) (get value "mode") value)]
    (when (and (string? raw) (contains? modes raw)) raw)))

(defn- strategy-modes-by-provider [modes value]
  (when (map? value)
    (let [m (into {} (keep (fn [[provider-id strategy]]
                             (when-let [mode (upstream-mode modes strategy)] [provider-id mode])))
                  value)]
      (when (seq m) m))))

(defn apply-policy-decision
  "The routes to try and the strategy the policy chose. `decision` is the policy
  preview's decision (nil when the preview failed), `modes` the set of known
  upstream strategy modes. A decision that selected providers narrows and orders
  the routes; denied/exhausted leaves none; anything else keeps them all."
  [routes decision modes]
  (let [decision (when (map? decision) decision)
        status (let [s (get decision "status")] (when (string? s) s))
        selected-ids (let [ps (get decision "providers")] (if (sequential? ps) (filter string? ps) []))
        by-id (into {} (map (juxt #(get % "providerId") identity)) routes)
        selected (into [] (keep by-id) selected-ids)
        strategy (upstream-mode modes (get decision "strategy"))
        by-provider (strategy-modes-by-provider modes (coalesce decision ["strategyByProvider" "strategy-by-provider"]))]
    (cond-> {:routes (case status
                       "ok" selected
                       ("denied" "exhausted") []
                       routes)}
      strategy (assoc :strategy-mode strategy)
      by-provider (assoc :strategy-mode-by-provider by-provider))))

(defn next-min-ready
  "Fold one provider's retry delay into the smallest positive delay seen so far (0 = none)."
  [min-ready retry-in-ms]
  (if (and (pos? retry-in-ms) (or (zero? min-ready) (< retry-in-ms min-ready)))
    retry-in-ms
    min-ready))
