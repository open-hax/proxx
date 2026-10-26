(ns proxx.runtime.attempt-executor
  "The provider routing loop (src/lib/provider-strategy/routing/*): for each
  candidate credential, call upstream, and report what happened.

  The loop only sequences I/O. What a result costs the credential, whether to
  retry, rotate or stop, and what to remember is decided by the pure state
  machine `proxx.strategy.executor` (through `proxx.runtime.strategy`): the loop
  reports an event and interprets the effects it returns, in order. Facts it
  derives before touching the network are in `proxx.strategy.attempt-plan`.

  Host collaborators are JS objects (strategies, reply, stores, key pool); the
  strategy classes are consumed through their methods. The three things only the
  host can supply arrive as `host`: `selectRemoteStrategy(context, providerId)`,
  `estimateRequestCost(providerId, model, promptTokens, completionTokens)` and
  `requestyModelProvider(model)`."
  (:require [proxx.http.url :as url]
            [proxx.runtime :as runtime]
            [proxx.runtime.candidates :as candidates]
            [proxx.runtime.http :as http]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.responses :as responses]
            [proxx.runtime.strategy :as strat]
            [proxx.runtime.telemetry :as telemetry]
            [proxx.strategy.attempt-plan :as plan]))

;; ---------------------------------------------------------------------------
;; Small JS-semantics helpers
;; ---------------------------------------------------------------------------

(defn- truthy? [x] (js* "!!~{}" x))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- transport-error-message [error]
  (let [base (error-message error)
        cause (when (and (some? error) (= "object" (js* "typeof ~{}" error))) (aget error "cause"))]
    (if (and (some? cause) (= "object" (js* "typeof ~{}" cause)))
      (plan/transport-error-message base {:code (aget cause "code") :name (aget cause "name") :message (aget cause "message")})
      base)))

(defn- sleep [ms] (js/Promise. (fn [resolve] (js/setTimeout resolve ms))))

(defn- drain-quietly
  "Read and discard a response body, ignoring failures."
  [^js response]
  (-> (js/Promise.resolve (.arrayBuffer response)) (.catch (fn [_] nil))))

(defn- json-or-nil
  "The parsed JSON of a clone of `response`, or nil when it does not parse."
  [^js response]
  (-> (js/Promise.resolve (.json (.clone response))) (.catch (fn [_] nil))))

(defn- new-accumulator []
  #js {"sawRateLimit" false "sawRequestError" false "sawUpstreamServerError" false
       "sawUpstreamInvalidRequest" false "sawModelNotFound" false
       "sawModelNotSupportedForAccount" false "attempts" 0})

