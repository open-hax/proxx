(ns proxx.runtime.keypool
  "Stateful edge of the key pool: one atom holding the immutable pool state,
  provider loading from files/environment/stores, fire-and-forget persistence,
  telemetry, and a JS facade with the method names callers already use.

  All rotation and classification decisions are in proxx.keypool.pool; this
  namespace only sequences effects around them. Collaborators arrive through
  `deps` so nothing here reaches into the TypeScript host:

    seedSpecs        [{providerIdEnvNames providerIdFallback keyEnvNames}]
    sha256Hex        (string) => hex digest
    env              environment object (default process.env)
    rng              () => number in [0,1) (default: a seeded pure PRNG)
    telemetry        {recordMetric(name, value, attributes)}
    loadFactoryAuth  async () => {accessToken, refreshToken, expiresAt?} | null"
  (:require ["node:fs" :as fs]
            [clojure.string :as str]
            [proxx.keypool.credentials :as cr]
            [proxx.keypool.pool :as pool]))

;; ---------------------------------------------------------------------------
;; JS <-> domain conversion (the only place camelCase exists)
;;
;; Property *writes* use `aset` with string keys: under advanced compilation a
;; `(set! (.-prop o) v)` may be renamed, while a string key never is. Reads of
;; host objects are hinted `^js` so externs are inferred.
;; ---------------------------------------------------------------------------

(defn- auth->js [auth-type]
  (case auth-type :api-key "api_key" :oauth-bearer "oauth_bearer" (name auth-type)))

(defn- js->auth [s]
  (case s "oauth_bearer" :oauth-bearer :api-key))

(defn- js->credential [^js c]
  (cond-> {:provider-id (.-providerId c) :account-id (.-accountId c) :token (.-token c)
           :auth-type (js->auth (.-authType c))}
    (.-chatgptAccountId c) (assoc :chatgpt-account-id (.-chatgptAccountId c))
    (.-planType c) (assoc :plan-type (.-planType c))
    (.-refreshToken c) (assoc :refresh-token (.-refreshToken c))
    (some? (.-expiresAt c)) (assoc :expires-at (.-expiresAt c))))

(defn- credential->js [{:keys [provider-id account-id token auth-type chatgpt-account-id plan-type refresh-token expires-at]}]
  (let [o #js {:providerId provider-id :accountId account-id :token token :authType (auth->js auth-type)}]
    (when chatgpt-account-id (aset o "chatgptAccountId" chatgpt-account-id))
    (when plan-type (aset o "planType" plan-type))
    (when refresh-token (aset o "refreshToken" refresh-token))
    (when (some? expires-at) (aset o "expiresAt" expires-at))
    o))

(defn- credentials->js [creds] (to-array (map credential->js creds)))

(defn- status->js [{:keys [provider-id auth-type total-accounts available-accounts cooldown-accounts
                           disabled-accounts expired-accounts in-flight-accounts next-ready-in-ms]}]
  #js {:providerId provider-id :authType (auth->js auth-type) :totalAccounts total-accounts
       :availableAccounts available-accounts :cooldownAccounts cooldown-accounts
       :disabledAccounts disabled-accounts :expiredAccounts expired-accounts
       :inFlightAccounts in-flight-accounts :nextReadyInMs next-ready-in-ms})

(defn- account-status->js [{:keys [provider-id account-id auth-type available? disabled? expired? in-flight?
                                   cooldown-until expires-at next-ready-in-ms]}]
  (let [o #js {:providerId provider-id :accountId account-id :authType (auth->js auth-type)
               :available available? :disabled disabled? :expired expired? :inFlight in-flight?
               :nextReadyInMs next-ready-in-ms}]
    (when cooldown-until (aset o "cooldownUntil" cooldown-until))
    (when expires-at (aset o "expiresAt" expires-at))
    o))

(defn- js-map->clj
  "Entries of a JS Map as a clojure map, values converted with `f`."
  [m f]
  (into {} (map (fn [entry] [(aget entry 0) (f (aget entry 1))])) (js/Array.from (.entries m))))

(defn- promise? [x] (and (some? x) (fn? (.-then x))))

(defn- fire-and-forget [x]
  (when (promise? x) (.catch x (fn [_] nil))))

;; ---------------------------------------------------------------------------
;; Provider loading
;; ---------------------------------------------------------------------------

(defn- read-json-file [file-path]
  (.then (.readFile (.-promises fs) file-path "utf8") js/JSON.parse))

