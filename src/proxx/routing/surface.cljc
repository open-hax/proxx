(ns proxx.routing.surface
  "Interpretation of the `:provider-surface-facts` contract
  (76-provider-surface-facts.edn): which providers speak which API, what hosted
  OpenAI model ids look like, which provider ids are dedicated Ollama hosts and
  where a provider's model catalog lives. Every function takes the contract
  (`facts`) first; nothing here knows a provider name."
  (:require [clojure.string :as str]))

(defn facts
  "The `:provider-surface-facts` contract in a compiled policy index."
  [compiled]
  (or (some #(when (= :provider-surface-facts (:contract/kind %)) %)
            (get-in compiled [:index :contracts]))
      (throw (ex-info "Missing provider surface facts"
                      {:error/type :policy/missing-provider-surface-facts}))))

(defn- norm [x] (str/lower-case (str/trim (str x))))

(defn- matches? [pattern s] (boolean (re-find (re-pattern pattern) s)))

(defn- includes? [s sub] (str/includes? s sub))

(defn hosted-openai-family?
  "True for model ids that name a hosted OpenAI family (never a local model)."
  [facts model]
  (let [m (str/lower-case (str model))]
    (boolean (some #(matches? % m) (:surface/hosted-openai-model-patterns facts)))))

(defn dedicated-ollama-provider?
  "True for `ollama-*` provider ids other than the hosted cloud."
  [facts provider-id]
  (matches? (:surface/dedicated-ollama-provider-pattern facts) (norm provider-id)))

(defn- provider-listed? [providers provider-id openai-provider-id]
  (let [p (norm provider-id)
        configured (some-> openai-provider-id norm)]
    (boolean (or (some #{p} providers)
                 (and (seq configured) (= p configured))))))

(defn openai-compatible-provider?
  "Listed OpenAI-compatible provider, or the configured OpenAI provider id."
  [facts provider-id openai-provider-id]
  (provider-listed? (:surface/openai-compatible-providers facts) provider-id openai-provider-id))

(defn responses-provider?
  "Listed Responses-API provider, or the configured OpenAI provider id."
  [facts provider-id openai-provider-id]
  (provider-listed? (:surface/responses-providers facts) provider-id openai-provider-id))

(defn explicit-ollama-model?
  "True when the (trimmed, lower-cased) model id starts with an explicit Ollama prefix."
  [facts model]
  (let [m (norm model)]
    (boolean (some #(str/starts-with? m %) (:surface/explicit-ollama-prefixes facts)))))

(defn legacy-bridge-path?
  [facts path]
  (boolean (some #(str/starts-with? (str path) %) (:surface/legacy-bridge-path-prefixes facts))))

(defn- codex-surface?
  [{:keys [catalog/codex-markers]} {:keys [openai-base-url openai-responses-path openai-chat-completions-path]}]
  (let [base (norm openai-base-url)
        paths [(norm openai-responses-path) (norm openai-chat-completions-path)]]
    (boolean (or (some #(includes? base %) (:openai-base-url-contains codex-markers))
                 (some (fn [path] (some #(includes? path %) (:openai-path-contains codex-markers))) paths)))))

(defn catalog-paths
  "Model catalog endpoints to probe for a provider, in order. `config` carries
  {:openai-provider-id :openai-base-url :openai-responses-path :openai-chat-completions-path}.
  The configured OpenAI provider served through the Codex surface has none."
  [facts config provider-id]
  (let [p (norm provider-id)]
    (if (and (= p (norm (:openai-provider-id config))) (codex-surface? facts config))
      []
      (vec (some #(when (matches? (:match/provider-pattern %) p) (:catalog/paths %))
                 (:catalog/source-paths facts))))))

(defn ollama-catalog-paths [facts] (:catalog/ollama-paths facts))