(defn- empty-result [candidate-count]
  #js {"handled" false "candidateCount" candidate-count "summary" (new-accumulator)})

(defn- not-nil [x] (if (nil? x) js/undefined x))

;; ---------------------------------------------------------------------------
;; Candidates (routing/candidate-builder.ts)
;; ---------------------------------------------------------------------------

(defn- finite-number [x] (when (and (number? x) (js/Number.isFinite x)) x))

(defn- affinity-pair [^js a] [(.-providerId a) (.-accountId a)])

(defn- reorder-for-affinities
  "`candidates` reordered so the given affinities come first (proxx.strategy.routing)."
  [candidates affinities]
  (let [order (strat/candidate-order-for-affinities-js
               (to-array (map (fn [^js c] #js [(.-providerId c) (.-accountId ^js (.-account c))]) candidates))
               (to-array (map (fn [a] #js [(.-providerId ^js a) (.-accountId ^js a)]) affinities)))]
    (mapv (fn [i] (nth candidates i)) (array-seq order))))

(defn- ^:async accounts-for-route
  "The ordered accounts of one provider route, or ::skip when the route cannot be tried."
  [^js key-pool ^js route ^js context ^js quota-monitor ^js request-log-store ^js strategy ^js forced]
  (let [provider-id (.-providerId route)
        routed (.-routedModel context)
        ordered (try
                  (let [raw (await (.getRequestOrder key-pool provider-id))]
                    (mapv (fn [i] (aget raw i))
                          (array-seq (strat/account-order-for-request-js
                                      provider-id routed
                                      (.map raw (fn [^js a] (.-planType a))) js/undefined))))
                  (catch :default _ ::failed))]
    (if (and (= ::failed ordered) (not= false (.-authRequired route)))
      ::skip
      (let [accounts (cond (= false (.-authRequired route)) [(candidates/no-auth-account-js provider-id)]
                           (= ::failed ordered) []
                           :else ordered)
            accounts (if (and quota-monitor (.tracksProvider quota-monitor provider-id))
                       (filterv (fn [^js a] (not (.isAccountExhausted quota-monitor (.-accountId a)))) accounts)
                       accounts)
            facts (to-array
                   (map (fn [^js a]
                          (let [^js perf (.getPerfSummary request-log-store provider-id (.-accountId a) routed (.-mode strategy))]
                            #js {"planType" (.-planType a)
                                 "ttft" (when perf (not-nil (.-ewmaTtftMs perf)))
                                 "tps" (when perf (not-nil (.-ewmaTps perf)))}))
                        accounts))
            accounts (mapv (fn [i] (nth accounts i)) (array-seq (strat/account-order-for-latency-js facts js/undefined)))
            accounts (if (.-accountId forced)
                       (filterv (fn [^js a] (= (.-accountId a) (.-accountId forced))) accounts)
                       accounts)]
        accounts))))

(defn- ^:async build-routing-candidates
  "{:candidates [js-candidate] :preferred js-or-nil :provisional js-or-nil}."
  [^js key-pool ^js routes ^js context ^js prompt-affinity-store prompt-cache-key ^js quota-monitor
   ^js request-log-store ^js strategy]
  (let [auth-kind (some-> ^js (.-requestAuth context) .-kind)
        ^js forced (candidates/forced-credential-selection-js auth-kind (.-clientHeaders context))
        by-provider (loop [rs (array-seq routes) acc {}]
                      (if-let [^js route (first rs)]
                        (if (and (.-providerId forced) (not= (.-providerId route) (.-providerId forced)))
                          (recur (rest rs) acc)
                          (let [accounts (await (accounts-for-route key-pool route context quota-monitor request-log-store strategy forced))]
                            (if (= ::skip accounts)
                              (recur (rest rs) acc)
                              (let [route-candidates (mapv (fn [account]
                                                             (let [c #js {"providerId" (.-providerId route)
                                                                          "baseUrl" (.-baseUrl route)
                                                                          "account" account}]
                                                               (when (.-paths route) (aset c "paths" (.-paths route)))
                                                               c))
                                                           accounts)]
                                (recur (rest rs)
                                       (if (seq route-candidates) (assoc acc (.-providerId route) route-candidates) acc))))))
                        acc))
        ^js record (when prompt-cache-key (await (.get prompt-affinity-store prompt-cache-key)))
        ^js affinities (candidates/affinities-from-record-js record)
        preferred (.-preferred affinities)
        provisional (.-provisional affinities)
        route-list (array-seq routes)
        all-candidates (into [] (mapcat (fn [^js route] (get by-provider (.-providerId route)))) route-list)
        provider-index (reduce (fn [m [i ^js route]] (assoc m (.-providerId route) i)) {} (map-indexed vector route-list))
        facts (to-array
               (map (fn [^js c]
                      (let [^js perf (.getPerfSummary request-log-store (.-providerId c) (.-accountId ^js (.-account c))
                                                      (.-routedModel context) (.-mode strategy))
                            ttft (when perf (finite-number (.-ewmaTtftMs perf)))]
                        #js {"providerIndex" (get provider-index (.-providerId c)) "ttft" (not-nil ttft)}))
                    all-candidates))
        sorted (mapv (fn [i] (nth all-candidates i))
                     (array-seq (strat/candidate-order-for-routes-js facts (.-cljsPolicyManifestPath ^js (.-config context)))))]
    {:candidates (reorder-for-affinities sorted (filter some? [preferred provisional]))
     :preferred (when preferred {:provider-id (.-providerId ^js preferred) :account-id (.-accountId ^js preferred)})
     :provisional (when provisional {:provider-id (.-providerId ^js provisional) :account-id (.-accountId ^js provisional)})}))

;; ---------------------------------------------------------------------------
;; Payload shaping per candidate
;; ---------------------------------------------------------------------------

(defn- provider-alias
  "The provider-specific model alias for the routed model, or nil."
  [^js context provider-id]
  (try
    (let [^js result (runtime/resolve-model-alias-js
                      (or (.-cljsPolicyManifestPath ^js (.-config context)) "resources/policies/runtime/00-manifest.edn")
                      (.-routedModel context) provider-id)]
      (when (= "ok" (.-status result))
        (let [alias (.-alias result)] (when (some? alias) alias))))
    (catch :default _ nil)))

(defn- with-upstream-model
  "`payload` with its upstream payload's model replaced (body text re-serialised)."
  [^js payload model]
  (let [upstream (js/Object.assign #js {} (.-upstreamPayload payload) #js {"model" model})]
    (js/Object.assign #js {} payload #js {"upstreamPayload" upstream "bodyText" (js/JSON.stringify upstream)})))

(defn- apply-model-alias [^js payload ^js context provider-id]
  (let [current (.-model ^js (.-upstreamPayload payload))]
    (if (or (not (string? current)) (zero? (count current)))
      payload
      (let [alias (provider-alias context provider-id)]
        (if (or (not (truthy? alias)) (= alias current))
          payload
          (with-upstream-model payload alias))))))

(defn- apply-requesty-prefix [^js payload ^js host provider-id]
  (if (plan/requesty-model? provider-id)
    (let [model (let [m (.-model ^js (.-upstreamPayload payload))] (if (string? m) m ""))
          prefixed (strat/requesty-model-js model (.requestyModelProvider host model))]
      (if (not= prefixed model)
        (with-upstream-model payload prefixed)
        payload))
    payload))

;; ---------------------------------------------------------------------------
;; Request log
;; ---------------------------------------------------------------------------

(defn- record-attempt!
  "Record one upstream attempt; returns the log entry id."
  [^js request-log-store ^js ctx ^js values mode ^js host]
  (let [provider-id (.-providerId values)
        routed (.-routedModel ctx)
        ^js cost (.estimateRequestCost host provider-id routed (or (.-promptTokens values) 0) (or (.-completionTokens values) 0))
        ^js attribution (strat/resolve-usage-attribution-js (.-requestAuth ctx))
        ^js entry (.record request-log-store
                           #js {"tenantId" (.-tenantId attribution)
                                "issuer" (.-issuer attribution)
                                "keyId" (.-keyId attribution)
                                "providerId" provider-id
                                "accountId" (.-accountId values)
                                "authType" (.-authType values)
                                "model" routed
                                "upstreamMode" mode
                                "upstreamPath" (.-upstreamPath values)
                                "status" (.-status values)
                                "latencyMs" (.-latencyMs values)
                                "serviceTier" (.-serviceTier values)
                                "serviceTierSource" (.-serviceTierSource values)
                                "promptTokens" (.-promptTokens values)
                                "completionTokens" (.-completionTokens values)
                                "totalTokens" (.-totalTokens values)
                                "imageCount" (.-imageCount values)
                                "imageCostUsd" (.-imageCostUsd values)
                                "promptCacheKeyHash" (strat/prompt-cache-key-hash-js (.-requestBody ctx))
                                "promptCacheKeyUsed" (.-promptCacheKeyUsed values)
                                "ttftMs" (.-latencyMs values)
                                "factoryDiagnostics" (.-factoryDiagnostics values)
                                "error" (.-error values)
                                "costUsd" (.-costUsd cost)
                                "energyJoules" (.-energyJoules cost)
                                "waterEvaporatedMl" (.-waterEvaporatedMl cost)})]
    (.-id entry)))

(defn- attempt-values
  "The `recordAttempt` values common to every attempt of this candidate."
  [^js candidate ^js account upstream-path ^js payload ^js status-and-latency prompt-cache-key]
  (let [^js o #js {"providerId" (.-providerId candidate)
                   "accountId" (.-accountId account)
                   "authType" (.-authType account)
                   "upstreamPath" upstream-path
                   "status" (.-status status-and-latency)
                   "latencyMs" (.-latencyMs status-and-latency)
                   "serviceTier" (.-serviceTier payload)
                   "serviceTierSource" (.-serviceTierSource payload)
                   "factoryDiagnostics" (strat/build-factory-4xx-diagnostics-js (.-upstreamPayload payload) prompt-cache-key)}]
    o))

;; ---------------------------------------------------------------------------
;; The loop
;; ---------------------------------------------------------------------------

(defn- ^:async fetch-upstream [^js env url ^js headers body]
  (await (http/fetch-with-response-timeout-js
          url
          #js {"method" "POST" "headers" headers "body" body "signal" (:queue-signal env)}
          (.-upstreamAttemptTimeoutMs ^js (:context env)))))

(defn- upstream-headers
  "The request headers for `account`, with the strategy's own applied."
  [^js env ^js account ^js provider-context ^js candidate-strategy ^js payload]
  (let [^js context (:context env)
        ^js config (.-config context)
        headers (js/Headers.
                 (proxy/upstream-headers-for-credential-js
                  (.-clientHeaders context) account
                  #js {"useOpenAiCodexHeaderProfile"
                       (plan/codex-header-profile? (.-providerId ^js (:candidate env)) (.-authType account)
                                                   (.-openaiProviderId config))}))]
    (.applyRequestHeaders candidate-strategy headers provider-context (.-upstreamPayload payload))
    headers))

(defn- ^:async run-effects!
  "Interpret the state machine's effects against the stores and the key pool."
  [^js env effects ^js account ^js at]
  (let [^js key-pool (:key-pool env) ^js context (:context env) provider-id (.-providerId ^js (:candidate env))
        ^js health (:health-store env) cache-key (:prompt-cache-key env)]
    (doseq [^js effect (array-seq effects)]
      (let [kind (aget effect 0) a (aget effect 1) b (aget effect 2)]
        (case kind
          "mark-rate-limited" (.markRateLimited key-pool account (not-nil a))
          "disable-account" (when (.-disableAccount key-pool) (.disableAccount key-pool (.-providerId account) (.-accountId account)))
          "mark-model-unsupported" (when (.-markModelUnsupported key-pool) (.markModelUnsupported key-pool account (.-routedModel context) a))
          "clear-model-unsupported" (when (.-clearModelUnsupported key-pool)
                                      (.clearModelUnsupported key-pool (.-providerId account) (.-accountId account) (.-routedModel context)))
          "clear-account-cooldown" (when (.-clearAccountCooldown key-pool)
                                     (.clearAccountCooldown key-pool (.-providerId account) (.-accountId account)))
          "pheromone" (if (= a "success")
                        (await (.noteSuccess ^js (:pheromone-store env) provider-id (.-routedModel context) b))
                        (await (.noteFailure ^js (:pheromone-store env) provider-id (.-routedModel context))))
          "health" (when health
                     (if (= a "success")
                       (.recordSuccess health account (.-status at))
                       (if (string? b)
                         (.recordFailure health account (.-status at) b)
                         (.recordFailure health account (.-status at)))))
          "delete-affinity" (await (.delete ^js (:prompt-affinity-store env) cache-key))
          "note-affinity-success" (await (.noteSuccess ^js (:prompt-affinity-store env) cache-key provider-id (.-accountId account)))
          "log-upstream-error" (.update ^js (:request-log-store env) (.-logEntryId at)
                                        #js {"upstreamErrorCode" a "upstreamErrorMessage" b})
          "emit-response" (when (.-emitResponse at) ((.-emitResponse at)))
          "summarize-error" (await (runtime/summarize-upstream-error-js (.-response at)))
          "sleep" (await (sleep (* (.-upstreamTransientRetryBackoffMs ^js (.-config context))
                                   (inc (or (.-retryIndex at) 0)))))
          nil)))))

(defn- at [& kvs] (let [o #js {}] (doseq [[k v] (partition 2 kvs)] (aset o k v)) o))

(defn- exec-ctx
  "Facts about who is being tried, as the state machine reads them."
  [^js env ^js account]
  (let [^js candidate (:candidate env) ^js key-pool (:key-pool env)
        provider-id (.-providerId candidate)
        preferred (:preferred env) provisional (:provisional env)]
    #js {"providerId" provider-id
         "accountProviderId" (.-providerId account)
         "authType" (.-authType account)
         "hasRefreshToken" (truthy? (.-refreshToken account))
         "keyCooldownMs" (.-keyCooldownMs ^js (.-config ^js (:context env)))
         "promptCacheKey" (truthy? (:prompt-cache-key env))
         "matchesPreferred" (plan/affinity-match? provider-id (.-accountId account) preferred)
         "matchesProvisional" (plan/affinity-match? provider-id (.-accountId account) provisional)
         "preferredAffinity" (some? preferred)
         "health" (truthy? (:health-store env))
         "refreshAvailable" (truthy? (:refresh-expired-token env))
         "ollamaCloud" (and (= "ollama-cloud" (.-providerId account)) (truthy? (.-clearAccountCooldown key-pool)))}))

(defn- advance! [^js env event]
  (let [^js result (strat/executor-step-js @(:exec env) event (:manifest-path env))]
    (vreset! (:exec env) (.-state result))
    result))

(defn- ^:async codex-images-reply
  "Translate a Codex Responses reply into an Images API reply. Resolves to
  :handled (answered the client), or :failed (the stream carried an error / no image)."
  [^js env ^js reply ^js provider-context ^js response ^js span]
  (let [text (await (.text response))
        content-type (or (.get (.-headers response) "content-type") "")
        event-stream? (strat/is-event-stream-or-untyped-js content-type)]
    (if (and event-stream? (responses/responses-event-stream-to-error-payload-js text))
      (do (.setStatus span "error" "codex_responses_stream_error") (.end span)
          (advance! env #js {"type" "codex-images-failed"})
          :failed)
      (let [images (if event-stream?
                     (strat/extract-images-from-codex-event-stream-js text)
                     (strat/extract-images-from-codex-response-js text))]
        (if images
          (do (.header reply "x-open-hax-upstream-provider" (.-providerId provider-context))
              (.header reply "x-open-hax-upstream-mode" "codex_responses_images")
              (.code reply 200)
              (.header reply "content-type" "application/json")
              (.send reply images)
              (.setStatus span "ok") (.end span)
              :handled)
          (do (.setStatus span "error" "codex_responses_no_image_output") (.end span)
              (advance! env #js {"type" "codex-images-failed"})
              :failed))))))

(defn- ^:async refresh-and-retry!
  "After a declined attempt that asked for a token refresh: refresh, retry once
  with the new credential. Resolves to :handled, :break (the retry ended the attempt) or
  :continue-routing (the refresh failed: the caller records the declined attempt)."
  [^js env ^js reply ^js provider-context ^js candidate-strategy ^js candidate-payload ^js span
   upstream-url upstream-path effective-body codex-images? ^js declined-outcome ^js upstream-response
   request-log-entry-id ^js ctx release-in-flight!]
  (let [^js candidate (:candidate env) ^js account (.-account candidate) ^js context (:context env)
        ^js key-pool (:key-pool env) ^js host (:host env) cache-key (:prompt-cache-key env)
        ^js request-log-store (:request-log-store env)
        mode (.-mode candidate-strategy)
        ^js refreshed (await ((:refresh-expired-token env) account))]
    (if-not refreshed
      (do (await (run-effects! env (.-effects (advance! env #js {"type" "refresh-failed" "ctx" ctx "ok" (.-ok upstream-response) "outcome" declined-outcome}))
                               account (at "status" (.-status upstream-response) "response" upstream-response "logEntryId" request-log-entry-id)))
          :continue-routing)
      (let [refreshed-ctx (exec-ctx env refreshed)
            ^js refreshed-provider-context (js/Object.assign #js {} provider-context #js {"account" refreshed})
            refreshed-headers (upstream-headers env refreshed refreshed-provider-context candidate-strategy candidate-payload)
            refreshed-release (.markInFlight key-pool refreshed)
            refreshed-started (js/Date.now)
            refreshed-response (try (await (fetch-upstream env upstream-url refreshed-headers effective-body))
                                    (catch :default error
                                      (refreshed-release) (release-in-flight!)
                                      (throw error)))]
        (try
          (let [latency (- (js/Date.now) refreshed-started)
                log-id (record-attempt! request-log-store refreshed-provider-context
                                        (let [^js v (attempt-values candidate refreshed upstream-path candidate-payload
                                                                    (at "status" (.-status refreshed-response) "latencyMs" latency) cache-key)]
                                          (aset v "promptCacheKeyUsed" (truthy? cache-key)) v)
                                        mode host)
                diagnostics (strat/update-failed-attempt-diagnostics-js request-log-store log-id refreshed-response
                                                                           (.-providerId candidate) (.-upstreamPayload candidate-payload) cache-key)
                usage (strat/update-usage-counts-from-response-js request-log-store log-id refreshed-response mode (.-routedModel context)
                                                                     (.-providerId candidate) (.-config context) refreshed-started
                                                                     (.-estimateRequestCost host))]
            (if (and (strat/response-looks-like-event-stream-js refreshed-response mode) (.-clientWantsStream context))
              nil
              (await usage))
            (await diagnostics)
            (if (= 429 (.-status refreshed-response))
              (let [cooldown (await (proxy/extract-rate-limit-cooldown-ms-js refreshed-response))]
                (await (run-effects! env (.-effects (advance! env #js {"type" "refreshed-rate-limited" "cooldownMs" cooldown})) refreshed (at)))
                (await (drain-quietly refreshed-response))
                :break)
              (if (and codex-images? (.-ok refreshed-response))
                (let [r (await (codex-images-reply env reply refreshed-provider-context refreshed-response span))]
                  (if (= :handled r)
                    (do (await (run-effects! env (.-effects (advance! env #js {"type" "handled" "variant" "refreshed-codex" "ctx" refreshed-ctx "latencyMs" latency}))
                                             refreshed (at "status" (.-status refreshed-response))))
                        (release-in-flight!)
                        :handled)
                    :break))
                (do (.header reply "x-open-hax-upstream-mode" mode)
                    (let [^js outcome (await (.handleProviderAttempt candidate-strategy reply refreshed-response refreshed-provider-context))]
                      (if (= "handled" (.-kind outcome))
                        (do (.setStatus span "ok") (.end span)
                            (await (run-effects! env (.-effects (advance! env #js {"type" "handled" "variant" "refreshed-strategy" "ctx" refreshed-ctx
                                                                                  "ok" (.-ok refreshed-response) "latencyMs" latency}))
                                                 refreshed (at "status" (.-status refreshed-response))))
                            (release-in-flight!)
                            :handled)
                        (do (await (run-effects! env (.-effects (advance! env #js {"type" "refreshed-declined" "ctx" refreshed-ctx
                                                                                  "status" (.-status refreshed-response) "ok" (.-ok refreshed-response)
                                                                                  "outcome" outcome}))
                                                 refreshed (at "status" (.-status refreshed-response))))
                            :break)))))))
          (finally (refreshed-release)))))))

(defn- ^:async attempt-step!
  "One upstream request for the current candidate. Resolves to one of
  :handled (the client was answered; in-flight released), :next-step (try the
  next upstream base), :break (stop this credential), :break-transient (stop,
  then retry the same credential)."
  [^js env ^js reply step-index steps ^js base-context ^js candidate-strategy ^js candidate-payload
   primary-path ^js release-in-flight! retry-index has-retry-remaining?]
  (let [^js candidate (:candidate env) ^js account (.-account candidate) ^js context (:context env)
        ^js config (.-config context) ^js host (:host env) manifest (:manifest-path env)
        ^js request-log-store (:request-log-store env) ^js event-store (:event-store env)
        ^js quota-monitor (:quota-monitor env) ^js health (:health-store env) ^js key-pool (:key-pool env)
        cache-key (:prompt-cache-key env)
        step (nth steps step-index)
        upstream-path (:path step)
        attempt (.-attempts (advance! env #js {"type" "attempt-started"}))
        ^js provider-context (js/Object.assign #js {} base-context #js {"baseUrl" (:base-url step) "attempt" attempt})
        provider-id (.-providerId candidate)
        mode (.-mode candidate-strategy)
        upstream-url (url/join-url (.-baseUrl provider-context) upstream-path)
        request-headers (upstream-headers env account provider-context candidate-strategy candidate-payload)
        started (js/Date.now)
        ^js span (.startSpan ^js (telemetry/get-telemetry-js) "proxy.upstream_attempt"
                             #js {"proxy.provider_id" provider-id
                                  "proxy.account_id" (.-accountId account)
                                  "proxy.auth_type" (.-authType account)
                                  "proxy.upstream_mode" mode
                                  "proxy.upstream_path" upstream-path
                                  "proxy.model" (.-routedModel context)
                                  "proxy.requested_model" (.-requestedModelInput context)
                                  "proxy.base_url" (.-baseUrl provider-context)
                                  "proxy.routing_attempt" attempt})
        _ (.setAttributes span #js {"proxy.service_tier" (.-serviceTier candidate-payload)
                                    "proxy.service_tier_source" (.-serviceTierSource candidate-payload)})
        codex-images? (= :openai-codex-responses-images (:kind step))
        effective-body (if codex-images?
                         (strat/build-codex-responses-images-body-js (.-upstreamPayload candidate-payload))
                         (.-bodyText candidate-payload))
        entry-id (str provider-id ":" (.-accountId account) ":" (js/Date.now))
        _ (when event-store
            (.emitRequest event-store entry-id provider-id (.-accountId account) (.-routedModel context) (.-upstreamPayload candidate-payload)
                          #js {"upstreamMode" mode "upstreamPath" upstream-path "upstreamUrl" upstream-url "attempt" attempt
                               "requestedModel" (.-requestedModelInput context) "serviceTier" (.-serviceTier candidate-payload)}))
        fetched (try
                  (if (aget candidate-strategy "executeDirect")
                    (let [^js outcome (await (.executeDirect candidate-strategy reply provider-context (.-upstreamPayload candidate-payload)))
                          latency (- (js/Date.now) started)]
                      (.setAttribute span "proxy.latency_ms" latency)
                      (if (= "handled" (.-kind outcome))
                        (do (.setStatus span "ok") (.end span)
                            (await (run-effects! env (.-effects (advance! env #js {"type" "handled" "variant" "direct" "ctx" (exec-ctx env account) "latencyMs" latency}))
                                                 account (at)))
                            (release-in-flight!)
                            {:result :handled})
                        (do (advance! env #js {"type" "direct-declined" "outcome" outcome})
                            (.end span)
                            {:result :break})))
                    {:response (await (fetch-upstream env upstream-url request-headers effective-body))})
                  (catch :default error {:error error}))]
    (cond
      (contains? fetched :result) (:result fetched)

      (contains? fetched :error)
      (let [error (:error fetched)
            latency (- (js/Date.now) started)]
        (.setAttribute span "proxy.latency_ms" latency)
        (.setAttribute span "proxy.status" 0)
        (.recordError span error)
        (.end span)
        (let [^js failed (advance! env #js {"type" "transport-error" "ctx" (exec-ctx env account)})]
          (await (run-effects! env (.-effects failed) account (at)))
          (let [log-id (record-attempt! request-log-store provider-context
                                        (let [^js v (attempt-values candidate account upstream-path candidate-payload
                                                                    (at "status" 0 "latencyMs" latency) cache-key)]
                                          (aset v "error" (transport-error-message error)) v)
                                        mode host)]
            (when event-store
              (.emitError event-store entry-id provider-id (.-accountId account) (.-routedModel context) 0
                          #js {"error" (transport-error-message error) "logEntryId" log-id} #js {"latencyMs" latency}))
            (when (.-abort failed) (vreset! (:abort-sticky env) true))
            :break)))

      :else
      (let [^js upstream-response (:response fetched)
            latency (- (js/Date.now) started)
            status (.-status upstream-response)
            _ (do (.setAttribute span "proxy.status" status) (.setAttribute span "proxy.latency_ms" latency))
            log-id (record-attempt! request-log-store provider-context
                                    (let [^js v (attempt-values candidate account upstream-path candidate-payload
                                                                (at "status" status "latencyMs" latency) cache-key)]
                                      (aset v "promptCacheKeyUsed" (truthy? cache-key)) v)
                                    mode host)
            diagnostics (strat/update-failed-attempt-diagnostics-js request-log-store log-id upstream-response provider-id
                                                                       (.-upstreamPayload candidate-payload) cache-key)
            _ (when (and event-store (not (.-ok upstream-response)))
                (try
                  (let [error-body (await (.json (.clone upstream-response)))]
                    (.emitError event-store entry-id provider-id (.-accountId account) (.-routedModel context) status error-body
                                #js {"latencyMs" latency "logEntryId" log-id}))
                  (catch :default _
                    (.emitError event-store entry-id provider-id (.-accountId account) (.-routedModel context) status
                                #js {"status" status "statusText" (.-statusText upstream-response)}
                                #js {"latencyMs" latency "logEntryId" log-id}))))
            usage (strat/update-usage-counts-from-response-js request-log-store log-id upstream-response mode (.-routedModel context)
                                                                 provider-id config started
                                                                 (.-estimateRequestCost host))
            _ (if (and (strat/response-looks-like-event-stream-js upstream-response mode) (.-clientWantsStream context))
                nil
                (await usage))
            _ (await diagnostics)
            next-base? (when (and (= "images" mode) (= provider-id (.-openaiProviderId config)))
                         (let [next-step (nth steps (inc step-index) nil)]
                           (strat/images-next-base-js
                            #js {"status" status
                                 "tryNextBaseOnStatuses" (some-> (:try-next-base-on step) to-array)
                                 "nextBaseDiffers" (and (some? next-step) (not= (:base-url next-step) (:base-url step)))})))]
        (if next-base?
          (do (try (await (.arrayBuffer upstream-response)) (catch :default _ nil))
              (.setStatus span "error" "openai_images_try_next_base")
              (.end span)
              :next-step)
          (let [ctx (exec-ctx env account)]
            (cond
              ;; --- rate limited ------------------------------------------------
              (= 429 status)
              (do
                (advance! env #js {"type" "rate-limit-seen"})
                (let [multiplier (volatile! 1)
                      limit-kind (volatile! "unknown")
                      response-body (volatile! nil)]
                  (when (= "ollama-cloud" (.-providerId account))
                    (try (let [body (await (.json (.clone upstream-response)))]
                           (vreset! response-body body)
                           (vreset! limit-kind (proxy/detect-ollama-limit-kind-js body))
                           (when (= "weekly" @limit-kind)
                             (vreset! multiplier (.-ollamaWeeklyCooldownMultiplier config))))
                         (catch :default _ nil)))
                  (let [tracks? (and quota-monitor (.tracksProvider quota-monitor (.-providerId account)))
                        cooldown (volatile! (when tracks? (.getCooldownMs quota-monitor (.-accountId account))))]
                    (when-not (truthy? @cooldown)
                      (vreset! cooldown (await (proxy/extract-rate-limit-cooldown-ms-js upstream-response))))
                    (when (and (not (truthy? @cooldown)) tracks?)
                      (try (await (.refreshAccountQuota quota-monitor (.-accountId account))) (catch :default _ nil))
                      (vreset! cooldown (.getCooldownMs quota-monitor (.-accountId account))))
                    (when-not (truthy? @cooldown) (vreset! cooldown (.-keyCooldownMs config)))
                    (vswap! cooldown #(js/Math.round (* % @multiplier)))
                    (when-not (truthy? @response-body)
                      (vreset! response-body (await (json-or-nil upstream-response))))
                    (let [cooldown-ms @cooldown
                          kind (proxy/classify-rate-limit-kind-js @response-body cooldown-ms (.-concurrencyThrottleThresholdMs config))]
                      (if (= "concurrency_throttle" kind)
                        (let [max-retries (.-concurrencyThrottleMaxRetries config)
                              ^js throttle (strat/throttle-plan-js cooldown-ms manifest)]
                          (.setAttribute span "proxy.rate_limit_kind" "concurrency_throttle")
                          (.setAttribute span "proxy.concurrency_retry_wait_ms" (.-waitMs throttle))
                          (.markRateLimited key-pool account (.-shortCooldownMs throttle))
                          (let [outcome
                                (loop [n 0]
                                  (if (>= n max-retries)
                                    :exhausted
                                    (do
                                      (await (sleep (.-waitMs throttle)))
                                      (when (.-clearAccountCooldown key-pool)
                                        (.clearAccountCooldown key-pool (.-providerId account) (.-accountId account)))
                                      (let [retry-url (url/join-url (.-baseUrl provider-context) primary-path)
                                            retry-headers (upstream-headers env account provider-context candidate-strategy candidate-payload)
                                            retry-response (try (await (fetch-upstream env retry-url retry-headers effective-body))
                                                                (catch :default _ ::transport))]
                                        (cond
                                          (= ::transport retry-response) :exhausted
                                          (not= 429 (.-status ^js retry-response))
                                          (let [^js rr retry-response
                                                retry-latency (- (js/Date.now) started)
                                                retry-log-id (record-attempt! request-log-store provider-context
                                                                              (attempt-values candidate account upstream-path candidate-payload
                                                                                              (at "status" (.-status rr) "latencyMs" retry-latency) cache-key)
                                                                              mode host)
                                                retry-usage (strat/update-usage-counts-from-response-js
                                                             request-log-store retry-log-id rr mode (.-routedModel context) provider-id config started
                                                             (.-estimateRequestCost host))]
                                            (if (.-ok rr)
                                              (do (await retry-usage)
                                                  (await (run-effects! env (.-effects (advance! env #js {"type" "handled" "variant" "throttle-retry" "ctx" ctx "latencyMs" retry-latency}))
                                                                       account (at "status" (.-status rr))))
                                                  (.setStatus span "ok") (.end span)
                                                  (release-in-flight!)
                                                  :handled)
                                              (do (advance! env #js {"type" "throttle-error" "status" (.-status rr)})
                                                  (try (await (.arrayBuffer rr)) (catch :default _ nil))
                                                  :exhausted)))
                                          :else
                                          (let [^js rr retry-response
                                                retry-cooldown (let [c (await (proxy/extract-rate-limit-cooldown-ms-js rr))]
                                                                 (if (truthy? c) c cooldown-ms))
                                                retry-body (await (json-or-nil rr))
                                                retry-kind (proxy/classify-rate-limit-kind-js retry-body retry-cooldown (.-concurrencyThrottleThresholdMs config))]
                                            (try (await (.arrayBuffer rr)) (catch :default _ nil))
                                            (if (= "escalated" (strat/throttle-retry-verdict-js #js {"rateLimited" true "ok" false "retryKind" retry-kind}))
                                              (do (.markRateLimited key-pool account (js/Math.round (* retry-cooldown @multiplier)))
                                                  :exhausted)
                                              (do (.markRateLimited key-pool account (.-shortCooldownMs ^js (strat/throttle-plan-js retry-cooldown manifest)))
                                                  (recur (inc n))))))))))]
                            (if (= :handled outcome)
                              :handled
                              (do (.markRateLimited key-pool account cooldown-ms)
                                  (await (run-effects! env (.-effects (advance! env #js {"type" "rate-limited" "ctx" ctx "limitKind" @limit-kind})) account (at)))
                                  (.setStatus span "error" "concurrency_throttle")
                                  (.end span)
                                  :break))))
                        (do (.markRateLimited key-pool account cooldown-ms)
                            (await (run-effects! env (.-effects (advance! env #js {"type" "rate-limited" "ctx" ctx "limitKind" @limit-kind})) account (at)))
                            (.setStatus span "error" "rate_limited")
                            (.end span)
                            :break))))))

              ;; --- hidden quota exhaustion ---------------------------------------
              (await (runtime/response-indicates-quota-error-js upstream-response))
              (let [base (strat/quota-base-cooldown-ms-js
                          #js {"status" status "authType" (.-authType account)
                               "accountProviderId" (.-providerId account) "keyCooldownMs" (.-keyCooldownMs config)}
                          manifest)
                    cooldown (volatile! nil)]
                (when (and quota-monitor (.tracksProvider quota-monitor (.-providerId account)))
                  (vreset! cooldown (.getCooldownMs quota-monitor (.-accountId account)))
                  (when-not (truthy? @cooldown)
                    (try (await (.refreshAccountQuota quota-monitor (.-accountId account))) (catch :default _ nil))
                    (vreset! cooldown (.getCooldownMs quota-monitor (.-accountId account)))))
                (when-not (truthy? @cooldown)
                  (vreset! cooldown (await (proxy/extract-rate-limit-cooldown-ms-js upstream-response))))
                (when-not (truthy? @cooldown)
                  (vreset! cooldown (if health (.getGrowingCooldown health (.-providerId account) (.-accountId account) base) base)))
                (await (run-effects! env (.-effects (advance! env #js {"type" "quota-exhausted" "ctx" ctx "cooldownMs" @cooldown}))
                                     account (at "status" status)))
                (try (await (.arrayBuffer upstream-response)) (catch :default _ nil))
                (.setStatus span "error" "quota_exhausted")
                (.end span)
                :break)

              :else
              (let [transient (strat/transient-status-js #js {"status" status "providerId" provider-id "hasRetryRemaining" has-retry-remaining?}
                                                            manifest)]
                (cond
                  (= "transient-provider" transient)
                  (do (try (await (.arrayBuffer upstream-response)) (catch :default _ nil))
                      (.setStatus span "error" "factory_transient_403")
                      (.end span)
                      (await (run-effects! env (.-effects (advance! env #js {"type" "transient-provider" "ctx" ctx})) account (at "retryIndex" retry-index)))
                      :break-transient)

                  (or (= "server-error-retry" transient) (= "server-error" transient))
                  (let [^js planned (advance! env #js {"type" "server-error" "kind" transient "ctx" ctx})]
                    (if (= "retry-credential" (.-next planned))
                      (do (try (await (.arrayBuffer upstream-response)) (catch :default _ nil))
                          (.setStatus span "error" (str "upstream_server_error_" status))
                          (.end span)
                          (await (run-effects! env (.-effects planned) account (at "retryIndex" retry-index)))
                          :break-transient)
                      (do (await (run-effects! env (.-effects planned) account (at "retryIndex" retry-index)))
                          (try (await (.arrayBuffer upstream-response)) (catch :default _ nil))
                          (.setStatus span "error" (str "upstream_server_error_" status))
                          (.end span)
                          :break)))

                  (and codex-images? (.-ok upstream-response))
                  (let [r (await (codex-images-reply env reply provider-context upstream-response span))]
                    (if (= :handled r)
                      (do (await (run-effects! env (.-effects (advance! env #js {"type" "handled" "variant" "codex" "ctx" ctx "latencyMs" latency}))
                                               account (at "status" status)))
                          (release-in-flight!)
                          :handled)
                      :break))

                  :else
                  (do
                    (.header reply "x-open-hax-upstream-mode" mode)
                    (let [^js outcome (await (.handleProviderAttempt candidate-strategy reply upstream-response provider-context))]
                      (if (= "handled" (.-kind outcome))
                        (do (.setStatus span "ok") (.end span)
                            (await (run-effects! env (.-effects (advance! env #js {"type" "handled" "variant" "strategy" "ctx" ctx
                                                                                  "ok" (.-ok upstream-response) "latencyMs" latency}))
                                                 account
                                                 (at "status" status
                                                     "emitResponse" (fn []
                                                                      (when event-store
                                                                        (.emitResponse event-store entry-id provider-id (.-accountId account)
                                                                                       (.-routedModel context) status nil
                                                                                       #js {"latencyMs" (- (js/Date.now) started) "logEntryId" log-id}))))))
                            (release-in-flight!)
                            :handled)
                        (let [^js declined (advance! env #js {"type" "declined" "ctx" ctx "status" status "ok" (.-ok upstream-response) "outcome" outcome})]
                          (await (run-effects! env (.-effects declined) account (at "status" status "response" upstream-response "logEntryId" log-id)))
                          (let [refreshed (when (= "refresh-token" (.-next declined))
                                            (await (refresh-and-retry! env reply provider-context candidate-strategy candidate-payload span
                                                                       upstream-url upstream-path effective-body codex-images? outcome upstream-response
                                                                       log-id ctx release-in-flight!)))]
                            (if (= :handled refreshed)
                              :handled
                              (if (= :break refreshed)
                                :break
                                (do (.setStatus span "error" (str "routing_continue_" status))
                                    (.end span)
                                    :break)))))))))))))))))

(defn- ^:async attempt-credential!
  "Every try of one candidate (transient retries, upstream steps). Resolves to
  :handled or :done."
  [^js env ^js reply ^js candidate-strategy ^js candidate-payload has-more? ^js release-in-flight!]
  (let [^js candidate (:candidate env) ^js context (:context env) ^js config (.-config context)
        retries (.-upstreamTransientRetryCount config)]
    (loop [retry-index 0]
      (let [^js base-context (js/Object.assign #js {} context
                                               #js {"routeProviderId" (.-providerId candidate)
                                                    "providerId" (.-providerId candidate)
                                                    "baseUrl" (.-baseUrl candidate)
                                                    "account" (.-account candidate)
                                                    "hasMoreCandidates" has-more?})
            _ (when (.-paths candidate) (aset base-context "providerPaths" (.-paths candidate)))
            primary-path (.getUpstreamPath candidate-strategy base-context)
            openai-images? (and (= (.-providerId candidate) (.-openaiProviderId config)) (= "images" (.-mode candidate-strategy)))
            steps (plan/upstream-steps {:base-url (.-baseUrl candidate) :primary-path primary-path :openai-images? openai-images?
                                        :auth-type (.-authType ^js (.-account candidate)) :images-mode (.-openaiImagesUpstreamMode config)
                                        :openai-api-base-url (.-openaiApiBaseUrl config) :images-path (.-imagesGenerationsPath config)
                                        :openai-base-url (.-openaiBaseUrl config) :responses-path (.-openaiResponsesPath config)})
            has-retry-remaining? (< retry-index retries)
            result (loop [i 0]
                     (if (>= i (count steps))
                       :break
                       (let [r (await (attempt-step! env reply i steps base-context candidate-strategy candidate-payload
                                                     primary-path release-in-flight! retry-index has-retry-remaining?))]
                         (if (= :next-step r) (recur (inc i)) r))))]
        (cond
          (= :handled result) :handled
          (= :break-transient result) (if (<= (inc retry-index) retries) (recur (inc retry-index)) :done)
          :else :done)))))

(defn- ^:async attempt-candidate!
  [^js env ^js reply ^js strategy ^js payload index total]
  (let [^js candidate (:candidate env) ^js context (:context env) ^js key-pool (:key-pool env) ^js host (:host env)
        provider-id (.-providerId candidate) account (.-account candidate)]
    (if (and (.-isModelUnsupported key-pool)
             (= true (.isModelUnsupported key-pool provider-id (.-accountId ^js account) (.-routedModel context))))
      (do (advance! env #js {"type" "model-skipped"}) :next)
      (let [^js candidate-strategy (.selectRemoteStrategy host context provider-id)
            candidate-payload (if (identical? candidate-strategy strategy) payload (.buildPayload candidate-strategy context))
            candidate-payload (apply-model-alias candidate-payload context provider-id)
            candidate-payload (apply-requesty-prefix candidate-payload host provider-id)
            has-more? (< index (dec total))
            release (.markInFlight key-pool account)
            result (await (attempt-credential! env reply candidate-strategy candidate-payload has-more? release))]
        (if (= :handled result)
          :handled
          (do (release)
              (if @(:abort-sticky env) :abort :next)))))))

(defn ^:async execute-provider-routing-plan-js
  "Walk the candidates until one answers the client. Resolves to
  {handled, candidateCount, summary}."
  [^js strategy ^js reply ^js request-log-store ^js prompt-affinity-store ^js pheromone-store ^js key-pool
   ^js provider-routes ^js context ^js payload prompt-cache-key refresh-expired-token health-store event-store
   quota-monitor queue-signal ^js host]
  (let [manifest (.-cljsPolicyManifestPath ^js (.-config context))
        {:keys [candidates preferred provisional]}
        (await (build-routing-candidates key-pool provider-routes context prompt-affinity-store prompt-cache-key
                                         quota-monitor request-log-store strategy))
        n (count candidates)]
    (if (zero? n)
      (empty-result 0)
      (let [exec (volatile! (strat/create-executor-state-js
                             #js {"reassignmentAllowed" (plan/reassignment-allowed?
                                                         preferred
                                                         (map (fn [^js c] {:provider-id (.-providerId c) :account-id (.-accountId ^js (.-account c))}) candidates))
                                  "sticky" (boolean (and (truthy? prompt-cache-key) (or preferred provisional)))}))
            abort-sticky (volatile! false)
            env {:exec exec :abort-sticky abort-sticky :manifest-path manifest :context context
                 :request-log-store request-log-store :prompt-affinity-store prompt-affinity-store
                 :pheromone-store pheromone-store :key-pool key-pool :prompt-cache-key prompt-cache-key
                 :refresh-expired-token refresh-expired-token :health-store health-store :event-store event-store
                 :quota-monitor quota-monitor :queue-signal queue-signal :host host
                 :preferred preferred :provisional provisional}
            result (loop [i 0]
                     (if (>= i n)
                       :exhausted
                       (let [r (await (attempt-candidate! (assoc env :candidate (nth candidates i)) reply strategy payload i n))]
                         (if (= :next r) (recur (inc i)) r))))]
        #js {"handled" (= :handled result)
             "candidateCount" n
             "summary" (strat/executor-summary-js @exec)}))))

(defn ^:async inspect-provider-availability-js
  "Does any route have an enabled account? `key-pool.getStatus(providerId)`."
  [^js key-pool ^js provider-routes prompt-cache-key]
  (loop [routes (array-seq provider-routes) configured? false enabled? false]
    (if-let [^js route (first routes)]
      (let [^js status (try (await (.getStatus key-pool (.-providerId route))) (catch :default _ nil))]
        (if (and status (pos? (.-totalAccounts status)))
          (recur (rest routes) true (or enabled? (> (.-totalAccounts status) (or (.-disabledAccounts status) 0))))
          (recur (rest routes) configured? enabled?)))
      #js {"sawConfiguredProvider" configured?
           "sawOnlyDisabledProviders" (and configured? (not enabled?))
           "prompt_cache_key" prompt-cache-key})))

;; ---------------------------------------------------------------------------
;; The local Ollama attempt (src/lib/provider-strategy/local.ts)
;; ---------------------------------------------------------------------------

(defn ^:async execute-local-strategy-js
  "One request to the local Ollama upstream; the strategy answers the client.
  `host`: {estimateRequestCost}."
  [^js strategy ^js reply ^js request-log-store ^js context ^js payload queue-signal ^js host]
  (.header reply "x-open-hax-upstream-provider" "local-ollama")
  (let [^js config (.-config context)
        upstream-path (.getUpstreamPath strategy context)
        upstream-url (url/join-url (.-ollamaBaseUrl config) upstream-path)
        headers (js/Headers. (if (.-ollamaApiKey config)
                               (proxy/upstream-headers-js (.-clientHeaders context) (.-ollamaApiKey config))
                               (proxy/forward-headers-js (.-clientHeaders context))))
        started (js/Date.now)
        mode (.-mode strategy)
        ^js span (.startSpan ^js (telemetry/get-telemetry-js) "proxy.upstream_attempt"
                             #js {"proxy.provider_id" "ollama" "proxy.account_id" "local" "proxy.auth_type" "local"
                                  "proxy.upstream_mode" mode "proxy.upstream_path" upstream-path
                                  "proxy.model" (.-routedModel context) "proxy.requested_model" (.-requestedModelInput context)})
        _ (.setAttributes span #js {"proxy.service_tier" (.-serviceTier payload)
                                    "proxy.service_tier_source" (.-serviceTierSource payload)})
        attempt-context (js/Object.assign #js {} context #js {"baseUrl" (.-ollamaBaseUrl config)})
        record! (fn [status latency error]
                  (let [^js v #js {"providerId" "ollama" "accountId" "local" "authType" "local" "upstreamPath" upstream-path
                                   "status" status "latencyMs" latency
                                   "serviceTier" (.-serviceTier payload) "serviceTierSource" (.-serviceTierSource payload)}]
                    (when error (aset v "error" error))
                    (record-attempt! request-log-store attempt-context v mode host)))
        fetched (try (await (http/fetch-with-response-timeout-js
                             upstream-url
                             #js {"method" "POST" "headers" headers "body" (.-bodyText payload) "signal" queue-signal}
                             (.-upstreamAttemptTimeoutMs context)))
                     (catch :default error {:error error}))]
    (if (and (map? fetched) (contains? fetched :error))
      (let [error (:error fetched) latency (- (js/Date.now) started)]
        (.setAttribute span "proxy.latency_ms" latency)
        (.setAttribute span "proxy.status" 0)
        (.recordError span error)
        (.end span)
        (record! 0 latency (error-message error))
        (.header reply "x-open-hax-error-code" "ollama_upstream_unavailable")
        (.send (.code reply 502)
               (proxy/openai-error-js "Ollama upstream request failed due to a network or transport error."
                                      "server_error" "ollama_upstream_unavailable"))
        js/undefined)
      (let [^js response fetched
            latency (- (js/Date.now) started)]
        (.setAttribute span "proxy.status" (.-status response))
        (.setAttribute span "proxy.latency_ms" latency)
        (if (.-ok response)
          (.setStatus span "ok")
          (.setStatus span "error" (str "HTTP " (.-status response))))
        (.end span)
        (let [log-id (record! (.-status response) latency nil)]
          (when-not (and (strat/response-looks-like-event-stream-js response mode) (.-clientWantsStream context))
            (await (strat/update-usage-counts-from-response-js request-log-store log-id response mode (.-routedModel context)
                                                              "ollama" config started (.-estimateRequestCost host))))
          (await (.handleLocalAttempt strategy reply response attempt-context))
          js/undefined)))))
