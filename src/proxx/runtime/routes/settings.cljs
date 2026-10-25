(ns proxx.runtime.routes.settings
  "Settings and tenant routes (src/routes/settings/*). Handlers gather facts from
  the host's stores, decide with proxx.http.settings / proxx.http.guard, and
  reply with plain data."
  (:require [proxx.http.guard :as guard]
            [proxx.http.request :as http-request]
            [proxx.http.settings :as settings]
            [proxx.http.ui-auth :as ui-auth]
            [proxx.runtime.ring :as ring]))

(defn- path [prefix suffix] (str (if (.endsWith prefix "/") (subs prefix 0 (dec (count prefix))) prefix) suffix))

(defn- clj-array [x] (js->clj (or x #js [])))

(defn- ^:async visible-tenants [^js store auth]
  (ui-auth/visible-tenants auth (if (= "legacy_admin" (get auth "kind"))
                                  (clj-array (await (.listTenants store)))
                                  [])))

(defn- cookie [request name]
  (http-request/read-cookie-token (get-in request [:headers "cookie"]) name))

(defn- ^:async with-active-tenant
  "Persist `tenant-id` as the active tenant in a stored token's `extra`."
  [^js stored update-fn tenant-id]
  (await (update-fn (clj->js (assoc (js->clj (or (.-extra stored) #js {})) "activeTenantId" tenant-id)))))

(defn routes
  "deps: {:proxy-settings-store :sql-credential-store :auth-persistence
          :proxy-token-pepper :log} (JS collaborators; any may be nil)."
  [{:keys [^js proxy-settings-store ^js sql-credential-store ^js auth-persistence proxy-token-pepper ^js log]} prefix]
  (let [need-store (fn [] (guard/require-present sql-credential-store 501 "tenant_store_not_supported"))]
    [{:method :get :path (path prefix "/settings")
      :handler (fn ^:async get-settings [{:keys [auth] :as req}]
                 (or (guard/require-auth req)
                     {:body (await (.getForTenant proxy-settings-store (settings/tenant-id-of auth)))}))}

     {:method :post :path (path prefix "/settings")
      :handler (fn ^:async post-settings [{:keys [auth body]}]
                 (let [{:keys [response tenant-id patch]} (settings/settings-update auth body)]
                   (or response
                       (let [^js next-settings (await (.setForTenant proxy-settings-store (clj->js patch) tenant-id))]
                         (when log
                           (.info log #js {:fastMode (.-fastMode next-settings)
                                           :requestsPerMinute (.-requestsPerMinute next-settings)
                                           :allowedModels (.-allowedModels next-settings)
                                           :allowedProviderIds (.-allowedProviderIds next-settings)
                                           :disabledProviderIds (.-disabledProviderIds next-settings)
                                           :tenantId tenant-id}
                                  "updated proxy UI settings"))
                         {:body next-settings}))))}

     {:method :get :path (path prefix "/me")
      :handler (fn ^:async get-me [{:keys [auth] :as req}]
                 (or (guard/require-auth req)
                     {:body {"auth" auth
                             "activeTenantId" (get auth "tenantId")
                             "memberships" (or (get auth "memberships") [])
                             "tenants" (if sql-credential-store (await (visible-tenants sql-credential-store auth)) [])}}))}

     {:method :get :path (path prefix "/tenants")
      :handler (fn ^:async get-tenants [{:keys [auth] :as req}]
                 (or (guard/require-auth req)
                     (need-store)
                     {:body {"tenants" (await (visible-tenants sql-credential-store auth))}}))}

     {:method :post :path (path prefix "/tenants/:tenantId/select")
      :handler (fn ^:async select-tenant [{:keys [auth params] :as req}]
                 (or (guard/require-auth req)
                     (guard/require-present auth-persistence 501 "auth_persistence_not_supported")
                     (when-not (= "ui_session" (get auth "kind")) (guard/error 400 "ui_session_required"))
                     (let [tenant-id (ui-auth/normalize-tenant-id (get params "tenantId"))
                           access-token (cookie req "proxy_auth")]
                       (or (guard/forbid-unless (ui-auth/can-view-tenant? auth tenant-id))
                           (when-not (seq access-token) (guard/error 401 "session_cookie_missing"))
                           (let [^js stored (await (.getAccessToken auth-persistence access-token))]
                             (if (or (nil? stored) (not= (.-subject stored) (get auth "subject")))
                               (guard/error 401 "invalid_session")
                               (let [refresh-token (cookie req "proxy_refresh")]
                                 (await (with-active-tenant stored #(.updateAccessTokenExtra auth-persistence access-token %) tenant-id))
                                 (when (seq refresh-token)
                                   (let [^js stored-refresh (await (.getRefreshToken auth-persistence refresh-token))]
                                     (when (and stored-refresh (= (.-subject stored-refresh) (get auth "subject")))
                                       (await (with-active-tenant stored-refresh #(.updateRefreshTokenExtra auth-persistence refresh-token %) tenant-id)))))
                                 {:body {"ok" true "activeTenantId" tenant-id}}))))))) }

     {:method :get :path (path prefix "/tenants/:tenantId/api-keys")
      :handler (fn ^:async list-keys [{:keys [params] :as req}]
                 (or (guard/require-auth req)
                     (need-store)
                     (guard/require-tenant-key-manager req (get params "tenantId"))
                     {:body {"tenantId" (get params "tenantId")
                             "keys" (await (.listTenantApiKeys sql-credential-store (get params "tenantId")))}}))}

     {:method :post :path (path prefix "/tenants/:tenantId/api-keys")
      :handler (fn ^:async create-key [{:keys [params body] :as req}]
                 (or (guard/require-auth req)
                     (need-store)
                     (guard/require-tenant-key-manager req (get params "tenantId"))
                     (let [{:keys [label scopes error]} (settings/new-api-key-spec body)]
                       (if error
                         (guard/error 400 error)
                         {:status 201
                          :body (await (.createTenantApiKey sql-credential-store (get params "tenantId") label
                                                            (clj->js scopes) proxy-token-pepper))}))))}

     {:method :delete :path (path prefix "/tenants/:tenantId/api-keys/:keyId")
      :handler (fn ^:async revoke-key [{:keys [params] :as req}]
                 (or (guard/require-auth req)
                     (need-store)
                     (guard/require-tenant-key-manager req (get params "tenantId"))
                     (if (await (.revokeTenantApiKey sql-credential-store (get params "tenantId") (get params "keyId")))
                       {:body {"ok" true "tenantId" (get params "tenantId") "keyId" (get params "keyId")}}
                       (guard/error 404 "tenant_api_key_not_found"))))}]))

(defn register-settings-routes-js
  "`deps` is the host collaborator bag; `prefix` the route prefix (e.g. /api/v1)."
  [app ^js deps prefix]
  (ring/register!
   app
   (routes {:proxy-settings-store (.-proxySettingsStore deps)
            :sql-credential-store (.-sqlCredentialStore deps)
            :auth-persistence (.-authPersistence deps)
            :proxy-token-pepper (.-proxyTokenPepper deps)
            :log (.-log deps)}
           prefix)))
