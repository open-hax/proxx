(ns proxx.runtime.auth-test
  "Request authentication through the kernel entry point `resolveRequestAuth`
  wraps (proxx.runtime.auth/resolve-request-auth-js); ported from the TypeScript
  request-auth tests."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.auth :as auth]))

(set! *warn-on-infer* false)

(defn ^:async resolve-auth
  "`input` is a map of JS option names; lookups are cljs fns returning a match or nil."
  [input]
  (let [o (clj->js (dissoc input :resolveTenantApiKey :resolveUiSession))]
    (doseq [k [:resolveTenantApiKey :resolveUiSession]
            :when (contains? input k)]
      (let [f (get input k)]
        (aset o (name k) (fn [token] (js/Promise.resolve (f token))))))
    (let [resolved (await (auth/resolve-request-auth-js o "default"))]
      ;; resolveRequestAuth turns a null result into undefined.
      (if (nil? resolved) js/undefined resolved))))

(deftest ^:async resolve-request-auth-accepts-legacy-admin-bearer-token-for-default-tenant
  (let [resolved (await (resolve-auth {:allowUnauthenticated false
                                       :proxyAuthToken "test-proxy-token"
                                       :authorization "Bearer test-proxy-token"}))]
    (is (some? resolved))
    (is (= "legacy_admin" (.-kind resolved)))
    (is (= "default" (.-tenantId resolved)))
    (is (= "bearer" (.-source resolved)))))

(deftest ^:async resolve-request-auth-accepts-legacy-admin-cookie-token-for-default-tenant
  (let [resolved (await (resolve-auth {:allowUnauthenticated false
                                       :proxyAuthToken "test-proxy-token"
                                       :cookieToken "test-proxy-token"}))]
    (is (some? resolved))
    (is (= "legacy_admin" (.-kind resolved)))
    (is (= "default" (.-tenantId resolved)))
    (is (= "cookie" (.-source resolved)))))

(deftest ^:async resolve-request-auth-accepts-tenant-api-key-bearer-token
  (let [resolved (await (resolve-auth
                         {:allowUnauthenticated false
                          :proxyAuthToken "test-proxy-token"
                          :authorization "Bearer tenant-secret"
                          :resolveTenantApiKey (fn [token]
                                                 (when (= token "tenant-secret")
                                                   #js {:id "key-1" :tenantId "acme" :label "CI key"
                                                        :prefix "ohpk_acme" :scopes #js ["proxy:use"]}))}))]
    (is (some? resolved))
    (is (= "tenant_api_key" (.-kind resolved)))
    (is (= "acme" (.-tenantId resolved)))
    (is (= "key-1" (.-keyId resolved)))
    (is (= ["proxy:use"] (vec (array-seq (.-scopes resolved)))))))

(deftest ^:async resolve-request-auth-accepts-tenant-api-key-bearer-token-when-no-legacy-proxy-token-is-configured
  (let [resolved (await (resolve-auth
                         {:allowUnauthenticated false
                          :authorization "Bearer tenant-secret"
                          :resolveTenantApiKey (fn [token]
                                                 (when (= token "tenant-secret")
                                                   #js {:id "key-2" :tenantId "beta" :label "automation"
                                                        :prefix "ohpk_beta" :scopes #js ["proxy:use"]}))}))]
    (is (some? resolved))
    (is (= "tenant_api_key" (.-kind resolved)))
    (is (= "beta" (.-tenantId resolved)))))

(deftest ^:async resolve-request-auth-accepts-ui-session-bearer-token
  (let [resolved (await (resolve-auth
                         {:allowUnauthenticated false
                          :authorization "Bearer ui-access-token"
                          :resolveUiSession (fn [token]
                                              (when (= token "ui-access-token")
                                                (clj->js {:userId "user-1" :subject "octocat" :activeTenantId "default" :role "owner"
                                                          :memberships [{:tenantId "default" :tenantName "default"
                                                                         :tenantStatus "active" :role "owner"}]})))}))]
    (is (some? resolved))
    (is (= "ui_session" (.-kind resolved)))
    (is (= "bearer" (.-source resolved)))
    (is (= "user-1" (.-userId resolved)))
    (is (= "default" (.-tenantId resolved)))
    (is (= "owner" (.-role resolved)))
    (is (= 1 (some-> (.-memberships resolved) .-length)))))

(deftest ^:async resolve-request-auth-accepts-ui-session-cookie-token
  (let [resolved (await (resolve-auth
                         {:allowUnauthenticated false
                          :oauthAccessToken "cookie-ui-token"
                          :resolveUiSession (fn [token]
                                              (when (= token "cookie-ui-token")
                                                (clj->js {:userId "user-2" :subject "hubot" :activeTenantId "acme" :role "admin"
                                                          :memberships [{:tenantId "acme" :tenantName "Acme"
                                                                         :tenantStatus "active" :role "admin"}]})))}))]
    (is (some? resolved))
    (is (= "ui_session" (.-kind resolved)))
    (is (= "cookie" (.-source resolved)))
    (is (= "hubot" (.-subject resolved)))
    (is (= "acme" (.-tenantId resolved)))))

(deftest ^:async resolve-request-auth-allows-explicit-unauthenticated-mode
  (let [resolved (await (resolve-auth {:allowUnauthenticated true}))]
    (is (some? resolved))
    (is (= "unauthenticated" (.-kind resolved)))))

(deftest ^:async resolve-request-auth-rejects-unknown-credentials-when-auth-is-required
  (let [resolved (await (resolve-auth {:allowUnauthenticated false
                                       :proxyAuthToken "test-proxy-token"
                                       :authorization "Bearer something-else"
                                       :resolveTenantApiKey (fn [_] nil)}))]
    (is (undefined? resolved))))
