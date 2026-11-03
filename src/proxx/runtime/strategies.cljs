(ns proxx.runtime.strategies
  "The provider strategies (formerly the classes of src/lib/provider-strategy/
  strategies/*.ts), built from the registry.

  A strategy is a JS object with the interface the routing loop calls (`mode`,
  `isLocal`, `matches`, `getUpstreamPath`, `buildPayload`, `applyRequestHeaders`,
  `handleProviderAttempt`, `handleLocalAttempt`, and `executeDirect` for the SDK
  strategy). What differs between strategies is data in `proxx.strategy.profile`
  (and the registry's own facts); the recipes that shape payloads are in
  `proxx.strategy.build`, the replies in `proxx.runtime.provider-reply`. This
  namespace binds them to the host objects: it holds the effects (Headers,
  fetch, the Gemini SDK) and nothing that decides."
  (:require ["@google/genai" :refer [GoogleGenAI]]
            [clojure.string :as str]
            [proxx.http.reply :as frames]
            [proxx.http.request-facts :as facts]
            [proxx.policy.manifest-path :refer [policy-manifest-path]]
            [proxx.runtime :as runtime]
            [proxx.runtime.factory :as factory]
            [proxx.runtime.glm :as glm]
            [proxx.runtime.provider-reply :as provider-reply]
            [proxx.runtime.reply :as edge]
            [proxx.runtime.responses :as responses]
            [proxx.runtime.strategy :as strategy]
            [proxx.strategy.profile :as profile]))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn- js-record? [v] (and (some? v) (= "object" (js* "typeof ~{}" v))))

(defn- ^js config-of
  "The proxy configuration of a request context (hinted so its fields survive
  advanced compilation)."
  [^js ctx]
  (.-config ctx))

(defn- manifest-of
  "The policy manifest a request context names (undefined for a bare context)."
  [^js ctx]
  (some-> (config-of ctx) .-cljsPolicyManifestPath))

(defn- manifest-or-default [^js ctx] (or (manifest-of ctx) default-manifest))

;; ---------------------------------------------------------------------------
;; Request facts the registry's predicates read
;; ---------------------------------------------------------------------------

(defn selection-facts-js
  "The facts of `ctx` that strategy selection reads (proxx.strategy.select)."
  [^js ctx policy-preferred-mode]
  (let [manifest (manifest-or-default ctx)]
    #js {"routeProviderId" (.-routeProviderId ctx)
         "responsesPassthrough" (.-responsesPassthrough ctx)
         "imagesPassthrough" (.-imagesPassthrough ctx)
         "embeddingsPassthrough" (.-embeddingsPassthrough ctx)
         "explicitOllama" (.-explicitOllama ctx)
         "localOllama" (.-localOllama ctx)
         "openAiPrefixed" (.-openAiPrefixed ctx)
         "factoryPrefixed" (.-factoryPrefixed ctx)
         "policyPreferredMode" (or policy-preferred-mode (.-policyPreferredStrategyMode ctx))
         "factoryModelType" (when (.-factoryPrefixed ctx)
                              (or (factory/get-factory-model-type-js manifest (.-routedModel ctx)) js/undefined))
         "clientHeaders" (.-clientHeaders ctx)
         "requestBody" (.-requestBody ctx)}))

;; ---------------------------------------------------------------------------
;; Payloads
;; ---------------------------------------------------------------------------

(defn- payload-result
  "The payload with its serialised body and the service tier to log (`ctx` nil: none)."
  [^js upstream-payload ^js ctx]
  (let [^js tier (strategy/logged-service-tier-js upstream-payload (when ctx (.-requestBody ctx)) (when ctx (.-clientHeaders ctx)))]
    #js {"upstreamPayload" upstream-payload
         "bodyText" (js/JSON.stringify upstream-payload)
         "serviceTier" (.-serviceTier tier)
         "serviceTierSource" (.-serviceTierSource tier)}))

(defn- normalize-reasoning
  "`body` with the reasoning controls of the routed model's family normalised by
  policy; the body itself when policy has nothing to say."
  [^js ctx body provider-id strategy-mode]
  (let [^js result (runtime/normalize-reasoning-request-js
                    (manifest-or-default ctx)
                    #js {"requestBody" body "modelId" (.-routedModel ctx)
                         "providerId" provider-id "strategyMode" strategy-mode})
        decision (when (= "ok" (.-status result)) (.-decision result))
        normalized (when (js-record? decision) (or (aget decision "request-body") (aget decision "requestBody")))]
    (if (js-record? normalized) normalized body)))

(defn- upstream-body
  "The normalised chat body a translating strategy starts from."
  [^js ctx]
  (let [routed (.-routedModel ctx)
        raw (strategy/prepare-upstream-body-js (.-requestBody ctx) routed (.-requestedModelInput ctx))
        body (normalize-reasoning ctx raw (.-routeProviderId ctx) js/undefined)]
    (if (glm/is-glm-model-js routed) (glm/apply-glm-thinking-js body routed) body)))

(defn- recipe
  "The registry recipe of strategy `id` applied to `body` (and the raw request)."
  [id ^js ctx body]
  (strategy/build-strategy-payload-js
   (name id) body (.-requestBody ctx) (.-clientHeaders ctx)
   #js {"ollamaModelPrefixes" (some-> (config-of ctx) .-ollamaModelPrefixes)}
   (manifest-of ctx)))

(defn- build-payload [id mode ^js ctx]
  (case (profile/payload-source id)
    :normalized (payload-result (recipe id ctx (upstream-body ctx)) ctx)
    :bare-normalized (payload-result (upstream-body ctx) nil)
    :request (payload-result (recipe id ctx js/undefined) ctx)
    :reasoned-request (payload-result
                       (recipe id ctx (normalize-reasoning ctx (.-requestBody ctx)
                                                           (profile/reasoning-provider id (.-routeProviderId ctx)) mode))
                       ctx)
    :gemini (payload-result (strategy/build-gemini-payload-js (upstream-body ctx) (.-routedModel ctx)) ctx)))

;; ---------------------------------------------------------------------------
;; Paths
;; ---------------------------------------------------------------------------

(defn- model-alias
  "The provider-specific alias of the routed model, or nil."
  [^js ctx provider-id]
  (let [^js result (runtime/resolve-model-alias-js (manifest-or-default ctx) (.-routedModel ctx) provider-id)]
    (when (= "ok" (.-status result)) (let [alias (.-alias result)] (when (some? alias) alias)))))

(defn- gemini-provider-id [^js ctx] (or (.-providerId ctx) (.-routeProviderId ctx) "gemini"))

(defn- upstream-path [id ^js ctx]
  (let [source (profile/path-source id)]
    (cond
      (= :gemini source)
      (strategy/gemini-upstream-path-js (model-alias ctx (gemini-provider-id ctx)) (.-routedModel ctx))

      (vector? source)
      (factory/get-factory-endpoint-path-js (policy-manifest-path) (second source))

      :else
      (strategy/strategy-upstream-path-js (name id) (.-providerPaths ctx) (.-config ctx)
                                          (aget (.-requestBody ctx) "model") (manifest-of ctx)))))

;; ---------------------------------------------------------------------------
;; Request headers
;; ---------------------------------------------------------------------------

(defn- set-all! [^js headers ^js entries]
  (doseq [^js entry (array-seq (js/Object.entries entries))]
    (.set headers (aget entry 0) (aget entry 1))))

(defn- apply-headers! [id ^js headers ^js ctx ^js payload]
  (case (profile/header-recipe id)
    :interleaved-beta
    (let [beta (some-> (config-of ctx) .-messagesInterleavedThinkingBeta)]
      (when (and beta (facts/interleaved-thinking? (js->clj payload)))
        (when-some [updated (facts/csv-header-with (.get headers "anthropic-beta") beta)]
          (.set headers "anthropic-beta" updated))))

    :factory-common
    (set-all! headers (factory/build-factory-common-headers-js (policy-manifest-path) (.-routedModel ctx)))

    :factory-anthropic
    (set-all! headers (factory/build-factory-anthropic-headers-js
                       (policy-manifest-path) (.-routedModel ctx) payload
                       (some-> (config-of ctx) .-messagesInterleavedThinkingBeta)))

    ;; Gemini authenticates with an API key header rather than an OpenAI bearer.
    :gemini-key
    (do (.delete headers "authorization")
        (.set headers "x-goog-api-key" (.-token ^js (.-account ctx)))
        (.set headers "content-type" "application/json"))

    nil)
  nil)

;; ---------------------------------------------------------------------------
;; Gemini: the SDK attempt
;; ---------------------------------------------------------------------------

(defn- join-url [base path]
  (str (str/replace base #"/+$" "") "/" (str/replace path #"^/+" "")))

(defn- request-error [] #js {"kind" "continue" "requestError" true})

(defn- gemini-has-reasoning? [completion] (runtime/chat-completion-has-reasoning-content-js completion))

(defn- ^:async stream-gemini!
  "Answer a streamed request: the SDK's chunks are reassembled into one completion
  and sent as a single SSE message (errors are reported in-band once the head is out)."
  [^js reply ^js ctx stream-result]
  (let [^js raw (edge/play! reply (frames/translated-stream-head
                               {:after (frames/provider-frames (.-providerId ctx))}))
        accumulator (strategy/create-gemini-stream-accumulator-js)]
    (await
     (edge/with-queue-lifecycle
       (.-queueSignal ctx) raw
       (fn ^:async relay! []
         (try
           (let [^js make-iterator (aget stream-result js/Symbol.asyncIterator)
                 ^js iterator (.call make-iterator stream-result)]
             (loop []
               (let [^js step (await (.next iterator))]
                 (when-not (.-done step)
                   (js-invoke accumulator "push" (.-value step))
                   (recur)))))
           (when-not (.-writableEnded raw)
             (.write raw (responses/chat-completion-to-sse-js (js-invoke accumulator "completion" (.-routedModel ctx)))))
           (catch :default e
             (when-not (.-writableEnded raw)
               (.write raw (str "data: " (js/JSON.stringify #js {"error" #js {"message" (js/String e)}}) "\n\n"))))
           (finally (edge/end-quietly! raw))))))
    #js {"kind" "handled"}))

;; Test seam: how the SDK client is built (the real one needs the network).
(defonce ^:private genai-factory (atom (fn [options] (GoogleGenAI. options))))

(defn set-genai-factory!
  "Replace how the Gemini SDK client is constructed; returns the previous factory."
  [f]
  (let [previous @genai-factory] (reset! genai-factory f) previous))

(defn- ^:async gemini-sdk-attempt
  [^js reply ^js ctx ^js sdk-payload model]
  (let [api-key (.-token ^js (.-account ctx))
        base-url (.-baseUrl ctx)
        ^js client (@genai-factory (js/Object.assign #js {"apiKey" api-key} (if (seq base-url) #js {"baseUrl" base-url} #js {})))
        ^js sdk-request (strategy/gemini-payload-to-sdk-request-js model sdk-payload)]
    ;; A queue abort must cancel the SDK call, not just the reply.
    (when-let [signal (.-queueSignal ctx)]
      (aset (.-config sdk-request) "abortSignal" signal))
    (if (.-clientWantsStream ctx)
      (await (stream-gemini! reply ctx (await (.generateContentStream (.-models client) sdk-request))))
      (let [response (await (.generateContent (.-models client) sdk-request))
            completion (strategy/gemini-response-to-chat-completion-js response (.-routedModel ctx))]
        (if (and (.-needsReasoningTrace ctx) (not (gemini-has-reasoning? completion)) (.-hasMoreCandidates ctx))
          (request-error)
          (do (edge/play! reply (into (frames/provider-frames (.-providerId ctx)) (frames/json-frames 200 completion)))
              #js {"kind" "handled"}))))))

(defn- ^:async gemini-direct
  [_id apply! upstream-path-of handle-attempt ^js reply ^js ctx ^js payload]
  (let [api-key (.-token ^js (.-account ctx))
        base-url (.-baseUrl ctx)]
    (cond
      (not (seq api-key)) (request-error)

      (strategy/is-local-gemini-base-url-js base-url)
      (let [headers (js/Headers.)]
        (apply! headers ctx payload)
        (await (handle-attempt reply
                               (await (js/fetch (join-url base-url (upstream-path-of ctx))
                                                #js {"method" "POST" "headers" headers "body" (js/JSON.stringify payload)}))
                               ctx)))

      :else
      (let [model (or (model-alias ctx (gemini-provider-id ctx)) (.-routedModel ctx))]
        (try
          (await (gemini-sdk-attempt reply ctx payload model))
          (catch :default e (strategy/classify-gemini-sdk-error-js (js/String e))))))))

;; ---------------------------------------------------------------------------
;; The strategy objects
;; ---------------------------------------------------------------------------

(defonce ^:private built (atom {}))

(defn- build-strategy [id-str]
  (let [id (keyword id-str)
        ^js info (strategy/strategy-facts-js id-str default-manifest)
        mode (.-mode info)
        apply! (fn [headers ctx payload] (apply-headers! id headers ctx payload))
        path-of (fn [ctx] (upstream-path id ctx))
        handle-attempt (fn [reply response ctx] (provider-reply/handle-provider-attempt-js id-str reply response ctx))
        ^js obj #js {"registryId" id-str
                     "mode" mode
                     "isLocal" (.-isLocal info)
                     "matches" (fn [ctx] (strategy/strategy-matches-js id-str (selection-facts-js ctx js/undefined) (manifest-or-default ctx)))
                     "getUpstreamPath" path-of
                     "buildPayload" (fn [ctx] (build-payload id mode ctx))
                     "applyRequestHeaders" (fn [headers ctx payload] (apply! headers ctx payload))
                     "handleProviderAttempt" handle-attempt
                     "handleLocalAttempt" (fn [reply response ctx]
                                            (provider-reply/handle-local-attempt-js id-str reply response ctx))}]
    (when (profile/direct-execution? id)
      (aset obj "executeDirect" (fn [reply ctx payload] (gemini-direct id apply! path-of handle-attempt reply ctx payload))))
    obj))

(defn strategy-for-id-js
  "The strategy registered as `id` (one object per id)."
  [id]
  (or (get @built id)
      (let [s (try (build-strategy id)
                   (catch :default e (throw (if (ex-data e) (js/Error. (str "Strategy registry names unknown strategy '" id "'")) e))))]
        (swap! built assoc id s)
        s)))

(defn strategies-js
  "Every registered strategy, highest priority first."
  []
  (to-array (map strategy-for-id-js (array-seq (strategy/strategy-ids-js default-manifest)))))
