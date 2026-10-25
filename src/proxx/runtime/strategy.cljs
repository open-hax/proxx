(ns proxx.runtime.strategy
  "JS edge for the provider-strategy kernels (src/lib/provider-strategy/**).

  Decisions live in pure `proxx.strategy.*` namespaces; this namespace converts
  JS <-> string-keyed data, reads the clock, and owns the few stateful objects
  (stream accumulators). Property writes use `aset`; host objects are `^js`."
  (:require ["node:crypto" :as crypto]
            [clojure.string :as str]
            [proxx.policy.loader :as loader]
            [proxx.runtime :as runtime]
            [proxx.runtime.factory :as factory-edge]
            [proxx.strategy.attempt :as attempt]
            [proxx.strategy.build :as build]
            [proxx.strategy.diagnostics :as diagnostics]
            [proxx.strategy.executor :as executor]
            [proxx.strategy.select :as select]
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

;; ---------------------------------------------------------------------------
;; Attempt verdicts
;; ---------------------------------------------------------------------------

(defn- outcome->js
  "A `continue` attempt outcome as the camelCase object the router reads."
  [outcome]
  (let [o #js {"kind" "continue"}]
    (doseq [[k v] outcome :when (some? v)]
      (aset o (kebab->camel k)
            (if (= :upstream-auth-error k) (->camel-js v) v)))
    o))

(defn failed-body-needed-js [status]
  (undefined-if-nil (some-> (attempt/failure-body-needed status) name)))

(defn failed-attempt-outcome-js [^js facts]
  (outcome->js (attempt/failed-outcome {:status (.-status facts)
                                        :missing-model? (true? (.-missingModel facts))
                                        :model-not-supported? (true? (.-modelNotSupported facts))
                                        :auth-message (.-authMessage facts)
                                        :error-body (.-errorBody facts)})))

(defn is-event-stream-content-type-js [content-type]
  (attempt/event-stream-content-type? content-type))

(defn is-event-stream-or-untyped-js [content-type]
  (attempt/event-stream-or-untyped? content-type))

(defn ok-body-verdict-js [body-text ^js facts]
  (name (attempt/ok-body-verdict body-text {:client-wants-stream? (true? (.-clientWantsStream facts))
                                            :stream-like? (true? (.-streamLike facts))
                                            :images-passthrough? (true? (.-imagesPassthrough facts))
                                            :provider-id (.-providerId facts)})))

(defn success-mode-js [^js facts]
  (name (attempt/success-mode {:client-wants-stream? (true? (.-clientWantsStream facts))
                               :needs-reasoning-trace? (true? (.-needsReasoningTrace facts))})))

(defn missing-reasoning-skips-js [^js facts has-reasoning]
  (attempt/missing-reasoning-skips? {:needs-reasoning-trace? (true? (.-needsReasoningTrace facts))
                                     :has-more-candidates? (true? (.-hasMoreCandidates facts))}
                                    (true? has-reasoning)))

(defn is-chat-completion-response-js [value] (attempt/chat-completion-response? (js->clj value)))

(defn- read-with-timeout
  "`reader.read()` racing a timeout that rejects with `message`."
  [^js reader timeout-ms message]
  (let [timer (atom nil)
        timeout (js/Promise. (fn [_ reject] (reset! timer (js/setTimeout #(reject (js/Error. message)) timeout-ms))))]
    (-> (js/Promise.race #js [(.read reader) timeout])
        (.finally (fn [] (when @timer (js/clearTimeout @timer)))))))

(defn- cancel-quietly [^js reader]
  (-> (js/Promise.resolve (.cancel reader)) (.catch (fn [_] nil))))

(defn ^:async bootstrap-event-stream-js
  "Read an OK event stream until it proves itself (substantive data, no quota error,
  and a reasoning trace when one is required and another candidate remains), or
  fails. Resolves to `{kind:\"ready\", reader, bufferedChunks}` or a `continue`
  outcome; the reader is cancelled on every failure."
  [^js response ^js opts]
  (if-not (.-body response)
    #js {"kind" "continue" "requestError" true}
    (let [reader (.getReader (.-body response))
          decoder (js/TextDecoder.)
          facts {:needs-reasoning-trace? (true? (.-needsReasoningTrace opts))
                 :has-more-candidates? (true? (.-hasMoreCandidates opts))}
          wants-reasoning? (and (:needs-reasoning-trace? facts) (:has-more-candidates? facts))
          judge (fn [text done?]
                  (let [clean (runtime/strip-sse-comment-lines-js text)
                        quota? (runtime/stream-payload-indicates-quota-error-js clean)
                        substantive? (and (not quota?) (runtime/stream-payload-has-substantive-chunks-js clean))
                        reasoning? (or (not wants-reasoning?) (not substantive?) (runtime/stream-payload-has-reasoning-trace-js clean))]
                    (attempt/bootstrap-verdict {:quota? quota? :substantive? substantive? :reasoning? reasoning? :done? done?} facts)))
          fail (fn [flags] (outcome->js flags))]
      (try
        (loop [chunks [] text ""]
          (let [result (await (read-with-timeout reader (.-timeoutMs opts) "stream bootstrap timeout"))
                done? (.-done result)
                value (.-value result)]
            (if done?
              (let [verdict (judge (str text (.decode decoder)) true)]
                (if (= :ready verdict)
                  #js {"kind" "ready" "reader" reader "bufferedChunks" (to-array chunks)}
                  (do (await (cancel-quietly reader))
                      (fail (:continue verdict)))))
              (if (or (nil? value) (zero? (.-byteLength value)))
                (recur chunks text)
                (let [chunks (conj chunks value)
                      text (str text (.decode decoder value #js {"stream" true}))
                      verdict (judge text false)]
                  (cond
                    (= :ready verdict) #js {"kind" "ready" "reader" reader "bufferedChunks" (to-array chunks)}
                    (= :read-more verdict) (recur chunks text)
                    :else (do (await (cancel-quietly reader))
                              (fail (:continue verdict)))))))))
        (catch :default _
          (await (cancel-quietly reader))
          #js {"kind" "continue" "requestError" true})))))

;; ---------------------------------------------------------------------------
;; The routing loop's state machine
;; ---------------------------------------------------------------------------

(defn- kebab-key [k] (keyword (str/replace (name k) #"([a-z])([A-Z])" (fn [[_ a b]] (str a "-" (str/lower-case b))))))

(defn- event->clj
  "Event facts from JS: camelCase keys become kebab keywords (at any depth);
  `type`/`variant` become keywords, and the credential `authType` its keyword."
  [event]
  (let [convert (fn convert [x]
                  (cond
                    (map? x) (into {} (map (fn [[k v]] [(kebab-key k) (convert v)])) x)
                    (sequential? x) (mapv convert x)
                    :else x))
        e (convert (js->clj event))]
    (cond-> (-> e
                (update :ctx (fn [c] (reduce (fn [c k] (if (contains? c k) (-> c (assoc (keyword (str (name k) "?")) (get c k)) (dissoc k)) c))
                                             c [:prompt-cache-key :matches-preferred :matches-provisional :preferred-affinity
                                                :health :refresh-available :has-refresh-token :ollama-cloud])))
                (as-> e (if (contains? e :ok) (-> e (assoc :ok? (:ok e)) (dissoc :ok)) e)))
      (:type e) (update :type keyword)
      (:variant e) (update :variant keyword)
      (:kind e) (update :kind keyword)
      (get-in e [:ctx :auth-type]) (update-in [:ctx :auth-type] #(keyword (str/replace % "_" "-"))))))

(defn- summary->js [{:keys [saw-rate-limit saw-request-error saw-upstream-server-error saw-upstream-invalid-request
                            last-upstream-error saw-model-not-found saw-model-not-supported-for-account attempts
                            last-upstream-auth-error]}]
  (->camel-js {:saw-rate-limit saw-rate-limit :saw-request-error saw-request-error
               :saw-upstream-server-error saw-upstream-server-error
               :saw-upstream-invalid-request saw-upstream-invalid-request
               :last-upstream-error (some-> last-upstream-error ->camel-js)
               :saw-model-not-found saw-model-not-found
               :saw-model-not-supported-for-account saw-model-not-supported-for-account
               :attempts attempts
               :last-upstream-auth-error (some-> last-upstream-auth-error ->camel-js)}))

(defn- holder [state] #js {"state" state})

(defn create-executor-state-js
  "Opaque state for a routing run: `{reassignmentAllowed, sticky}`."
  [^js opts]
  (holder (executor/initial-state {:reassignment-allowed? (.-reassignmentAllowed opts) :sticky? (.-sticky opts)})))

(defn executor-step-js
  "Advance the routing state machine with an attempt event. Resolves to
  `{state, effects, next, attempts, abort}`; `state` is the next opaque state."
  [^js state-holder event manifest-path]
  (let [{:keys [state effects next]} (executor/step (.-state state-holder) (attempt-policy manifest-path) (event->clj event))]
    #js {"state" (holder state)
         "effects" (clj->js effects)
         "next" (undefined-if-nil (some-> next name))
         "attempts" (get-in state [:accumulator :attempts])
         "abort" (boolean (:abort? state))}))

(defn executor-summary-js [^js state-holder]
  (summary->js (:accumulator (.-state state-holder))))

(defn throttle-plan-js [cooldown-ms manifest-path]
  (let [{:keys [wait-ms short-cooldown-ms]} (executor/throttle-plan (attempt-policy manifest-path) cooldown-ms)]
    #js {"waitMs" wait-ms "shortCooldownMs" short-cooldown-ms}))

(defn throttle-retry-verdict-js [^js facts]
  (name (executor/throttle-retry-verdict {:rate-limited? (true? (.-rateLimited facts))
                                          :ok? (true? (.-ok facts))
                                          :retry-kind (.-retryKind facts)})))

(defn quota-base-cooldown-ms-js [^js facts manifest-path]
  (executor/quota-base-cooldown-ms (attempt-policy manifest-path)
                                   {:status (.-status facts)
                                    :auth-type (keyword (str/replace (.-authType facts) "_" "-"))
                                    :account-provider-id (.-accountProviderId facts)
                                    :key-cooldown-ms (.-keyCooldownMs facts)}))

(defn transient-status-js [^js facts manifest-path]
  (undefined-if-nil (some-> (executor/transient-status (attempt-policy manifest-path)
                                                       {:status (.-status facts)
                                                        :provider-id (.-providerId facts)
                                                        :has-retry-remaining? (true? (.-hasRetryRemaining facts))})
                            name)))

(defn images-next-base-js [^js facts]
  (executor/images-next-base? {:status (.-status facts)
                               :try-next-base-on-statuses (some-> (.-tryNextBaseOnStatuses facts) array-seq)
                               :next-base-differs? (true? (.-nextBaseDiffers facts))}))

(defn max-sticky-transport-failures-js [manifest-path]
  (:attempt/max-sticky-transport-failures (attempt-policy manifest-path)))

;; ---------------------------------------------------------------------------
;; Strategy selection
;; ---------------------------------------------------------------------------

(defonce ^:private registries (atom {}))

(defn- registry [manifest-path]
  (let [manifest-path (or manifest-path default-manifest)]
    (or (get @registries manifest-path)
        (let [r (select/registry-from-contracts (loader/load-policy-contracts! manifest-path))]
          (swap! registries assoc manifest-path r)
          r))))

(defn- facts->clj [^js facts]
  {:route-provider-id (.-routeProviderId facts)
   :responses-passthrough (.-responsesPassthrough facts)
   :images-passthrough (.-imagesPassthrough facts)
   :embeddings-passthrough (.-embeddingsPassthrough facts)
   :explicit-ollama (.-explicitOllama facts)
   :local-ollama (.-localOllama facts)
   :open-ai-prefixed (.-openAiPrefixed facts)
   :factory-prefixed (.-factoryPrefixed facts)
   :policy-preferred-mode (.-policyPreferredMode facts)
   :factory-model-type (.-factoryModelType facts)
   :embedding-provider (select/embedding-provider-header (js->clj (.-clientHeaders facts)))
   :request-body (js->clj (.-requestBody facts))})

(defn select-strategy-js
  "The id of the strategy for the request `facts`. `opts`: `{remoteOnly, preferredMode}`."
  [^js facts ^js opts manifest-path]
  (name (select/select (registry manifest-path) (facts->clj facts)
                       {:remote-only? (true? (some-> opts .-remoteOnly))
                        :preferred-mode (some-> opts .-preferredMode)})))

(defn select-remote-strategy-js
  "The strategy id for one provider route within a request context: route flags are
  recomputed from `provider-id`, local-Ollama is ruled out, and a policy-preferred
  mode (explicit, per provider, or request-wide) wins among the matches."
  [^js facts provider-id openai-provider-id explicit-mode mode-by-provider manifest-path]
  (let [f (select/route-facts (facts->clj facts) provider-id openai-provider-id
                              (when (some? explicit-mode) explicit-mode)
                              (js->clj mode-by-provider))]
    (name (select/select (registry manifest-path) f
                         {:remote-only? true :preferred-mode (:policy-preferred-mode f)}))))

(defn is-compat-embedding-provider-js [provider-id manifest-path]
  (select/compat-embedding-provider? (registry manifest-path) provider-id))

;; ---------------------------------------------------------------------------
;; Strategy payloads and paths
;; ---------------------------------------------------------------------------

(defn build-strategy-payload-js
  "The upstream payload of strategy `id`. `opts`: `{ollamaModelPrefixes}`; Factory's
  system-prompt rewrite reads its wire profile through `manifest-path`."
  [id upstream-body request-body headers ^js opts manifest-path]
  (try
    (clj->js (build/build-payload
              (keyword id)
              {:upstream-body (js->clj upstream-body)
               :request-body (js->clj request-body)
               :headers (js->clj headers)
               :rules (:registry/payload-rules (registry manifest-path))
               :ollama-prefixes (some-> (some-> opts .-ollamaModelPrefixes) js->clj)
               :sanitize-system (fn [text] (factory-edge/sanitize-factory-system-prompt-js (or manifest-path default-manifest) text))}))
    (catch :default e (rethrow-as-error e))))

(defn strategy-upstream-path-js
  "The upstream path of strategy `id`, or undefined when its wire profile owns it."
  [id provider-paths ^js config model manifest-path]
  (let [entry (select/entry (registry manifest-path) (keyword id))
        config-key (get-in entry [:strategy/path :config-key])]
    (undefined-if-nil
     (build/upstream-path entry {:provider-paths (js->clj provider-paths)
                                 :config (when config-key {config-key (aget config config-key)})
                                 :model model}))))

(defn normalize-llamacpp-model-name-js [model] (build/normalize-llamacpp-model model))

(defn strategy-matches-js
  "Does the registry entry `id` accept a request with these facts?"
  [id ^js facts manifest-path]
  (let [reg (registry manifest-path)]
    (select/matches? reg (facts->clj facts) (select/entry reg (keyword id)))))
