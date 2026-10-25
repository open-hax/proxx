(ns proxx.auth.request
  "Who is calling? The decisions of request authentication, over already
  extracted credentials. Looking a token up (tenant API key, UI session) is an
  effect and stays at the edge, which asks in the order `lookup-order` gives.

  Resolution order: legacy admin token (bearer, then cookie) -> tenant API key
  (bearer) -> UI session (bearer, then the OAuth access-token cookie) ->
  anonymous when allowed. Secrets are compared with `=` exactly as the legacy
  code did (see the security note in the migration report)."
  (:require [clojure.string :as str]))

(defn- trimmed-or-nil [x]
  (when (string? x) (let [t (str/trim x)] (when (seq t) t))))

(defn bearer-token
  "The token of an `Authorization: Bearer <token>` header, or nil."
  [authorization]
  (when (string? authorization)
    (let [trimmed (str/trim authorization)]
      (when (str/starts-with? (str/lower-case trimmed) "bearer ")
        (trimmed-or-nil (subs trimmed 7))))))

(defn cookie-token [x] (trimmed-or-nil x))

(defn legacy-admin-source
  "`:bearer` or `:cookie` when the presented token is the configured proxy
  auth token, else nil. Nothing matches when no proxy token is configured."
  [proxy-auth-token bearer cookie]
  (when (seq proxy-auth-token)
    (cond (= bearer proxy-auth-token) :bearer
          (= cookie proxy-auth-token) :cookie)))

(defn ui-session-candidates
  "[[source token] ...] to try against the session resolver, in order. The
  OAuth cookie is skipped when it merely repeats the bearer token."
  [bearer oauth-access-token]
  (cond-> []
    bearer (conj [:bearer bearer])
    (and oauth-access-token (not= oauth-access-token bearer)) (conj [:cookie oauth-access-token])))

(def legacy-subject "legacy:proxy-auth-token")

(defn legacy-admin [source default-tenant-id]
  {"kind" "legacy_admin" "tenantId" default-tenant-id "role" "owner"
   "source" (name source) "subject" legacy-subject})

(defn tenant-api-key-auth
  "`match` is {\"id\" \"tenantId\" \"scopes\"}."
  [{:strs [id tenantId scopes]}]
  {"kind" "tenant_api_key" "tenantId" tenantId "role" "member" "source" "bearer"
   "subject" (str "tenant_api_key:" id) "keyId" id "scopes" scopes})

(defn ui-session-auth
  "`match` is {\"userId\" \"subject\" \"activeTenantId\" \"role\" \"memberships\"}."
  [source {:strs [userId subject activeTenantId role memberships]}]
  {"kind" "ui_session" "tenantId" activeTenantId "role" role "source" (name source)
   "userId" userId "subject" subject "memberships" memberships})

(def unauthenticated {"kind" "unauthenticated" "source" "none"})