(defn- parse-json-document [ctx raw default-provider-id]
  (cr/parse-providers ctx (js->clj raw) default-provider-id))

(defn- inline-json-providers
  "Providers from PROXY_KEYS_JSON / VIVGRID_KEYS_JSON; a bad document is
  reported and ignored, as the environment must not take the proxy down."
  [ctx env default-provider-id]
  (let [raw (some #(let [v (get env %)] (when (some? v) v)) ["PROXY_KEYS_JSON" "VIVGRID_KEYS_JSON"])
        trimmed (some-> raw str/trim)]
    (if (str/blank? trimmed)
      {}
      (try
        (let [providers (parse-json-document ctx (js/JSON.parse trimmed) default-provider-id)]
          (if (empty? providers)
            (throw (js/Error. "No provider accounts found in inline keys JSON"))
            providers))
        (catch :default e
          (js/console.warn (str "[key-pool] Failed to parse inline keys JSON from env: " (.-message e)))
          {})))))

(defn- ^:async read-account-store [^js store]
  (let [info (js-map->clj (await (.getAllProviders store)) (fn [^js v] {:auth-type (js->auth (.-authType v))}))
        accounts (js-map->clj (await (.getAllAccounts store)) (fn [arr] (mapv js->credential (array-seq arr))))]
    (cr/providers-from-account-store info accounts)))

(defn- ^:async read-factory-oauth [ctx load-factory-auth]
  (try
    (if-let [^js creds (when load-factory-auth (await (load-factory-auth)))]
      (let [refresh (not-empty (.-refreshToken creds))
            expires (.-expiresAt creds)
            token (.-accessToken creds)]
        {"factory" {:auth-type :oauth-bearer :next-offset 0
                    :accounts [(cond-> {:provider-id "factory"
                                        :account-id (cr/deterministic-account-id (:sha256-hex ctx) "factory" token)
                                        :token token :auth-type :oauth-bearer}
                                 refresh (assoc :refresh-token refresh)
                                 (number? expires) (assoc :expires-at expires))]}})
      {})
    (catch :default e
      (js/console.warn (str "[key-pool] Failed to load Factory OAuth credentials: " (.-message e)))
      {})))

(defn- ^:async load-providers [{:keys [cfg ctx deps]}]
  (let [store (:account-store cfg)
        prefer? (:prefer-account-store? cfg)
        default-id (:default-provider-id cfg)
        env (:env deps)
        env-providers (if (and store prefer?) {} (cr/env-provider-states ctx (:seed-specs deps) env))
        inline (if store {} (inline-json-providers ctx env default-id))
        factory (if store {} (await (read-factory-oauth ctx (:load-factory-auth deps))))
        from-store (when store (await (read-account-store store)))
        file (when-not store
               (try
                 (let [providers (parse-json-document ctx (await (read-json-file (:keys-file-path cfg))) default-id)]
                   (when (empty? providers) (throw (js/Error. "No provider accounts found in keys file")))
                   providers)
                 (catch :default e
                   (if (and (empty? env-providers) (empty? inline) (empty? from-store) (empty? factory))
                     (throw e)
                     nil))))]
    (cr/merge-sources {:account-store from-store :file file :inline inline :env env-providers
                       :factory-oauth factory :prefer-account-store? prefer? :account-store? (some? store)})))

;; ---------------------------------------------------------------------------
;; The pool
;; ---------------------------------------------------------------------------

(defn- config-of [^js config]
  {:keys-file-path (.-keysFilePath config)
   :reload-interval-ms (.-reloadIntervalMs config)
   :default-cooldown-ms (.-defaultCooldownMs config)
   :default-provider-id (.-defaultProviderId config)
   :account-store (.-accountStore config)
   :cooldown-store (.-cooldownStore config)
   :disabled-store (.-disabledStore config)
   :prefer-account-store? (boolean (.-preferAccountStoreProviders config))
   :expiry-buffer-ms (.-expiryBufferMs config)
   :cooldown-jitter-factor (.-cooldownJitterFactor config)
   :random-walk? (boolean (.-enableRandomWalk config))})

;; `process.env` is not a plain Object, so `js->clj` would hand it back untouched.
(defn- env->map [env]
  (into {} (map (fn [k] [k (aget env k)])) (js/Object.keys env)))

(defn- deps-of [^js deps]
  {:seed-specs (mapv (fn [^js s] {:provider-id-env-names (vec (array-seq (.-providerIdEnvNames s)))
                                  :provider-id-fallback (.-providerIdFallback s)
                                  :key-env-names (vec (array-seq (.-keyEnvNames s)))})
                     (array-seq (or (.-seedSpecs deps) #js [])))
   :env (env->map (or (.-env deps) js/process.env))
   :rng (or (.-rng deps) (pool/seed-from (js/Math.random)))
   :telemetry (.-telemetry deps)
   :load-factory-auth (.-loadFactoryAuth deps)
   :sha256-hex (.-sha256Hex deps)})

(defn create-key-pool-js
  "Build a key pool. `config` is the legacy KeyPoolConfig object; `deps` is
  described in the namespace docstring. Returns an object with the KeyPool
  methods."
  [config deps]
  (let [cfg (config-of config)
        deps (deps-of deps)
        ctx {:sha256-hex (:sha256-hex deps)}
        state (atom (assoc pool/empty-state :rng (:rng deps)))
        last-reload (atom 0)
        reloading (atom nil)
        now #(js/Date.now)
        opts #(hash-map :expiry-buffer-ms (:expiry-buffer-ms cfg)
                        :random-walk? (:random-walk? cfg)
                        :jitter-factor (let [f (:cooldown-jitter-factor cfg)] (if (some? f) f pool/default-jitter-factor))
                        :default-cooldown-ms (:default-cooldown-ms cfg))
        metric (fn [name attrs]
                 (when-let [^js t (:telemetry deps)] (.recordMetric t name 1 (clj->js attrs))))
        provider-id-or-default #(or % (:default-provider-id cfg))
        persist-cooldown (fn [provider-id account-id until]
                           (when-let [^js store (:cooldown-store cfg)]
                             (fire-and-forget
                              (if (<= (or (js/Number until) 0) (now))
                                (.clearCooldown store provider-id account-id)
                                (.persistCooldown store provider-id account-id until)))))
        clear-persisted (fn [provider-id account-id]
                          (when-let [^js store (:cooldown-store cfg)]
                            (fire-and-forget (.clearCooldown store provider-id account-id))))
        reload! (fn []
                  (reset! last-reload (now))
                  (-> (load-providers {:cfg cfg :ctx ctx :deps deps})
                      (.then (fn [providers] (swap! state pool/replace-providers providers (now)) nil))
                      (.catch (fn [e] (when (empty? (:providers @state)) (throw e))))))
        ensure-fresh (fn ^:async ensure-fresh [force?]
                       (when (or force? (empty? (:providers @state))
                                 (>= (- (now) @last-reload) (:reload-interval-ms cfg)))
                         (if-let [in-flight @reloading]
                           (await in-flight)
                           (let [p (.finally (reload!) #(reset! reloading nil))]
                             (reset! reloading p)
                             (await p)))))
        step! (fn [f & args] (let [[value state'] (apply f @state args)] (reset! state state') value))]
    #js {:warmup
         (fn ^:async warmup []
           (await (ensure-fresh true))
           (when-let [^js store (:cooldown-store cfg)]
             (let [persisted (js-map->clj (await (.loadCooldowns store)) identity)]
               (swap! state pool/restore-cooldowns persisted (now))))
           (when-let [^js store (:disabled-store cfg)]
             (swap! state pool/restore-disabled (array-seq (js/Array.from (await (.loadDisabledAccounts store)))))))

         :getRequestOrder
         (fn ^:async get-request-order [provider-id]
           (await (ensure-fresh false))
           (credentials->js (step! pool/request-order (provider-id-or-default provider-id) (now) (opts))))

         :getRequestOrderWithRefresh
         (fn ^:async get-request-order-with-refresh [provider-id refresh-expired-token]
           (await (ensure-fresh false))
           (let [{:keys [ready refresh]} (step! pool/refresh-plan (provider-id-or-default provider-id) (now) (opts))
                 refreshed (loop [todo refresh acc []]
                             (if (empty? todo)
                               acc
                               (recur (rest todo)
                                      (if-let [fresh (try (await (refresh-expired-token (credential->js (first todo))))
                                                          (catch :default _ nil))]
                                        (conj acc (js->credential fresh))
                                        acc))))]
             (credentials->js (into ready refreshed))))

         :getAllAccounts
         (fn ^:async get-all-accounts [provider-id]
           (await (ensure-fresh false))
           (credentials->js (get-in @state [:providers (cr/normalize-provider-id (provider-id-or-default provider-id)) :accounts])))

         :updateAccountCredential
         (fn [provider-id old-credential new-credential]
           (swap! state pool/update-account-credential provider-id (js->credential old-credential) (js->credential new-credential))
           nil)

         :isAccountExpired
         (fn [credential] (pool/credential-expired? (js->credential credential) (now)))

         :getExpiredAccountsWithRefreshTokens
         (fn [provider-id] (credentials->js (pool/expired-with-refresh-tokens @state (provider-id-or-default provider-id) (now))))

         :getExpiringAccounts
         (fn [window-ms] (credentials->js (pool/expiring-accounts @state (now) window-ms)))

         :getAllExpiredWithRefreshTokens
         (fn [] (credentials->js (pool/all-expired-with-refresh-tokens @state (now))))

         :markInFlight
         (fn [credential]
           (let [c (js->credential credential)
                 released (atom false)]
             (swap! state pool/mark-in-flight c)
             (fn release []
               (when-not @released
                 (reset! released true)
                 (swap! state pool/release-in-flight c)))))

         :markRateLimited
         (fn [credential retry-after-ms]
           (let [c (js->credential credential)
                 until (step! pool/mark-rate-limited c retry-after-ms (now) (opts))]
             (metric "proxy.key_pool.rate_limited" {"proxy.provider_id" (:provider-id c) "proxy.account_id" (:account-id c)})
             (persist-cooldown (:provider-id c) (:account-id c) until)
             nil))

         :markModelUnsupported
         (fn [credential model-id retry-after-ms]
           (let [c (js->credential credential)]
             (when (step! pool/mark-model-unsupported c model-id retry-after-ms (now) (opts))
               (metric "proxy.key_pool.model_unsupported"
                       {"proxy.provider_id" (:provider-id c) "proxy.account_id" (:account-id c)
                        "proxy.model_id" (pool/normalize-model-id model-id)}))
             nil))

         :setAccountCooldownUntil
         (fn [provider-id account-id until]
           (persist-cooldown provider-id account-id (step! pool/set-account-cooldown-until provider-id account-id until (now)))
           nil)

         :clearAccountCooldown
         (fn [provider-id account-id]
           (swap! state pool/clear-account-cooldown provider-id account-id)
           (clear-persisted provider-id account-id)
           nil)

         :isModelUnsupported
         (fn [provider-id account-id model-id] (boolean (pool/model-unsupported? @state provider-id account-id model-id (now))))

         :clearModelUnsupported
         (fn [provider-id account-id model-id] (swap! state pool/clear-model-unsupported provider-id account-id model-id) nil)

         :clearProviderCooldowns
         (fn [provider-id]
           (let [pid (cr/normalize-provider-id provider-id)]
             (doseq [account-id (step! pool/clear-provider-cooldowns provider-id)]
               (clear-persisted pid account-id))
             nil))

         :msUntilAnyKeyReady
         (fn ^:async ms-until-any-key-ready [provider-id]
           (await (ensure-fresh false))
           (:next-ready-in-ms (pool/provider-status @state (provider-id-or-default provider-id) (now) (opts))))

         :getStatus
         (fn ^:async get-status [provider-id]
           (await (ensure-fresh false))
           (status->js (pool/provider-status @state (provider-id-or-default provider-id) (now) (opts))))

         :getAllStatuses
         (fn ^:async get-all-statuses []
           (await (ensure-fresh false))
           (let [o #js {}]
             (doseq [pid (keys (:providers @state))]
               (aset o pid (status->js (pool/provider-status @state pid (now) (opts)))))
             o))

         :getAllAccountStatuses
         (fn ^:async get-all-account-statuses []
           (await (ensure-fresh false))
           (let [o #js {}]
             (doseq [[pid statuses] (pool/account-statuses @state (now) (opts))]
               (aset o pid (to-array (map account-status->js statuses))))
             o))

         :disableAccount
         (fn [provider-id account-id]
           (swap! state pool/disable-account provider-id account-id)
           (when-let [^js store (:disabled-store cfg)] (fire-and-forget (.setAccountDisabled store provider-id account-id true)))
           nil)

         :enableAccount
         (fn [provider-id account-id]
           (swap! state pool/enable-account provider-id account-id)
           (when-let [^js store (:disabled-store cfg)] (fire-and-forget (.setAccountDisabled store provider-id account-id false)))
           nil)

         :isAccountDisabled
         (fn [provider-id account-id] (pool/account-disabled? @state provider-id account-id))

         :getDisabledAccounts
         (fn [] (to-array (map (fn [[p a]] #js {:providerId p :accountId a}) (:disabled @state))))}))
