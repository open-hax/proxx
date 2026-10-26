(ns proxx.runtime.token-refresh
  "Effects of OAuth token refresh: the in-flight promise map, the failure-record
  atom, the background timer, and the refresh handlers that call the OAuth
  managers and persist the new credentials. Which accounts to refresh, when an
  account is backed off and what a credential becomes are proxx.auth.refresh.

  Host collaborators (key pool, credential store, OAuth managers, logger) are JS
  objects; the TypeScript-only helpers the handlers need (terminal-error test,
  Factory token refresh/persistence, JWT expiry) arrive in `hooks`."
  (:require [proxx.auth.refresh :as refresh]
            [proxx.jsval :as j]))

(defn- now [] (js/Date.now))
(defn- undef [x] (if (nil? x) js/undefined x))
(defn- nullish-or [v default] (if (nil? v) default v))

(defn- credential->js
  "A credential object; nil fields are present-but-undefined, as the TypeScript literals were."
  [m]
  (let [o #js {}]
    (doseq [[k v] m] (aset o k (if (nil? v) js/undefined (clj->js v))))
    o))

(defn- js->credential [c] (js->clj c))

(defn- log! [^js logger level obj msg]
  (.call (aget logger level) logger obj msg))

;; ---------------------------------------------------------------------------
;; Manager
;; ---------------------------------------------------------------------------

(defn token-refresh-default-config-js []
  (let [d refresh/default-config]
    #js {:maxConcurrency (:max-concurrency d) :backgroundIntervalMs (:background-interval-ms d)
         :expiryBufferMs (:expiry-buffer-ms d) :proactiveRefreshWindowMs (:proactive-refresh-window-ms d)
         :maxConsecutiveFailures (:max-consecutive-failures d)}))

