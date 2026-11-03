(ns proxx.strategy.profile
  "How each registered strategy (78-strategy-registry.edn) is wired, as data:
  where its upstream body comes from, how its path is found, which request
  headers it adds and which provider's reasoning rules apply. The recipes the
  body feeds are in proxx.strategy.build; this says which input a recipe gets.
  `proxx.runtime.strategies` interprets these answers against the host objects.")

(defn payload-source
  "Where the payload recipe of strategy `id` gets its input:
    :normalized         the chat body after model rewrite, reasoning and GLM rules
    :bare-normalized    the same, used as is (no recipe, no service-tier logging)
    :request            the client's raw body (images, embeddings, passthroughs)
    :reasoned-request   the raw body after the reasoning rules of the ollama mode
    :gemini             the normalised body translated to a Gemini payload"
  [id]
  (case id
    (:blaze-images :images-passthrough :factory-responses-passthrough
     :openai-compat-embeddings :ollama-embeddings :hf-embeddings :tei-embeddings :ovm-embeddings)
    :request
    (:ollama-cloud :remote-ollama :ollama) :reasoned-request
    :gemini-chat :gemini
    :local-ollama :bare-normalized
    :normalized))

(defn reasoning-provider
  "The provider whose reasoning rules shape an ollama-mode request."
  [id route-provider-id]
  (case id
    :ollama-cloud "ollama-cloud"
    (or route-provider-id "ollama")))

(defn path-source
  "Where the upstream path of strategy `id` comes from: `:registry` (its
  `:strategy/path`), `:gemini` (model alias), or `[:factory endpoint-type]`."
  [id]
  (case id
    (:factory-responses-passthrough :factory-responses) [:factory "openai"]
    :factory-messages [:factory "anthropic"]
    :factory-chat [:factory "common"]
    :gemini-chat :gemini
    :registry))

(defn header-recipe
  "The request headers strategy `id` adds, by recipe: `:interleaved-beta`
  (Anthropic beta flag for extended thinking), `:factory-common`,
  `:factory-anthropic`, `:gemini-key`; nil for none."
  [id]
  (case id
    :messages :interleaved-beta
    (:factory-responses-passthrough :factory-responses :factory-chat) :factory-common
    :factory-messages :factory-anthropic
    :gemini-chat :gemini-key
    nil))

(defn direct-execution?
  "Does the strategy talk to its upstream itself (an SDK) instead of through fetch?"
  [id]
  (= :gemini-chat id))
