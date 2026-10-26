(ns proxx.runtime.routes.credentials
  "Credential routes (src/routes/credentials/*). Handlers gather facts from the
  host's stores, key pool and OAuth managers, decide with proxx.http.credentials,
  and reply with plain data.

  The host hands in its collaborators as one JS object (see
  `register-credential-routes-js`); nothing here constructs a store or a manager."
  (:require [proxx.http.credentials :as creds]
            [proxx.http.guard :as guard]
            [proxx.http.request :as http-request]
            [proxx.http.route-path :as route-path]
            [proxx.http.ui-auth :as ui-auth]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

;; ---------------------------------------------------------------------------
;; Edge helpers
;; ---------------------------------------------------------------------------

(defn- ^:async settle
  "The value of `x` (awaited), or `fallback` when it throws or rejects
  (`promise.catch(() => fallback)`)."
  [x fallback]
  (try (await x) (catch :default _ fallback)))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (str e)))

(defn- random-suffix [] (.slice (.toString (js/Math.random) 36) 2 8))

(defn- generated-id [provider-id]
  (creds/generated-account-id provider-id (js/Date.now) (random-suffix)))

(defn- defined-js
  "A JS object of the entries of `m` whose values are not nil."
  [m]
  (let [o #js {}]
    (doseq [[k v] m :when (some? v)] (aset o k v))
    o))

(defn- ordered-js
  "A JS object with `m`'s entries in the order of `ks` (a CLJS map has no order)."
  [ks m]
  (let [o #js {}]
    (doseq [k ks :when (contains? m k)] (aset o k (clj->js (get m k))))
    o))

(defn- iso [ms]
  (when (and (number? ms) (js/Number.isFinite ms)) (.toISOString (js/Date. ms))))

(defn- text-reply [html] (creds/html-response html))

(defn- log-info! [^js log obj msg]
  (when log (.info log obj msg)))

(defn- nullable
  "A scalar read from a JS object: undefined is nil (the key is then dropped),
  null is `creds/js-null`."
  [x]
  (cond (identical? x js/undefined) nil
        (identical? x nil) creds/js-null
        :else x))

(defn- view-map
  "The scalar fields of a JS view object; undefined fields are absent, null ones kept."
  [^js o]
  (into {} (keep (fn [k] (let [v (nullable (aget o k))] (when (some? v) [k v])))) (js/Object.keys o)))

(defn- provider-view
  "A stored provider as a string-keyed map; its accounts are maps of their scalar fields."
  [^js p]
  (let [m (view-map p)
        accounts (aget p "accounts")]
    (cond-> (dissoc m "accounts")
      (array? accounts) (assoc "accounts" (mapv view-map (array-seq accounts))))))

(defn- ^:async key-pool-accounts
  "[[provider-id [{:account-id ...} ...]] ...] for every provider the key pool reports."
  [^js key-pool]
  (let [statuses (await (settle (.getAllStatuses key-pool) #js {}))]
    (loop [ids (array-seq (js/Object.keys statuses)) acc []]
      (if-let [id (first ids)]
        (let [accounts (await (settle (.getAllAccounts key-pool id) #js []))]
          (recur (rest ids)
                 (conj acc [id (mapv (fn [a] {:account-id (aget a "accountId")
                                              :auth-type (aget a "authType")
                                              :chatgpt-account-id (nullable (aget a "chatgptAccountId"))
                                              :plan-type (nullable (aget a "planType"))})
                                     (array-seq accounts))])))
        acc))))

(defn- ^:async visible-providers [^js credential-store ^js key-pool reveal?]
  (let [stored (await (settle (.listProviders credential-store reveal?) #js []))
        pool (await (key-pool-accounts key-pool))]
    (creds/visible-providers (mapv provider-view (array-seq stored)) pool)))

(defn- view->js [m]
  (let [o #js {}]
    (doseq [[k v] m] (aset o k (if (= creds/js-null v) nil v)))
    o))

(defn- accounts->js [accounts]
  (let [out (array)]
    (doseq [a accounts] (.push out (view->js a)))
    out))

(defn- ^:async warmup! [^js key-pool]
  (await (settle (.warmup key-pool) js/undefined)))

;; ---------------------------------------------------------------------------
;; Routes
;; ---------------------------------------------------------------------------

(defn- audit-entry [^js e]
  {:provider-id (aget e "providerId")
   :prompt-cache-key-hash (aget e "promptCacheKeyHash")
   :account-id (aget e "accountId")
   :status (aget e "status")
   :error (aget e "error")
   :shape-fingerprint (creds/trimmed-string (some-> (aget e "factoryDiagnostics") (aget "shapeFingerprint")))
   :cache-hit (aget e "cacheHit")
   :cached-prompt-tokens (aget e "cachedPromptTokens")
   :prompt-tokens (aget e "promptTokens")
   :model (aget e "model")
   :timestamp (aget e "timestamp")})

(defn- ^:async recent-openai-entries [^js config ^js sql-usage-store ^js request-log-store scan-limit]
  (let [query #js {:providerId (aget config "openaiProviderId") :limit scan-limit}
        entries (if sql-usage-store
                  (await (.listEntries sql-usage-store query))
                  (.list request-log-store query))]
    (filterv #(= "oauth_bearer" (aget % "authType")) (array-seq entries))))

(defn- audit->js
  "The audit as a JS object with the response's historical key order."
  [audit]
  (let [o #js {}]
    (doseq [k creds/audit-key-order]
      (aset o k (if (#{"rows" "watchRows"} k)
                  (let [out (array)]
                    (doseq [row (get audit k)] (.push out (ordered-js creds/audit-row-key-order row)))
                    out)
                  (clj->js (get audit k)))))
    o))

(defn- oauth-tokens-save!
  "Persist the tokens of a completed flow (the argument order is the store's)."
  [^js store provider-id ^js tokens factory?]
  (if factory?
    (.upsertOAuthAccount store provider-id (aget tokens "accountId") (aget tokens "accessToken") (aget tokens "refreshToken")
                         (aget tokens "expiresAt") js/undefined (aget tokens "email"))
    (.upsertOAuthAccount store provider-id (aget tokens "accountId") (aget tokens "accessToken") (aget tokens "refreshToken")
                         (aget tokens "expiresAt") (aget tokens "chatgptAccountId") (aget tokens "email")
                         (aget tokens "subject") (aget tokens "planType"))))

(defn routes
  "deps: {:config :key-pool :credential-store :request-log-store :sql-credential-store
          :sql-request-usage-store :refresh-openai-oauth-accounts :openai-oauth-manager
          :factory-oauth-manager :pending-reauth-targets (a JS Map) :fetch-openai-quota
          :probe-openai-account :probe-ollama-cloud-account :log}
  (JS collaborators; the optional ones may be nil). `shared-callbacks?` also
  registers the unprefixed /auth/* callbacks."
  [{:keys [^js config ^js key-pool ^js credential-store ^js request-log-store ^js sql-credential-store
           ^js sql-request-usage-store refresh-openai-oauth-accounts ^js openai-oauth-manager
           ^js factory-oauth-manager ^js pending-reauth-targets fetch-openai-quota probe-openai-account
           probe-ollama-cloud-account ^js log]}
   prefix shared-callbacks?]
  (let [at (fn [suffix] (route-path/join prefix suffix))
        openai-provider (aget config "openaiProviderId")

        openai-callback
        (fn ^:async openai-callback [{:keys [query]}]
          (let [{:keys [error description state code]} (creds/callback-query query)]
            (cond
              error
              (let [message (if (some? description) description error)]
                (when-not (string? message) (throw (js/TypeError. "str.replaceAll is not a function")))
                (text-reply (creds/html-error message)))

              (or (empty? state) (empty? code))
              (text-reply (creds/html-error creds/missing-callback-params))

              :else
              (try
                (let [target (.get pending-reauth-targets state)
                      _ (.delete pending-reauth-targets state)
                      ^js tokens (await (.completeBrowserFlow openai-oauth-manager state code))
                      _ (await (oauth-tokens-save! credential-store openai-provider tokens false))
                      tokens-data (interop/js->data tokens)
                      outcome (creds/openai-reauth-outcome (when target (creds/openai-reauth-target {"id" (aget target "accountId")
                                                                                                    "chatgptAccountId" (aget target "chatgptAccountId")
                                                                                                    "email" (aget target "email")
                                                                                                    "subject" (aget target "subject")}))
                                                          tokens-data
                                                          (boolean (aget credential-store "removeAccount")))
                      replaced-id (when (and (:replace? outcome)
                                             (await (.removeAccount credential-store openai-provider (aget target "accountId"))))
                                    (aget target "accountId"))]
                  (await (warmup! key-pool))
                  (log-info! log #js {:providerId openai-provider
                                      :accountId (aget tokens "accountId")
                                      :chatgptAccountId (aget tokens "chatgptAccountId")}
                             "saved OpenAI OAuth account from browser flow")
                  (text-reply (creds/html-success (creds/openai-success-message tokens-data replaced-id (:retained? outcome)))))
                (catch :default oauth-error
                  (text-reply (creds/html-error (error-message oauth-error))))))))

        factory-callback
        (fn ^:async factory-callback [{:keys [query]}]
          (let [{:keys [error description state code]} (creds/callback-query query)]
            (cond
              error
              (let [message (if (some? description) description error)]
                (when-not (string? message) (throw (js/TypeError. "str.replaceAll is not a function")))
                (text-reply (creds/html-error message)))

              (or (empty? state) (empty? code))
              (text-reply (creds/html-error creds/missing-callback-params))

              :else
              (try
                (let [^js tokens (await (.completeBrowserFlow factory-oauth-manager state code))]
                  (await (oauth-tokens-save! credential-store "factory" tokens true))
                  (await (warmup! key-pool))
                  (log-info! log #js {:providerId "factory" :accountId (aget tokens "accountId") :email (aget tokens "email")}
                             "saved Factory OAuth account from browser flow")
                  (text-reply (creds/html-success (creds/factory-success-message (interop/js->data tokens)))))
                (catch :default oauth-error
                  (text-reply (creds/html-error (error-message oauth-error))))))))]
    (cond->
     [{:method :get :path (at "/credentials")
       :handler (fn ^:async get-credentials [{:keys [query]}]
                  (let [reveal? (ui-auth/parse-boolean (get query "reveal"))
                        providers (await (settle (.listProviders credential-store reveal?) #js []))
                        summary (.providerSummary request-log-store)
                        statuses (await (settle (.getAllStatuses key-pool) #js {}))]
                    {:body {"providers" providers "keyPoolStatuses" statuses "requestLogSummary" summary}}))}

      {:method :get :path (at "/credentials/openai/quota")
       :handler (fn ^:async openai-quota [{:keys [query]}]
                  (let [requested (creds/trimmed-string (get query "accountId"))
                        visible (creds/visible-openai-accounts (await (visible-providers credential-store key-pool true)) openai-provider)
                        visible-ids (set (map #(get % "id") visible))
                        ^js overview (await (fetch-openai-quota credential-store
                                                                #js {:providerId openai-provider
                                                                     :accountId (or requested js/undefined)
                                                                     :accounts (accounts->js visible)
                                                                     :logger log}))
                        out (js/Object.assign #js {} overview)]
                    (aset out "accounts" (.filter (aget overview "accounts") (fn [a] (contains? visible-ids (aget a "accountId")))))
                    {:body out}))}

      {:method :get :path (at "/credentials/openai/prompt-cache-audit")
       :handler (fn ^:async prompt-cache-audit [{:keys [query]}]
                  (let [row-limit (creds/safe-limit (get query "limit") creds/default-row-limit creds/max-row-limit)
                        scan-limit (creds/safe-limit (get query "scanLimit") creds/default-scan-limit creds/max-scan-limit)
                        entries (await (recent-openai-entries config sql-request-usage-store request-log-store scan-limit))]
                    {:body (audit->js (creds/prompt-cache-audit (mapv audit-entry entries) row-limit openai-provider (js/Date.now) iso))}))}

      {:method :post :path (at "/credentials/openai/probe")
       :handler (fn ^:async openai-probe [{:keys [body]}]
                  (let [account-id (creds/trimmed-or-empty (get body "accountId"))]
                    (if (empty? account-id)
                      (guard/error 400 "account_id_required")
                      (try
                        (let [{:keys [base-url responses-path]} (creds/openai-probe-endpoint (aget config "openaiBaseUrl") (aget config "openaiResponsesPath"))]
                          {:body (await (probe-openai-account credential-store
                                                              #js {:providerId openai-provider
                                                                   :accountId account-id
                                                                   :openAiBaseUrl base-url
                                                                   :openAiResponsesPath responses-path
                                                                   :logger log}))})
                        (catch :default e
                          (creds/probe-failure-response (error-message e) "OpenAI account not found:" "account_not_found" "openai_probe_failed"))))))}

      {:method :post :path (at "/credentials/ollama-cloud/probe")
       :handler (fn ^:async ollama-cloud-probe [{:keys [body]}]
                  (let [account-id (creds/trimmed-or-empty (get body "accountId"))]
                    (if (empty? account-id)
                      (guard/error 400 "account_id_required")
                      (try
                        (let [base-url (creds/ollama-cloud-base-url (aget (aget config "upstreamProviderBaseUrls") "ollama-cloud"))]
                          {:body (await (probe-ollama-cloud-account credential-store
                                                                    #js {:providerId "ollama-cloud" :accountId account-id :baseUrl base-url}))})
                        (catch :default e
                          (creds/probe-failure-response (error-message e) "Ollama Cloud account not found:" "account_not_found" "ollama_cloud_probe_failed"))))))}

      {:method :post :path (at "/credentials/openai/oauth/refresh")
       :handler (fn ^:async openai-refresh [{:keys [body]}]
                  (if-not refresh-openai-oauth-accounts
                    (guard/error 501 "oauth_refresh_not_supported")
                    {:body (await (refresh-openai-oauth-accounts (or (creds/trimmed-string (get body "accountId")) js/undefined)))}))}

      {:method :post :path (at "/credentials/api-key")
       :handler (fn ^:async add-api-key [{:keys [body]}]
                  (let [{:keys [error provider-id api-key account-id]} (creds/api-key-request body (aget config "upstreamProviderId"))]
                    (if error
                      (guard/error 400 error)
                      (let [account-id (or account-id (generated-id provider-id))]
                        (await (.upsertApiKeyAccount credential-store provider-id account-id api-key))
                        (await (warmup! key-pool))
                        {:status 201 :body {"ok" true "providerId" provider-id "accountId" account-id}}))))}

      {:method :post :path (at "/credentials/provider")
       :handler (fn ^:async add-provider [{:keys [body]}]
                  (let [{:keys [error provider-id base-url api-key account-id]} (creds/provider-request body)]
                    (or (when error (guard/error 400 error))
                        (guard/require-present sql-credential-store 500 "sql_credential_store_not_available")
                        (do (await (.upsertProviderWithBaseUrl sql-credential-store provider-id "api_key" base-url))
                            (when (seq api-key)
                              (await (.upsertApiKeyAccount sql-credential-store provider-id (or account-id (generated-id provider-id)) api-key)))
                            (await (warmup! key-pool))
                            {:status 201 :body {"ok" true "providerId" provider-id "baseUrl" base-url}}))))}

      {:method :get :path (at "/credentials/provider/:providerId")
       :handler (fn ^:async get-provider [{:keys [params]}]
                  (or (guard/require-present sql-credential-store 500 "sql_credential_store_not_available")
                      (let [^js provider (await (.getProviderById sql-credential-store (get params "providerId")))]
                        (if-not provider
                          (guard/error 404 "provider_not_found")
                          {:body {"providerId" (aget provider "id")
                                  "authType" (aget provider "authType")
                                  "baseUrl" (aget provider "baseUrl")}}))))}

      {:method :delete :path (at "/credentials/account")
       :handler (fn ^:async remove-account [{:keys [body]}]
                  (if-let [{:keys [provider-id account-id]} (creds/account-ref body)]
                    (or (guard/require-present (aget credential-store "removeAccount") 501 "remove_account_not_supported")
                        (if-not (await (.removeAccount credential-store provider-id account-id))
                          (guard/error 404 "account_not_found")
                          (do (await (warmup! key-pool))
                              (log-info! log #js {:providerId provider-id :accountId account-id} "removed credential account")
                              {:body {"ok" true "providerId" provider-id "accountId" account-id}})))
                    creds/account-ref-required))}

      {:method :post :path (at "/credentials/account/disable")
       :handler (fn disable-account [{:keys [body]}]
                  (if-let [{:keys [provider-id account-id]} (creds/account-ref body)]
                    (do (.disableAccount key-pool provider-id account-id)
                        (log-info! log #js {:providerId provider-id :accountId account-id} "disabled credential account")
                        {:body {"ok" true "providerId" provider-id "accountId" account-id "disabled" true}})
                    creds/account-ref-required))}

      {:method :post :path (at "/credentials/account/enable")
       :handler (fn enable-account [{:keys [body]}]
                  (if-let [{:keys [provider-id account-id]} (creds/account-ref body)]
                    (do (.enableAccount key-pool provider-id account-id)
                        (log-info! log #js {:providerId provider-id :accountId account-id} "enabled credential account")
                        {:body {"ok" true "providerId" provider-id "accountId" account-id "disabled" false}})
                    creds/account-ref-required))}

      {:method :get :path (at "/credentials/accounts/disabled")
       :handler (fn disabled-accounts [_] {:body {"disabledAccounts" (.getDisabledAccounts key-pool)}})}

      {:method :post :path (at "/credentials/openai/oauth/browser/start")
       :handler (fn ^:async openai-browser-start [{:keys [body headers raw]}]
                  (let [redirect-base (creds/redirect-base-url body (creds/infer-base-url headers (aget raw "protocol")))
                        requested-account (creds/trimmed-or-empty (get body "accountId"))]
                    (if-not redirect-base
                      (guard/error 400 "redirect_base_url_required")
                      (let [target-account
                            (when (seq requested-account)
                              (let [providers (interop/js->data (await (.listProviders credential-store false)))
                                    provider (some #(when (= openai-provider (get % "id")) %) providers)]
                                (or (some #(when (= requested-account (get % "id")) %) (get provider "accounts"))
                                    ::missing)))]
                        (if (= ::missing target-account)
                          (guard/error 404 "account_not_found")
                          (let [^js payload (await (.startBrowserFlow openai-oauth-manager redirect-base))]
                            (when target-account
                              (.set pending-reauth-targets (aget payload "state")
                                    (defined-js (let [t (creds/openai-reauth-target target-account)]
                                                  {"accountId" (:account-id t) "chatgptAccountId" (:chatgpt-account-id t)
                                                   "email" (:email t) "subject" (:subject t)}))))
                            {:body payload}))))))}

      {:method :get :path (at "/credentials/openai/oauth/browser/callback") :handler openai-callback}

      {:method :post :path (at "/credentials/openai/oauth/device/start")
       :handler (fn ^:async openai-device-start [_]
                  (try {:body (await (.startDeviceFlow openai-oauth-manager))}
                       (catch :default e
                         {:status 502 :body {"error" "device_flow_start_failed" "detail" (error-message e)}})))}

      {:method :post :path (at "/credentials/openai/oauth/device/poll")
       :handler (fn ^:async openai-device-poll [{:keys [body]}]
                  (let [{:keys [device-auth-id user-code]} (creds/device-poll-request body)]
                    (if (or (empty? device-auth-id) (empty? user-code))
                      (guard/error 400 "device_auth_id_and_user_code_required")
                      (let [^js result (await (.pollDeviceFlow openai-oauth-manager device-auth-id user-code))]
                        (when (= "authorized" (aget result "state"))
                          (let [^js tokens (aget result "tokens")]
                            (await (oauth-tokens-save! credential-store openai-provider tokens false))
                            (await (warmup! key-pool))
                            (log-info! log #js {:providerId openai-provider
                                                :accountId (aget tokens "accountId")
                                                :chatgptAccountId (aget tokens "chatgptAccountId")}
                                       "saved OpenAI OAuth account from device flow")))
                        {:body result}))))}

      {:method :post :path (at "/credentials/factory/oauth/device/start")
       :handler (fn ^:async factory-device-start [_]
                  (try {:body (await (.startDeviceFlow factory-oauth-manager))}
                       (catch :default e
                         {:status 502 :body {"error" "device_flow_start_failed" "detail" (error-message e)}})))}

      {:method :post :path (at "/credentials/factory/oauth/device/poll")
       :handler (fn ^:async factory-device-poll [{:keys [body]}]
                  (let [device-auth-id (if (string? (get body "deviceAuthId")) (get body "deviceAuthId") "")]
                    (if (empty? device-auth-id)
                      (guard/error 400 "device_auth_id_required")
                      (let [^js result (await (.pollDeviceFlow factory-oauth-manager device-auth-id))]
                        (when (= "authorized" (aget result "state"))
                          (let [^js tokens (aget result "tokens")]
                            (await (oauth-tokens-save! credential-store "factory" tokens true))
                            (await (warmup! key-pool))
                            (log-info! log #js {:providerId "factory" :accountId (aget tokens "accountId") :email (aget tokens "email")}
                                       "saved Factory OAuth account from device flow")))
                        {:body result}))))}

      {:method :post :path (at "/credentials/factory/oauth/browser/start")
       :handler (fn ^:async factory-browser-start [{:keys [body headers raw]}]
                  (let [redirect-base (creds/redirect-base-url body (creds/infer-base-url headers (aget raw "protocol")))]
                    (if-not redirect-base
                      (guard/error 400 "redirect_base_url_required")
                      {:body (.startBrowserFlow factory-oauth-manager (.toString (js/URL. "/auth/factory/callback" redirect-base)))})))}]

      shared-callbacks?
      (into [{:method :get :path "/auth/callback" :handler openai-callback}
             {:method :get :path "/auth/factory/callback" :handler factory-callback}]))))

(defn register-credential-routes-js
  "`deps` is the host collaborator bag, `prefix` the route prefix and
  `shared-callbacks?` whether the unprefixed /auth/* callbacks are registered."
  [app ^js deps prefix shared-callbacks?]
  (ring/register!
   app
   (routes {:config (aget deps "config")
            :key-pool (aget deps "keyPool")
            :credential-store (aget deps "credentialStore")
            :request-log-store (aget deps "requestLogStore")
            :sql-credential-store (aget deps "sqlCredentialStore")
            :sql-request-usage-store (aget deps "sqlRequestUsageStore")
            :refresh-openai-oauth-accounts (aget deps "refreshOpenAiOauthAccounts")
            :openai-oauth-manager (aget deps "openAiOAuthManager")
            :factory-oauth-manager (aget deps "factoryOAuthManager")
            :pending-reauth-targets (aget deps "pendingOpenAiBrowserReauthTargets")
            :fetch-openai-quota (aget deps "fetchOpenAiQuotaSnapshots")
            :probe-openai-account (aget deps "probeOpenAiAccount")
            :probe-ollama-cloud-account (aget deps "probeOllamaCloudAccount")
            :log (aget deps "log")}
           prefix
           shared-callbacks?)))
