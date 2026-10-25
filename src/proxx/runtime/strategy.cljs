(ns proxx.runtime.strategy
  "JS edge for the provider-strategy kernels (src/lib/provider-strategy/**).

  Decisions live in pure `proxx.strategy.*` namespaces; this namespace converts
  JS <-> string-keyed data, reads the clock, and owns the few stateful objects
  (stream accumulators). Property writes use `aset`; host objects are `^js`."
  (:require ["node:crypto" :as crypto]
            [clojure.string :as str]
            [proxx.policy.loader :as loader]
            [proxx.runtime :as runtime]
            [proxx.strategy.diagnostics :as diagnostics]
            [proxx.strategy.gemini :as gemini]
            [proxx.compat.responses.stream :as stream]
            [proxx.strategy.payload :as payload]
            [proxx.strategy.routing :as routing]
            [proxx.strategy.usage :as usage]))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn- now [] (js/Date.now))

(defn- json-parse [text] (js->clj (js/JSON.parse text)))

(defn- undefined-if-nil [x] (if (nil? x) js/undefined x))

(defn- plain->clj
  "String-keyed data for a JS value. SDK responses are class instances whose own
  properties are plain data, which `js->clj` would otherwise leave untouched."
  [x]
  (if (and (some? x) (identical? "object" (js* "typeof ~{}" x)) (not (array? x)) (not (identical? (type x) js/Object)))
    (js->clj (js/Object.assign #js {} x))
    (js->clj x)))

;; ---------------------------------------------------------------------------
;; Gemini
;; ---------------------------------------------------------------------------

(defn normalize-gemini-reasoning-effort-js [value]
  (undefined-if-nil (gemini/normalize-reasoning-effort value)))

(defn open-ai-messages-to-gemini-contents-js [messages]
  (clj->js (gemini/openai-messages->gemini-contents (js->clj messages))))

(defn extract-system-instructions-js [messages]
  (clj->js (gemini/system-instructions (js->clj messages))))

(defn build-gemini-payload-js [upstream-body routed-model]
  (clj->js (gemini/build-payload (js->clj upstream-body) routed-model)))

(defn gemini-response-to-chat-completion-js [response routed-model]
  (clj->js (gemini/response->chat-completion (plain->clj response) routed-model (now))))

(defn gemini-payload-to-sdk-request-js [model payload]
  (clj->js (gemini/payload->sdk-request model (js->clj payload))))

(defn gemini-upstream-path-js [alias routed-model]
  (gemini/upstream-path (when (some? alias) alias) routed-model))

(defn is-local-gemini-base-url-js [base-url] (gemini/local-base-url? base-url))

(defn is-gemini-sdk-model-js [model] (gemini/sdk-eligible-model? model))

(defn- flags->js [flags]
  (let [o #js {"kind" "continue"}]
    (doseq [[k v] flags]
      (aset o (case k
                :rate-limit "rateLimit"
                :model-not-found "modelNotFound"
                :model-not-supported-for-account "modelNotSupportedForAccount"
                :request-error "requestError"
                :upstream-invalid-request "upstreamInvalidRequest")
            v))
    o))

(defn classify-gemini-sdk-error-js
  "The `continue` attempt outcome for a failure message thrown by the Gemini SDK."
  [message]
  (flags->js (gemini/classify-sdk-error message)))

(defn create-gemini-stream-accumulator-js
  "A stateful accumulator for streamed SDK chunks: `push(chunk)`, then
  `completion(routedModel)` for the final chat completion."
  []
  (let [state (atom gemini/initial-stream)]
    #js {"push" (fn [chunk] (swap! state gemini/stream-step (plain->clj chunk)) nil)
         "completion" (fn [routed-model]
                        (clj->js (gemini/stream->completion @state routed-model (now))))}))

;; ---------------------------------------------------------------------------
;; Shared conversions
;; ---------------------------------------------------------------------------

(defn- kebab->camel [k]
  (str/replace (name k) #"-([a-z])" (fn [[_ c]] (str/upper-case c))))

(defn- ->camel-js
  "A flat JS object from a keyword map, camel-casing keys and leaving out nils."
  [m]
  (let [o #js {}]
    (doseq [[k v] m :when (some? v)]
      (aset o (kebab->camel k) v))
    o))

(defn- sha256-hex [text]
  (-> (.createHash crypto "sha256") (.update text) (.digest "hex")))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defonce ^:private attempt-policies (atom {}))

(defn- attempt-policy
  "The upstream attempt policy for a manifest (default manifest when absent), loaded once."
  [manifest-path]
  (let [manifest-path (or manifest-path default-manifest)]
    (or (get @attempt-policies manifest-path)
        (let [policy (routing/policy-from-contracts (loader/load-policy-contracts! manifest-path))]
          (swap! attempt-policies assoc manifest-path policy)
          policy))))

;; ---------------------------------------------------------------------------
;; Usage extraction and the request-log patch
;; ---------------------------------------------------------------------------

(defn extract-usage-counts-from-sse-text-js [stream-text mode routed-model]
  (->camel-js (usage/counts-from-sse-text stream-text mode routed-model (now))))

(defn usage-counts-for-mode-js [mode upstream-json routed-model]
  (->camel-js (usage/counts-for-mode mode (js->clj upstream-json) routed-model (now))))

(defn- content-type [^js response] (.get (.-headers response) "content-type"))

(defn response-looks-like-event-stream-js [^js response mode]
  (usage/event-stream? (content-type response) mode))

(defn- ^:async read-cloned-response-with-timing
  "Body text of a clone of `response`, with when the first byte and the first
  content arrived."
  [^js response mode]
  (let [clone (.clone response)]
    (if-not (.-body clone)
      {:body-text (await (.text clone)) :completed-at (now) :first-byte-at nil :first-content-at nil}
      (let [event-stream? (usage/event-stream? (content-type response) mode)
            reader (.getReader (.-body clone))
            decoder (js/TextDecoder.)]
        (loop [body-text "" first-byte nil first-content nil]
          (let [result (await (.read reader))]
            (if (.-done result)
              {:body-text (str body-text (.decode decoder))
               :completed-at (now) :first-byte-at first-byte :first-content-at first-content}
              (let [value (.-value result)]
                (if (or (nil? value) (zero? (.-byteLength value)))
                  (recur body-text first-byte first-content)
                  (let [at (now)
                        body-text (str body-text (.decode decoder value #js {"stream" true}))]
                    (recur body-text
                           (or first-byte at)
                           (or first-content
                               (when (if event-stream?
                                       (usage/buffer-substantive? body-text)
                                       (seq (str/trim body-text)))
                                 at)))))))))))))

(defn- ^:async extract-usage-counts [^js response mode routed-model]
  (let [no-usage (fn [] {:counts {} :completed-at (now) :first-byte-at nil :first-content-at nil})]
    (if-not (.-ok response)
      (no-usage)
      (try
        (let [{:keys [body-text] :as read} (await (read-cloned-response-with-timing response mode))
              counts (if (usage/event-stream? (content-type response) mode)
                       (usage/counts-from-sse-text body-text mode routed-model (now))
                       (usage/counts-for-mode mode (json-parse body-text) routed-model (now)))]
          (assoc read :counts counts))
        (catch :default _ (no-usage))))))

(defn ^:async update-usage-counts-from-response-js
  "Read usage out of a clone of `response` and patch the request-log entry with
  counts, cache hit, TTFT, throughput and cost. `estimate-cost` is the pricing
  function (providerId, model, promptTokens, completionTokens) => {costUsd,...}."
  [^js request-log-store entry-id ^js response mode routed-model provider-id ^js config attempt-started-at estimate-cost]
  (let [{:keys [counts completed-at first-byte-at first-content-at]}
        (await (extract-usage-counts response mode routed-model))
        image-cost (usage/image-cost-usd {:by-provider (js->clj (.-imageCostUsdByProvider config))
                                          :default (.-imageCostUsdDefault config)}
                                         provider-id)
        patch (usage/usage-patch counts {:stream? (usage/event-stream? (content-type response) mode)
                                         :completed-at completed-at
                                         :first-content-at (or first-content-at first-byte-at)
                                         :attempt-started-at attempt-started-at
                                         :image-cost image-cost})]
    (when patch
      (let [^js cost (estimate-cost provider-id routed-model
                                (or (:prompt-tokens patch) 0) (or (:completion-tokens patch) 0))
            o (->camel-js patch)]
        (aset o "costUsd" (.-costUsd cost))
        (aset o "energyJoules" (.-energyJoules cost))
        (aset o "waterEvaporatedMl" (.-waterEvaporatedMl cost))
        (.update request-log-store entry-id o)))))

;; ---------------------------------------------------------------------------
;; Diagnostics
;; ---------------------------------------------------------------------------

(defn build-factory-4xx-diagnostics-js [upstream-payload prompt-cache-key]
  (->camel-js (diagnostics/build-factory-4xx-diagnostics
               sha256-hex (js->clj upstream-payload) prompt-cache-key)))

(defn prompt-cache-key-hash-js [request-body]
  (undefined-if-nil (diagnostics/prompt-cache-key-hash sha256-hex (js->clj request-body))))

(defn ^:async update-failed-attempt-diagnostics-js
  "For a failed response, record the upstream's error summary (and, for Factory
  4xx, the request-shape diagnostics) on the request-log entry."
  [^js request-log-store entry-id ^js response provider-id upstream-payload prompt-cache-key]
  (when-not (.-ok response)
    (let [^js summary (await (runtime/summarize-upstream-error-js response))
          factory-4xx? (and (= "factory" provider-id) (>= (.-status response) 400) (< (.-status response) 500))
          message (.-upstreamErrorMessage summary)]
      (when (or factory-4xx? (.-upstreamErrorCode summary) (.-upstreamErrorType summary) message)
        (.update request-log-store entry-id
                 (let [o #js {}]
                   (when message (aset o "error" message))
                   (when (.-upstreamErrorCode summary) (aset o "upstreamErrorCode" (.-upstreamErrorCode summary)))
                   (when (.-upstreamErrorType summary) (aset o "upstreamErrorType" (.-upstreamErrorType summary)))
                   (when message (aset o "upstreamErrorMessage" message))
                   (when factory-4xx?
                     (aset o "factoryDiagnostics" (build-factory-4xx-diagnostics-js upstream-payload prompt-cache-key)))
                   o))))))

;; ---------------------------------------------------------------------------
;; Payload shaping
;; ---------------------------------------------------------------------------

(defn requested-service-tier-js [request-body headers]
  (undefined-if-nil (payload/requested-service-tier (js->clj request-body) (js->clj headers))))

(defn logged-service-tier-js [upstream-payload request-body headers]
  (let [{:keys [service-tier service-tier-source]}
        (payload/logged-service-tier (js->clj upstream-payload)
                                     (when (some? request-body)
                                       {:request-body (js->clj request-body) :headers (js->clj headers)}))]
    #js {"serviceTier" (undefined-if-nil service-tier) "serviceTierSource" service-tier-source}))

(defn strip-trailing-assistant-prefill-js
  "`payload` without trailing assistant items in `input` (the same object when none)."
  [upstream-payload]
  (let [input (aget upstream-payload "input")]
    (if (array? input)
      (let [kept (payload/strip-trailing-assistant-prefill (js->clj upstream-payload))]
        (if (= (count (get kept "input")) (.-length input))
          upstream-payload
          (clj->js kept)))
      upstream-payload)))

(defn ensure-usage-in-stream-js [upstream-payload]
  (clj->js (payload/ensure-usage-in-stream (js->clj upstream-payload))))

(defn prepare-upstream-body-js [request-body routed-model requested-model]
  (clj->js (payload/prepare-upstream-body (js->clj request-body) routed-model requested-model)))

(defn requesty-model-js [model prefix] (payload/requesty-model model prefix))

(defn build-codex-responses-images-body-js [images-body]
  (js/JSON.stringify (clj->js (payload/codex-responses-images-body (js->clj images-body)))))

(defn extract-images-from-responses-output-js [response]
  (undefined-if-nil (some-> (payload/images-from-responses-output (js->clj response) (now)) clj->js)))

(defn extract-images-from-codex-response-js [response-body]
  (undefined-if-nil (some-> (payload/images-from-codex-response (try (json-parse response-body) (catch :default _ nil)) (now))
                            clj->js)))

(defn extract-images-from-codex-event-stream-js [stream-text]
  (undefined-if-nil (some-> (when-let [terminal (stream/extract-terminal-response stream-text)]
                              (payload/images-from-responses-output terminal (now)))
                            clj->js)))

(defn open-ai-content-to-text-js [content] (payload/content->text (js->clj content)))

(defn resolve-usage-attribution-js [^js auth]
  (if (nil? auth)
    #js {}
    (->camel-js (payload/usage-attribution {:kind (.-kind auth) :tenant-id (.-tenantId auth)
                                            :key-id (.-keyId auth) :subject (.-subject auth)}))))

;; ---------------------------------------------------------------------------
;; Credential routing rules
;; ---------------------------------------------------------------------------

(defn should-retry-same-credential-for-server-error-js [status manifest-path]
  (routing/retry-same-credential-for-server-error? (attempt-policy manifest-path) status))

(defn is-transient-provider-retry-js [provider-id status manifest-path]
  (routing/transient-provider-retry? (attempt-policy manifest-path) provider-id status))

(defn should-cooldown-credential-on-auth-failure-js [provider-id status manifest-path]
  (routing/cooldown-on-auth-failure? (attempt-policy manifest-path) provider-id status))

(defn should-permanently-disable-credential-js [^js credential status manifest-path]
  (routing/permanently-disable? (attempt-policy manifest-path) (keyword (str/replace (.-authType credential) "_" "-"))
                                (.-providerId credential) status))

(defn permanent-disable-cooldown-ms-js [manifest-path]
  (routing/permanent-disable-cooldown-ms (attempt-policy manifest-path)))

(defn cooldown-cap-ms-js [kind manifest-path]
  (routing/cooldown-cap-ms (attempt-policy manifest-path) (keyword kind)))

(defn classify-auth-error-js [^js credential provider-id status configured-cooldown-ms manifest-path]
  (let [{:keys [classification cooldown-ms]}
        (routing/classify-auth-error (attempt-policy manifest-path)
                                     (keyword (str/replace (.-authType credential) "_" "-"))
                                     provider-id status configured-cooldown-ms)]
    (->camel-js {:classification (str/replace (name classification) "-" "_") :cooldown-ms cooldown-ms})))

(defn classify-model-not-supported-js [configured-cooldown-ms manifest-path]
  (let [{:keys [classification cooldown-ms]}
        (routing/classify-model-not-supported (attempt-policy manifest-path) configured-cooldown-ms)]
    (->camel-js {:classification (str/replace (name classification) "-" "_") :cooldown-ms cooldown-ms})))

(defn clamp-route-quality-js [latency-ms manifest-path]
  (routing/clamp-route-quality (attempt-policy manifest-path) latency-ms))

(defn account-order-for-request-js [provider-id routed-model plan-types manifest-path]
  (to-array (routing/account-order-for-request (attempt-policy manifest-path) provider-id routed-model
                                               (mapv #(when (string? %) %) (array-seq plan-types)))))

(defn account-order-for-latency-js
  "`facts` is an array of `{planType, ttft, tps}` (ttft/tps absent when unmeasured)."
  [facts manifest-path]
  (to-array (routing/account-order-for-latency
             (attempt-policy manifest-path)
             (mapv (fn [^js f] {:plan-type (.-planType f) :ttft (.-ttft f) :tps (.-tps f)}) (array-seq facts)))))

(defn candidate-order-for-affinities-js
  "`candidates` and `preferred` are arrays of `[providerId, accountId]` pairs."
  [candidates preferred]
  (to-array (routing/candidate-order-for-affinities
             (mapv vec (js->clj candidates))
             (mapv vec (js->clj preferred)))))

(defn candidate-order-for-routes-js
  "`candidates` is an array of `{providerIndex, ttft}` (either absent when unknown)."
  [candidates manifest-path]
  (to-array (routing/candidate-order-for-routes
             (attempt-policy manifest-path)
             (mapv (fn [^js c] {:provider-index (.-providerIndex c) :ttft (.-ttft c)}) (array-seq candidates)))))