(defn- config-of [js-config]
  (let [given (js->clj (or js-config #js {}))
        pick (fn [k default] (if (contains? given k) (get given k) default))
        d refresh/default-config]
    {:max-concurrency (pick "maxConcurrency" (:max-concurrency d))
     :background-interval-ms (pick "backgroundIntervalMs" (:background-interval-ms d))
     :expiry-buffer-ms (pick "expiryBufferMs" (:expiry-buffer-ms d))
     :proactive-refresh-window-ms (pick "proactiveRefreshWindowMs" (:proactive-refresh-window-ms d))
     :max-consecutive-failures (pick "maxConsecutiveFailures" (:max-consecutive-failures d))}))

(defn- record->js [{:keys [consecutive-failures last-failure-at backoff-until]}]
  #js {:consecutiveFailures consecutive-failures :lastFailureAt last-failure-at :backoffUntil backoff-until})

(defn create-token-refresh-manager-js
  "A refresh manager around `do-refresh` (credential => Promise<credential|null>)."
  [do-refresh ^js logger config]
  (let [cfg (config-of config)
        in-flight (atom {})
        failures (atom {})
        stopped (atom false)
        timer (atom nil)
        refresh-one
        (fn ^:async refresh-one [credential]
          (let [k (refresh/account-key (js->credential credential))]
            (cond
              @stopped nil
              (refresh/backed-off? (get @failures k) (now) cfg) nil
              :else
              (if-let [existing (get @in-flight k)]
                (await existing)
                (let [p (-> (do-refresh credential)
                            (.then (fn [result] (swap! failures dissoc k) result))
                            (.catch (fn [error]
                                      (swap! failures update k refresh/record-failure (now))
                                      (log! logger "warn" #js {:accountId (.-accountId ^js credential) :error (js/String error)}
                                            "token refresh failed")
                                      nil))
                            (.finally #(swap! in-flight dissoc k)))]
                  (swap! in-flight assoc k p)
                  (await p))))))
        refresh-batch
        (fn ^:async refresh-batch [credentials]
          (loop [[batch & more] (refresh/batches (array-seq credentials) (:max-concurrency cfg))
                 results []]
            (if-not batch
              (to-array results)
              (let [settled (await (js/Promise.allSettled (to-array (map refresh-one batch))))]
                (recur more (into results (map #(if (= "fulfilled" (.-status ^js %)) (.-value ^js %) nil)) (array-seq settled)))))))
        o #js {}]
    (aset o "refresh" refresh-one)
    (aset o "refreshBatch" refresh-batch)
    (aset o "startBackgroundRefresh"
          (fn [get-expiring-accounts]
            (when-not @timer
              (reset! stopped false)
              (let [t (js/setInterval
                       (fn ^:async tick []
                         (try
                           (let [expiring (get-expiring-accounts)]
                             (when-not (zero? (.-length expiring))
                               (log! logger "info" #js {:count (.-length expiring)} "background: refreshing soon-expiring tokens")
                               (await (refresh-batch expiring))))
                           (catch :default _ nil)))
                       (:background-interval-ms cfg))]
                (when (fn? (.-unref t)) (.unref t))
                (reset! timer t)))
            js/undefined))
    (aset o "stopBackgroundRefresh"
          (fn []
            (when-let [t @timer] (js/clearInterval t) (reset! timer nil))
            js/undefined))
    (aset o "stopAndWait"
          (fn ^:async stop-and-wait []
            (reset! stopped true)
            (when-let [t @timer] (js/clearInterval t) (reset! timer nil))
            (loop []
              (when (seq @in-flight)
                (await (js/Promise.allSettled (to-array (vals @in-flight))))
                (recur)))
            js/undefined))
    (js/Object.defineProperty o "pendingCount" #js {:get (fn [] (count @in-flight)) :enumerable true})
    (aset o "isAccountBackedOff"
          (fn [credential] (refresh/backed-off? (get @failures (refresh/account-key (js->credential credential))) (now) cfg)))
    (aset o "getFailureRecord"
          (fn [credential] (undef (some-> (get @failures (refresh/account-key (js->credential credential))) record->js))))
    (aset o "clearFailures"
          (fn [credential] (swap! failures dissoc (refresh/account-key (js->credential credential))) js/undefined))
    o))

;; ---------------------------------------------------------------------------
;; Handlers
;; ---------------------------------------------------------------------------

(defn create-openai-refresh-handler-js
  "RefreshFn for OpenAI OAuth accounts. deps: {keyPool, runtimeCredentialStore, oauthManager, log};
  hooks: {isTerminalOpenAiRefreshError}."
  [^js deps ^js hooks]
  (let [key-pool (.-keyPool deps) store (.-runtimeCredentialStore deps) oauth (.-oauthManager deps) logger (.-log deps)]
    (fn ^:async openai-refresh [^js credential]
      (if-not (j/truthy? (.-refreshToken credential))
        nil
        (let [cred (js->credential credential)]
          (log! logger "info" #js {:accountId (.-accountId credential) :providerId (.-providerId credential)} "refreshing expired OAuth token")
          (let [tokens (try (await (.refreshToken oauth (.-refreshToken credential)))
                            (catch :default error
                              (when (.isTerminalOpenAiRefreshError hooks error)
                                (let [disabled (credential->js (refresh/disabled-credential cred))]
                                  (.updateAccountCredential key-pool (.-providerId credential) credential disabled)
                                  (when (refresh/rate-limit-disabled? cred (now))
                                    (.markRateLimited key-pool disabled refresh/disabled-cooldown-ms))
                                  (await (.upsertOAuthAccount store (.-providerId credential) (.-accountId disabled) (.-token disabled)
                                                              js/undefined (.-expiresAt disabled) (.-chatgptAccountId disabled)
                                                              js/undefined js/undefined (.-planType disabled)))
                                  (log! logger "warn" #js {:accountId (.-accountId credential) :providerId (.-providerId credential)
                                                           :code (.-code ^js error) :status (.-status ^js error)}
                                        "disabled terminally invalid OpenAI refresh token; full reauth required")))
                              (throw error)))
                new-cred (credential->js (refresh/openai-refreshed-credential cred (js->clj tokens)))]
            (.updateAccountCredential key-pool (.-providerId credential) credential new-cred)
            (await (.upsertOAuthAccount store (.-providerId credential) (.-accountId new-cred) (.-token new-cred) (.-refreshToken new-cred)
                                        (.-expiresAt new-cred) (.-chatgptAccountId new-cred)
                                        (.-email ^js tokens) (.-subject ^js tokens) (.-planType ^js tokens)))
            (log! logger "info" #js {:accountId (.-accountId new-cred) :providerId (.-providerId new-cred) :expiresAt (.-expiresAt new-cred)}
                  "OAuth token refreshed successfully")
            new-cred))))))

(defn create-factory-refresh-handler-js
  "RefreshFn for Factory OAuth accounts. deps: {keyPool, runtimeCredentialStore, sqlCredentialStore?, log};
  hooks: {refreshFactoryOAuthToken, parseJwtExpiry, persistFactoryAuthV2, toErrorMessage}."
  [^js deps ^js hooks]
  (let [key-pool (.-keyPool deps) store (.-runtimeCredentialStore deps) logger (.-log deps) sql-store (.-sqlCredentialStore deps)]
    (fn ^:async factory-refresh [^js credential]
      (if-not (j/truthy? (.-refreshToken credential))
        nil
        (try
          (log! logger "info" #js {:accountId (.-accountId credential) :providerId "factory"} "refreshing Factory OAuth token via WorkOS")
          (let [^js refreshed (await (.refreshFactoryOAuthToken hooks (.-refreshToken credential)))
                expiry (j/first-non-nil (.-expiresAt refreshed) (.parseJwtExpiry hooks (.-accessToken refreshed)))
                new-cred (credential->js (refresh/factory-refreshed-credential (js->credential credential) (js->clj refreshed) expiry))]
            (.updateAccountCredential key-pool "factory" credential new-cred)
            (await (.upsertOAuthAccount store "factory" (.-accountId new-cred) (.-token new-cred) (.-refreshToken new-cred) (.-expiresAt new-cred)))
            (when-not (j/truthy? sql-store)
              (try (await (.persistFactoryAuthV2 hooks (.-accessToken refreshed) (.-refreshToken refreshed)))
                   (catch :default _ nil)))
            (log! logger "info" #js {:accountId (.-accountId new-cred) :providerId "factory" :expiresAt (.-expiresAt new-cred)}
                  "Factory OAuth token refreshed successfully")
            new-cred)
          (catch :default error
            (log! logger "warn" #js {:error (.toErrorMessage hooks error) :accountId (.-accountId credential) :providerId "factory"}
                  "failed to refresh Factory OAuth token")
            nil))))))

(defn create-refresh-dispatcher-js
  "RefreshFn that sends Factory credentials to the Factory handler and the rest to the OpenAI one."
  [^js deps ^js hooks]
  (let [factory (create-factory-refresh-handler-js deps hooks)
        openai (create-openai-refresh-handler-js deps hooks)]
    (fn [^js credential]
      (if (= "factory" (.-providerId credential)) (factory credential) (openai credential)))))

(defn create-ensure-fresh-accounts-js
  "providerId => Promise<void> refreshing expired accounts (and, for Factory, those
  due for a proactive refresh). deps: {keyPool, tokenRefreshManager, shouldRefreshFactoryAccount?};
  hooks: {factoryCredentialNeedsRefresh}."
  [^js deps ^js hooks]
  (let [key-pool (.-keyPool deps) manager (.-tokenRefreshManager deps)
        should-refresh (or (.-shouldRefreshFactoryAccount deps) (.-factoryCredentialNeedsRefresh hooks))]
    (fn ^:async ensure-fresh [provider-id]
      (let [expired (.getExpiredAccountsWithRefreshTokens key-pool provider-id)]
        (when (pos? (.-length expired))
          (await (.refreshBatch manager expired)))
        (when (= provider-id "factory")
          (let [accounts (await (.catch (.getAllAccounts key-pool "factory") (fn [_] #js [])))]
            (doseq [account (refresh/factory-accounts-to-refresh (array-seq accounts) should-refresh)]
              (await (.refresh manager account)))))
        js/undefined))))
