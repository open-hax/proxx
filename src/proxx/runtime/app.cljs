(ns proxx.runtime.app
  "The application's Fastify edge (src/app.ts): global hooks and handlers as thin
  adapters over the pure decisions in proxx.http.app. Each one gathers request
  facts, asks the pure function, and applies the answer to the reply.

  Collaborators arrive as one JS object (stores, config); nothing is constructed here."
  (:require [proxx.app.wiring :as wiring]
            [proxx.http.app :as app]
            [proxx.http.request :as http-request]
            [proxx.runtime.auth :as auth]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

(defn- send! [^js reply {:keys [status headers body]}]
  (doseq [[k v] headers] (.header reply k v))
  (.code reply status)
  (.send reply (clj->js body)))

(defn- request-path [^js request]
  (app/raw-path (or (aget (aget request "raw") "url") (aget request "url"))))

(defn- ui-session-resolver [^js sql-store ^js persistence]
  (fn ^:async resolve-ui-session [token]
    (let [^js access-token (await (.getAccessToken persistence token))]
      (when access-token
        (let [tenant (app/active-tenant-id (interop/js->data (aget access-token "extra")))]
          (await (.resolveUiSession sql-store (aget access-token "subject") (or tenant js/undefined))))))))

(defn- auth-input [^js config ^js headers path ui-session? ^js sql-store ^js persistence cookie-name]
  (let [cookie (aget headers "cookie")]
    #js {:allowUnauthenticated (aget config "allowUnauthenticated")
         :proxyAuthToken (aget config "proxyAuthToken")
         :authorization (aget headers "authorization")
         :cookieToken (or (http-request/read-cookie-token cookie cookie-name) js/undefined)
         :oauthAccessToken (if ui-session? (or (http-request/read-cookie-token cookie "proxy_auth") js/undefined) js/undefined)
         :resolveTenantApiKey (if sql-store
                                (fn [token] (.resolveTenantApiKey sql-store token (aget config "proxyTokenPepper")))
                                js/undefined)
         :resolveUiSession (if (and ui-session? sql-store persistence)
                             (ui-session-resolver sql-store persistence)
                             js/undefined)}))

(defn install-request-hook-js
  "Decorates requests with `openHaxAuth` and adds the global onRequest hook: CORS
  headers, then (unless preflight or a public route) authentication, the tenant
  quota and the API-key last-used touch.
  deps: {config sqlCredentialStore sqlAuthPersistence proxySettingsStore
         requestLogStore defaultTenantId cookieName}"
  [^js app-instance ^js deps]
  (let [^js config (aget deps "config")
        ^js sql-store (aget deps "sqlCredentialStore")
        ^js persistence (aget deps "sqlAuthPersistence")
        ^js settings-store (aget deps "proxySettingsStore")
        ^js request-log (aget deps "requestLogStore")
        default-tenant (aget deps "defaultTenantId")
        cookie-name (aget deps "cookieName")]
    (.decorateRequest app-instance "openHaxAuth" nil)
    (.addHook
     app-instance "onRequest"
     (fn ^:async on-request [^js request ^js reply]
       (let [^js headers (aget request "headers")]
         (doseq [[k v] (app/cors-headers (aget headers "origin"))] (.header reply k v))
         (let [method (aget request "method")
               path (request-path request)
               {:keys [action ui-session?]} (app/request-plan method path (aget config "githubOAuthCallbackPath"))]
           (when (= :authenticate action)
             (let [bridge (app/bridge-internal-auth
                           {:headers (interop/js->data headers)
                            :path path
                            :remote-address (aget (aget (aget request "raw") "socket") "remoteAddress")
                            :default-tenant-id default-tenant})
                   resolved (if bridge
                              (clj->js bridge)
                              (await (auth/resolve-request-auth-js
                                      (auth-input config headers path ui-session? sql-store persistence cookie-name)
                                      default-tenant)))]
               (if-not resolved
                 (send! reply app/unauthorized-response)
                 (let [data (interop/js->data resolved)]
                   (aset request "openHaxAuth" resolved)
                   (let [rejection
                         (when (app/quota-checked? method path data)
                           (let [tenant-id (let [t (get data "tenantId")] (if (nil? t) default-tenant t))
                                 settings (await (.getForTenant settings-store tenant-id))
                                 limit (aget settings "requestsPerMinute")]
                             (when (and (number? limit) (pos? limit))
                               (app/quota-exceeded-response
                                tenant-id limit
                                (.countRequestsSince request-log (- (js/Date.now) 60000) #js {:tenantId tenant-id})))))]
                     (if rejection
                       (send! reply rejection)
                       (when (app/touch-key? data method path (some? sql-store))
                         (await (.touchTenantApiKeyLastUsed sql-store (get data "tenantId") (get data "keyId"))))))))))
           js/undefined))))))

(defn install-error-handler-js
  "The global error handler. deps: {isOpenAiHttpError}"
  [^js app-instance ^js deps]
  (let [typed? (aget deps "isOpenAiHttpError")]
    (.setErrorHandler
     app-instance
     (fn ^:async on-error [^js error ^js request ^js reply]
       (let [^js log (aget request "log")
             tenant-id (some-> (aget request "openHaxAuth") (aget "tenantId"))
             typed (when (typed? error)
                     {:status (aget error "statusCode") :message (aget error "message")
                      :type (aget error "type") :code (aget error "code")})
             {:keys [level log-message response]} (app/error-plan typed)
             fields (if typed
                      #js {:err error :code (aget error "code") :type (aget error "type") :meta (aget error "meta") :tenantId tenant-id}
                      #js {:err error :tenantId tenant-id})]
         (if (= :warn level) (.warn log fields log-message) (.error log fields log-message))
         (send! reply response)
         js/undefined)))))

(defn install-not-found-handler-js [^js app-instance]
  (.setNotFoundHandler
   app-instance
   (fn ^:async on-not-found [^js request ^js reply]
     (send! reply (app/not-found-response (aget request "method") (request-path request)))
     js/undefined)))

(defn- landing-route [web-port]
  {:method :get :path "/"
   :handler (fn [{:keys [headers raw]}]
              (let [single #(http-request/single-header-value (get headers %))]
                {:status 200
                 :headers {"content-type" "text/html; charset=utf-8"}
                 :body (app/landing-page
                        (app/web-console-url {:forwarded-host (single "x-forwarded-host")
                                              :host (single "host")
                                              :forwarded-proto (single "x-forwarded-proto")
                                              :protocol (aget raw "protocol")
                                              :web-port web-port}))}))})

(defn install-public-routes-js
  "CORS preflight answers, the landing page and the favicon.
  web-port is the console port (PROXY_WEB_PORT, default 5174)."
  [app-instance web-port]
  (ring/register!
   app-instance
   (concat (map (fn [path] {:method :options :path path :handler (fn [_] {:status 204})}) app/options-paths)
           [(landing-route web-port)
            {:method :get :path "/favicon.ico" :handler (fn [_] {:status 204})}])))

(defn create-refresh-openai-oauth-accounts-js
  "A function (accountId?) -> Promise<{totalAccounts refreshedCount failedCount}>
  that force-refreshes the key pool's OpenAI OAuth accounts (or one of them)."
  [^js key-pool ^js refresh-manager provider-id]
  (fn ^:async refresh-accounts [account-id]
    (let [accounts (try (await (.getAllAccounts key-pool provider-id)) (catch :default _ #js []))
          originals (vec (array-seq accounts))
          facts (map-indexed (fn [i ^js a] {"idx" i "authType" (aget a "authType")
                                            "refreshToken" (aget a "refreshToken") "accountId" (aget a "accountId")})
                             originals)
          candidates (mapv #(nth originals (get % "idx")) (app/refresh-candidates facts account-id))]
      (doseq [c candidates] (.clearFailures refresh-manager c))
      (let [results (await (.refreshBatch refresh-manager (into-array candidates)))
            refreshed (count (remove #(identical? nil %) (array-seq results)))
            total (count candidates)]
        (clj->js {"totalAccounts" total "refreshedCount" refreshed "failedCount" (- total refreshed)})))))

(defn merge-model-ids-js [local bridged]
  (clj->js (app/merge-model-ids (array-seq local) (array-seq bridged))))

(defn advertised-model-ids-js [sessions]
  (clj->js (app/advertised-model-ids (interop/js->data sessions))))

(defn wiring-plan-js [config]
  (clj->js (wiring/plan (interop/js->data config))))
