(ns proxx.strategy.select
  "Strategy selection: interpret the `:strategy-registry` contract
  (78-strategy-registry.edn) over the facts of a request.

  The registry is an ordered list of descriptors, each with data predicates; this
  namespace evaluates them and returns *ids* (the TypeScript registry maps an id to
  its class). It also owns the request-context facts the selection rules read."
  (:require [clojure.string :as str]))

(defn registry-from-contracts [contracts]
  (or (some #(when (= :strategy-registry (:contract/kind %)) %) contracts)
      (throw (ex-info "Missing strategy registry" {:error/type :policy/missing-strategy-registry}))))

(defn- norm [x] (str/lower-case (str/trim (or x ""))))

(defn compat-embedding-provider?
  "Does this provider speak OpenAI /v1/embeddings natively (so never Ollama's /api/embed)?"
  [registry provider-id]
  (contains? (:registry/compat-embedding-providers registry) (norm provider-id)))

(defn embedding-provider-header
  "The lower-cased first `x-embedding-provider` value, if any."
  [headers]
  (let [raw (get headers "x-embedding-provider")
        value (if (sequential? raw) (first raw) raw)]
    (when (string? value) (norm value))))

(defn looks-like-embedding?
  "An embeddings request: flagged by the route, or an `input` without `messages`."
  [{:keys [embeddings-passthrough request-body]}]
  (boolean (or (true? embeddings-passthrough)
               (and (map? request-body) (contains? request-body "input") (not (contains? request-body "messages"))))))

(defn- predicate [registry facts pred]
  (let [[op k v] pred]
    (case op
      :true (true? (get facts k))
      :not-true (not (true? (get facts k)))
      :eq (= (get facts k) v)
      :not-eq (not= (get facts k) v)
      :in (contains? v (get facts k))
      :fn (case k
            :looks-like-embedding (looks-like-embedding? facts)
            :compat-embed-provider (compat-embedding-provider? registry (:route-provider-id facts)))
      :not (not (predicate registry facts k)))))

(defn matches?
  "Do the facts satisfy every predicate of the entry?"
  [registry facts entry]
  (every? #(predicate registry facts %) (:strategy/match entry)))

(defn matching
  "Ids of the registry entries that match, in priority order. `remote-only?` skips local entries."
  [registry facts remote-only?]
  (into [] (comp (remove #(and remote-only? (:strategy/local? %)))
                 (filter #(matches? registry facts %))
                 (map :strategy/id))
        (:registry/entries registry)))

(defn select
  "The id of the strategy for `facts`: the first match, else the last registry entry
  (the catch-all). With a policy-preferred `mode`, a matching entry of that mode
  wins over earlier matches (remote lookups only)."
  [registry facts {:keys [remote-only? preferred-mode]}]
  (let [entries (:registry/entries registry)
        ids (matching registry facts remote-only?)
        by-id (into {} (map (juxt :strategy/id identity)) entries)]
    (cond
      (empty? ids) (:strategy/id (peek entries))
      (and preferred-mode (some #(when (= preferred-mode (:strategy/mode (by-id %))) %) ids))
      (some #(when (= preferred-mode (:strategy/mode (by-id %))) %) ids)
      :else (first ids))))

(defn infos
  "`{:id :mode :local? :priority}` per strategy, highest priority first."
  [registry]
  (let [entries (:registry/entries registry) n (count entries)]
    (vec (map-indexed (fn [i e] {:id (:strategy/id e) :mode (:strategy/mode e)
                                 :local? (boolean (:strategy/local? e)) :priority (- n i)})
                      entries))))

(defn route-facts
  "Facts for choosing a strategy for one provider route within a request context
  (see `selectRemoteProviderStrategyForRoute`): route flags are recomputed from the
  provider, local-Ollama flags cleared, and the policy mode resolved (explicit,
  then per-provider, then request-wide)."
  [facts provider-id openai-provider-id explicit-mode mode-by-provider]
  (let [normalized (norm provider-id)]
    (assoc facts
           :route-provider-id normalized
           :open-ai-prefixed (= provider-id openai-provider-id)
           :factory-prefixed (= provider-id "factory")
           :explicit-ollama false
           :local-ollama false
           :policy-preferred-mode (or explicit-mode (get mode-by-provider normalized) (:policy-preferred-mode facts)))))
