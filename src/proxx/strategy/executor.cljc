(ns proxx.strategy.executor
  "The retry/rotation decisions of the provider routing loop, as a pure state machine.

  The loop walks candidates (provider x account); for each it makes attempts and
  must decide, after every upstream result, what the credential costs, whether to
  retry, rotate or stop, and what to remember. That decision is

      (step state event) -> {:state state' :effects [...] :next action}

  `state` is the immutable cross-candidate memory (what failure kinds were seen,
  whether the sticky prompt-cache affinity may be reassigned, how many transport
  failures a sticky route has had). `event` is a map of facts about one attempt's
  result, always carrying `:ctx` (who was tried and the limits in force). `effects`
  are data the edge interprets in order; `:next` says how the loop proceeds:
  `:handled` (stop, the client was answered), `:retry-credential` (wait, same
  credential again), `:next-step` (try the next base URL), `:next-candidate`, or
  `:refresh-token` (refresh the OAuth token and repeat), or `:stop-candidates`.

  Effects: `[:mark-rate-limited ms]` `[:disable-account]` `[:mark-model-unsupported ms]`
  `[:clear-model-unsupported]` `[:clear-account-cooldown]` `[:pheromone :success|:failure]`
  `[:health :success|:failure reason?]` `[:delete-affinity]` `[:note-affinity-success]`
  `[:log-upstream-error code message]` `[:sleep :transient]` `[:summarize-error]`.
  Cooldowns are milliseconds."
  (:require [proxx.strategy.routing :as routing]))

;; ---------------------------------------------------------------------------
;; State
;; ---------------------------------------------------------------------------

(def initial-accumulator
  {:saw-rate-limit false :saw-request-error false :saw-upstream-server-error false
   :saw-upstream-invalid-request false :saw-model-not-found false
   :saw-model-not-supported-for-account false :attempts 0})

(defn initial-state
  "`reassignment-allowed?` starts true when no preferred affinity exists or none of
  the candidates is the preferred one; `sticky?` says a prompt-cache key has an
  affinity record."
  [{:keys [reassignment-allowed? sticky?]}]
  {:accumulator initial-accumulator
   :reassignment-allowed? (boolean reassignment-allowed?)
   :sticky? (boolean sticky?)
   :sticky-transport-failures 0
   :abort? false})

(defn begin-attempt [state] (update-in state [:accumulator :attempts] inc))

(defn- flag [state k] (assoc-in state [:accumulator k] true))

(defn- allow-reassignment [state] (assoc state :reassignment-allowed? true))

(defn- or-flag [state k v] (cond-> state v (flag k)))

(defn- accumulate-outcome
  "Fold a `continue` outcome's flags into the accumulator."
  [state outcome status provider-id]
  (-> state
      (or-flag :saw-rate-limit (true? (:rate-limit outcome)))
      (or-flag :saw-request-error (true? (:request-error outcome)))
      (or-flag :saw-upstream-server-error (true? (:upstream-server-error outcome)))
      (or-flag :saw-upstream-invalid-request (true? (:upstream-invalid-request outcome)))
      (cond-> (and (:upstream-invalid-request outcome) (seq (:upstream-error-body outcome)))
        (assoc-in [:accumulator :last-upstream-error]
                  {:status status :body (:upstream-error-body outcome) :provider-id provider-id}))
      (or-flag :saw-model-not-found (true? (:model-not-found outcome)))
      (or-flag :saw-model-not-supported-for-account (true? (:model-not-supported-for-account outcome)))
      (cond-> (:upstream-auth-error outcome)
        (assoc-in [:accumulator :last-upstream-auth-error] (:upstream-auth-error outcome)))))

(defn- result [state effects next] {:state state :effects effects :next next})

;; ---------------------------------------------------------------------------
;; Small derived facts
;; ---------------------------------------------------------------------------

(defn- matches-affinity? [ctx] (or (:matches-preferred? ctx) (:matches-provisional? ctx)))

(defn sticky-affinity-reassignment
  "After a failure on a candidate that holds the preferred affinity, the affinity may move."
  [state ctx]
  (cond-> state (:matches-preferred? ctx) allow-reassignment))

(defn- cap [policy kind configured]
  (min configured (if (= :auth-ms kind)
                    (get-in policy [:attempt/auth-cooldown :cap-ms])
                    (routing/cooldown-cap-ms policy kind))))

;; ---------------------------------------------------------------------------
;; Rate limiting (429)
;; ---------------------------------------------------------------------------

(defn throttle-plan
  "Waiting parameters for a concurrency throttle: how long to wait between retries
  and the short cooldown parked on the credential meanwhile."
  [policy cooldown-ms]
  {:wait-ms (min cooldown-ms (routing/cooldown-cap-ms policy :concurrency-wait-ms))
   :short-cooldown-ms (min cooldown-ms (routing/cooldown-cap-ms policy :concurrency-cooldown-ms))})

(defn throttle-retry-verdict
  "What a concurrency-throttle retry's response means. `retry-kind` is the
  rate-limit classification of a response that was rate limited again.
  `:handled-ok` | `:other-error` (accumulate, leave the loop) | `:escalated` (mark
  the escalated cooldown, leave) | `:still-throttled` (park a short cooldown, wait again)."
  [{:keys [rate-limited? ok? retry-kind]}]
  (cond
    (not rate-limited?) (if ok? :handled-ok :other-error)
    (not= "concurrency_throttle" retry-kind) :escalated
    :else :still-throttled))

(defn throttle-other-error
  "Accumulate a non-429 failure met while retrying a throttled credential."
  [state status]
  (-> state
      (or-flag :saw-upstream-server-error (>= status 500))
      (or-flag :saw-upstream-invalid-request (and (>= status 400) (< status 500)))))

(defn rate-limited
  "A 429. Flags the accumulator; after the cooldowns are settled the affinity
  consequences follow: a session-limited Ollama route drops its sticky record, and
  a failed preferred route may be reassigned."
  [state {:keys [ctx limit-kind]}]
  (let [state (flag state :saw-rate-limit)
        session-drop? (and (= "session" limit-kind) (:prompt-cache-key? ctx) (matches-affinity? ctx))
        state (cond-> state session-drop? allow-reassignment)
        state (sticky-affinity-reassignment state ctx)]
    (result state (cond-> [] session-drop? (conj [:delete-affinity])) :next-candidate)))

;; ---------------------------------------------------------------------------
;; Quota exhaustion reported in a body
;; ---------------------------------------------------------------------------

(defn quota-base-cooldown-ms
  "The fallback cooldown for a quota failure: permanent for a disabled key, a day
  for 402, otherwise the configured key cooldown capped."
  [policy {:keys [status auth-type account-provider-id key-cooldown-ms]}]
  (cond
    (routing/permanently-disable? policy auth-type account-provider-id status)
    (routing/permanent-disable-cooldown-ms policy)
    (= 402 status) (routing/cooldown-cap-ms policy :payment-required-ms)
    :else (cap policy :quota-ms key-cooldown-ms)))

(defn quota-exhausted
  "200/4xx whose body reports quota exhaustion: cool the credential for `cooldown-ms`."
  [state {:keys [ctx cooldown-ms]}]
  (let [state (sticky-affinity-reassignment (flag state :saw-rate-limit) ctx)]
    (result state
            (cond-> [[:mark-rate-limited cooldown-ms]]
              (:health? ctx) (conj [:health :failure "quota_exhausted"])
              :always (conj [:pheromone :failure]))
            :next-candidate)))

;; ---------------------------------------------------------------------------
;; Status-only failures, before the strategy sees the response
;; ---------------------------------------------------------------------------

(defn transient-status
  "Statuses retried on the same credential before the strategy is consulted.
  Returns `:transient-provider` (e.g. Factory 403), `:server-error-retry`,
  `:server-error` (5xx past its retries) or nil."
  [policy {:keys [status provider-id has-retry-remaining?]}]
  (cond
    (and (routing/transient-provider-retry? policy provider-id status) has-retry-remaining?) :transient-provider
    (and (>= status 500) (<= status 599))
    (if (and has-retry-remaining? (routing/retry-same-credential-for-server-error? policy status))
      :server-error-retry
      :server-error)))

(defn server-error
  [state policy {:keys [ctx kind]}]
  (let [state (flag state :saw-upstream-server-error)]
    (case kind
      :server-error-retry (result state [[:sleep :transient]] :retry-credential)
      :server-error (result state [[:mark-rate-limited (cap policy :server-error-ms (:key-cooldown-ms ctx))]
                                   [:pheromone :failure]]
                            :next-candidate))))

(defn transient-provider-retry [state _event]
  (result state [[:sleep :transient]] :retry-credential))

;; ---------------------------------------------------------------------------
;; Success
;; ---------------------------------------------------------------------------

(defn- affinity-success-allowed? [state ctx]
  (boolean (and (:prompt-cache-key? ctx)
                (or (not (:preferred-affinity? ctx))
                    (:reassignment-allowed? state)
                    (:matches-preferred? ctx)))))

(defn handled
  "The client was answered. `variant` says through which path, which decides what
  is credited: `:strategy` (the strategy relayed the response), `:direct` (an SDK
  strategy), `:throttle-retry` (success after waiting out a concurrency throttle),
  `:codex` (Codex Responses image bridge), and the `:refreshed-*` forms after an
  OAuth refresh. `ok?` is whether the upstream status was OK."
  [state policy {:keys [ctx ok? latency-ms variant]}]
  (let [quality [:pheromone :success (routing/clamp-route-quality policy latency-ms)]
        health? (:health? ctx)
        clear-cooldown? (:ollama-cloud? ctx)
        affinity? (affinity-success-allowed? state ctx)]
    (result
     state
     (case (or variant :strategy)
       :direct [quality]
       :throttle-retry (cond-> []
                         health? (conj [:health :success])
                         clear-cooldown? (conj [:clear-account-cooldown])
                         :always (conj quality))
       :codex (cond-> []
                health? (conj [:health :success])
                :always (conj [:clear-model-unsupported])
                clear-cooldown? (conj [:clear-account-cooldown])
                :always (conj quality))
       :strategy (cond-> []
                   (and ok? health?) (conj [:health :success])
                   ok? (conj [:clear-model-unsupported])
                   (and ok? clear-cooldown?) (conj [:clear-account-cooldown])
                   :always (conj quality)
                   :always (conj [:emit-response])
                   affinity? (conj [:note-affinity-success]))
       :refreshed-strategy (cond-> []
                             (and ok? health?) (conj [:health :success])
                             ok? (conj [:clear-model-unsupported])
                             :always (conj quality)
                             affinity? (conj [:note-affinity-success]))
       :refreshed-codex (cond-> []
                          health? (conj [:health :success])
                          :always (conj [:clear-model-unsupported])
                          :always (conj quality)))
     :handled)))

;; ---------------------------------------------------------------------------
;; The strategy declined: continue outcome
;; ---------------------------------------------------------------------------

(defn- hidden-error-effects [policy ctx outcome]
  (let [rate-limit? (true? (:rate-limit outcome))
        cooldown (if rate-limit?
                   (:key-cooldown-ms ctx)
                   (cap policy :stream-empty-ms (:key-cooldown-ms ctx)))]
    (cond-> [[:mark-rate-limited cooldown]
             [:pheromone :failure]
             (if rate-limit?
               [:log-upstream-error "stream_quota_error" "200 OK with quota error in stream body"]
               [:log-upstream-error "stream_empty_or_invalid" "200 OK with no substantive content in stream body"])]
      (and rate-limit? (:prompt-cache-key? ctx) (matches-affinity? ctx)) (conj [:delete-affinity]))))

(defn- auth-failure-effects
  "Cool down / disable a credential whose 401/402/403 the strategy reported."
  [policy ctx status]
  (let [{:keys [auth-type account-provider-id provider-id key-cooldown-ms has-refresh-token?]} ctx
        disable? (routing/permanently-disable? policy auth-type account-provider-id status)]
    (when (or (routing/cooldown-on-auth-failure? policy provider-id status) disable?)
      (cond-> [[:mark-rate-limited (if disable?
                                     (routing/permanent-disable-cooldown-ms policy)
                                     (cap policy :auth-ms key-cooldown-ms))]]
        disable? (conj [:disable-account])
        (and (= 401 status) (= :oauth-bearer auth-type) (not has-refresh-token?)) (conj [:disable-account])
        (:health? ctx) (conj [:health :failure "credential_disabled"])))))

(defn- tail-effects
  "What follows a declined outcome once credential handling is done: a model-gated
  account stays usable for other models, and a failed request's error body is read."
  [policy ctx outcome ok?]
  (cond-> []
    (:model-not-supported-for-account outcome)
    (conj [:mark-model-unsupported (cap policy :model-unsupported-ms (:key-cooldown-ms ctx))])
    (and (not ok?) (:request-error outcome) (not (:model-not-found outcome))
         (not (:model-not-supported-for-account outcome)))
    (conj [:summarize-error])))

(defn- refresh-wanted? [ctx outcome status ok?]
  (and (not ok?) (:request-error outcome) (= 401 status)
       (= :oauth-bearer (:auth-type ctx)) (:has-refresh-token? ctx) (:refresh-available? ctx)))

(defn outcome-declined
  "The strategy returned `continue` for this response. Returns `:next
  :refresh-token` when an expired OAuth token should be refreshed and the request
  repeated (the edge then reports the retry with `refreshed-*` events)."
  [state policy {:keys [ctx status ok? outcome]}]
  (let [state (accumulate-outcome state outcome status (:provider-id ctx))
        health-failure? (and (:health? ctx) (not ok?) (>= status 500)
                             (not (:upstream-invalid-request outcome))
                             (not (:model-not-found outcome))
                             (not (:model-not-supported-for-account outcome)))
        hidden? (and ok? (or (true? (:rate-limit outcome)) (true? (:request-error outcome))))
        state (cond-> state
                (and (not ok?) (:matches-preferred? ctx)) allow-reassignment
                (and hidden? (matches-affinity? ctx)) allow-reassignment)
        effects (cond-> []
                  health-failure? (conj [:health :failure])
                  (not ok?) (conj [:pheromone :failure])
                  hidden? (into (hidden-error-effects policy ctx outcome)))]
    (if (refresh-wanted? ctx outcome status ok?)
      (result state effects :refresh-token)
      (let [auth-effects (when (and (not ok?) (not (:model-not-supported-for-account outcome))
                                    (:request-error outcome) (contains? #{401 402 403} status))
                           (auth-failure-effects policy ctx status))
            state (cond-> state
                    (and (seq auth-effects) (:matches-preferred? ctx)) allow-reassignment)
            effects (-> effects (into auth-effects) (into (tail-effects policy ctx outcome ok?)))]
        (result state effects :next-candidate)))))

;; ---------------------------------------------------------------------------
;; After a token refresh
;; ---------------------------------------------------------------------------

(defn refresh-failed
  "The token could not be refreshed: the credential is unusable. The declined
  outcome's tail effects still apply."
  [state policy {:keys [ctx outcome ok?]}]
  (let [state (sticky-affinity-reassignment state ctx)]
    (result state
            (-> [[:pheromone :failure]
                 [:mark-rate-limited (cap policy :refresh-failed-ms (:key-cooldown-ms ctx))]]
                (cond-> (= :oauth-bearer (:auth-type ctx)) (conj [:disable-account]))
                (into (tail-effects policy ctx outcome ok?)))
            :next-candidate)))

(defn refreshed-rate-limited
  "The refreshed request was rate limited: park the cooldown the response gave
  (nil when it gave none, which the pool resolves to its default)."
  [state {:keys [cooldown-ms]}]
  (result (flag state :saw-rate-limit) [[:mark-rate-limited cooldown-ms]] :next-candidate))

(defn refreshed-declined
  "The refreshed attempt was declined too."
  [state policy {:keys [ctx status ok? outcome]}]
  (let [state (accumulate-outcome state outcome status (:provider-id ctx))
        cooldown? (and (not ok?) (not (:model-not-supported-for-account outcome)) (:request-error outcome)
                       (contains? #{401 403} status)
                       (routing/cooldown-on-auth-failure? policy (:provider-id ctx) status))
        state (cond-> state (and cooldown? (:matches-preferred? ctx)) allow-reassignment)]
    (result state
            (cond-> []
              (not ok?) (conj [:pheromone :failure])
              (:model-not-supported-for-account outcome)
              (conj [:mark-model-unsupported (cap policy :model-unsupported-ms (:key-cooldown-ms ctx))])
              cooldown? (conj [:mark-rate-limited (cap policy :auth-ms (:key-cooldown-ms ctx))])
              (and cooldown? (= :oauth-bearer (:auth-type ctx))) (conj [:disable-account]))
            :next-candidate)))

;; ---------------------------------------------------------------------------
;; Transport failure and direct execution
;; ---------------------------------------------------------------------------

(defn transport-failed
  "fetch threw or timed out. A sticky route gives up the remaining candidates after
  too many such failures, rather than hammering a dead network."
  [state policy {:keys [ctx]}]
  (let [state (flag state :saw-request-error)
        state (if (:sticky? state)
                (update state :sticky-transport-failures inc)
                state)
        abort? (and (:sticky? state)
                    (>= (:sticky-transport-failures state)
                        (:attempt/max-sticky-transport-failures policy)))]
    (result (assoc state :abort? (boolean (or (:abort? state) abort?)))
            [[:pheromone :failure]]
            :next-candidate)))

(defn direct-declined
  "A strategy that executes directly (SDK) declined. Unlike an HTTP response there
  is no status: request-error defaults to true."
  [state {:keys [outcome]}]
  (let [state (assoc-in state [:accumulator :saw-request-error] (if (contains? outcome :request-error) (boolean (:request-error outcome)) true))
        state (-> state
                  (or-flag :saw-rate-limit (:rate-limit outcome))
                  (or-flag :saw-model-not-found (:model-not-found outcome))
                  (or-flag :saw-model-not-supported-for-account (:model-not-supported-for-account outcome))
                  (or-flag :saw-upstream-invalid-request (:upstream-invalid-request outcome)))]
    (result state [] :next-candidate)))

(defn images-next-base?
  "Try the next base URL when the images step lists the status for fall-through."
  [{:keys [status try-next-base-on-statuses next-base-differs?]}]
  (boolean (and (contains? (set try-next-base-on-statuses) status) next-base-differs?)))

(defn codex-images-failed
  "The Codex Responses bridge produced no image (stream error or no output)."
  [state _event]
  (result (flag state :saw-upstream-invalid-request) [] :next-candidate))

;; ---------------------------------------------------------------------------
;; Entry point
;; ---------------------------------------------------------------------------

(defn step
  "Dispatch an event to its planner. `event` is `{:type kw ...}`."
  [state policy {:keys [type] :as event}]
  (case type
    :attempt-started (result (begin-attempt state) [] nil)
    :model-skipped (result (flag state :saw-model-not-supported-for-account) [] nil)
    :rate-limit-seen (result (flag state :saw-rate-limit) [] nil)
    :transport-error (transport-failed state policy event)
    :direct-declined (direct-declined state event)
    :rate-limited (rate-limited state event)
    :quota-exhausted (quota-exhausted state event)
    :transient-provider (transient-provider-retry state event)
    :server-error (server-error state policy event)
    :handled (handled state policy event)
    :declined (outcome-declined state policy event)
    :refresh-failed (refresh-failed state policy event)
    :refreshed-rate-limited (refreshed-rate-limited state event)
    :refreshed-declined (refreshed-declined state policy event)
    :codex-images-failed (codex-images-failed state event)
    :throttle-error (result (throttle-other-error state (:status event)) [] nil)))
