(ns proxx.runtime.route-auth
  "Identity of a request that bypasses the application's auth hook's result and
  resolves its own: the streaming and WebSocket control-plane routes accept the
  proxy token, a tenant API key or a UI session cookie."
  (:require [proxx.http.request :as http-request]
            [proxx.runtime.auth :as auth]
            [proxx.runtime.interop :as interop]))

(defn- ^:async resolve-ui-session [^js sql-store ^js persistence token]
  (let [^js access (await (.getAccessToken persistence token))]
    (when access
      (let [extra (.-extra access)
            active (when (some? extra) (.-activeTenantId ^js extra))]
        (await (.resolveUiSession sql-store (.-subject access) (if (string? active) active js/undefined)))))))

(defn ^:async resolve-control-auth
  "The resolved identity as plain string-keyed data, or nil.
  deps: {:proxy-auth-token :sql-credential-store :auth-persistence :pepper :default-tenant-id}."
  [{:keys [proxy-auth-token ^js sql-credential-store ^js auth-persistence pepper default-tenant-id]} authorization cookie-header]
  (let [resolved (await (auth/resolve-request-auth-js
                         #js {:allowUnauthenticated false
                              :proxyAuthToken proxy-auth-token
                              :authorization authorization
                              :cookieToken (http-request/read-cookie-token cookie-header "open_hax_proxy_auth_token")
                              :oauthAccessToken (http-request/read-cookie-token cookie-header "proxy_auth")
                              :resolveTenantApiKey (when sql-credential-store
                                                     (fn [token] (.resolveTenantApiKey sql-credential-store token pepper)))
                              :resolveUiSession (when (and sql-credential-store auth-persistence)
                                                  (fn [token] (resolve-ui-session sql-credential-store auth-persistence token)))}
                         default-tenant-id))]
    (interop/js->data resolved)))
