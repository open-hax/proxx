(ns proxx.runtime.auth-persistence
  "Postgres persistence of the OAuth sessions, access/refresh tokens and clients
  (formerly SqlAuthPersistence). Row-to-view mapping is proxx.auth.persistence
  (via proxx.runtime.sql); the statements below are persisted contracts, kept
  byte-for-byte, and the DDL is served by proxx.runtime.db-schema.

  Methods keep the original names and Promise results."
  (:require [proxx.runtime.db-schema :as schema]
            [proxx.runtime.sql :as rows]
            [proxx.runtime.sql-tag :as tag]))

(def ^:private get-session
  ["
      SELECT * FROM sessions WHERE id = "
   " AND expires_at > "
   "
    "])

(def ^:private set-session
  ["
      INSERT INTO sessions (id, subject, client_id, scopes, resource, extra, expires_at)
      VALUES (
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   "
      )
      ON CONFLICT (id) DO UPDATE SET
        subject = EXCLUDED.subject,
        client_id = EXCLUDED.client_id,
        scopes = EXCLUDED.scopes,
        resource = EXCLUDED.resource,
        extra = EXCLUDED.extra,
        expires_at = EXCLUDED.expires_at
    "])

(def ^:private delete-session
  ["DELETE FROM sessions WHERE id = "
   ""])

(def ^:private get-access-token
  ["
      SELECT * FROM access_tokens WHERE token = "
   " AND expires_at > "
   "
    "])

(def ^:private set-access-token
  ["
      INSERT INTO access_tokens (token, client_id, subject, scopes, resource, extra, expires_at)
      VALUES (
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   "
      )
    "])

(def ^:private delete-access-token
  ["DELETE FROM access_tokens WHERE token = "
   ""])

(def ^:private get-refresh-token
  ["
      SELECT * FROM refresh_tokens WHERE token = "
   " AND expires_at > "
   "
    "])

(def ^:private set-refresh-token
  ["
      INSERT INTO refresh_tokens (token, client_id, subject, scopes, resource, extra, expires_at)
      VALUES (
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   "
      )
    "])

(def ^:private delete-refresh-token
  ["DELETE FROM refresh_tokens WHERE token = "
   ""])

(def ^:private get-client
  ["
      SELECT * FROM clients WHERE client_id = "
   "
    "])

(def ^:private set-client
  ["
      INSERT INTO clients (client_id, client_secret, client_name, redirect_uris, token_endpoint_auth_method, grant_types, response_types)
      VALUES (
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   "
      )
      ON CONFLICT (client_id) DO UPDATE SET
        client_secret = EXCLUDED.client_secret,
        client_name = EXCLUDED.client_name,
        redirect_uris = EXCLUDED.redirect_uris,
        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
        grant_types = EXCLUDED.grant_types,
        response_types = EXCLUDED.response_types
    "])

(def ^:private delete-expired-sessions
  ["DELETE FROM sessions WHERE expires_at <= "
   ""])

(def ^:private delete-expired-access-tokens
  ["DELETE FROM access_tokens WHERE expires_at <= "
   ""])

(def ^:private delete-expired-refresh-tokens
  ["DELETE FROM refresh_tokens WHERE expires_at <= "
   ""])


(defn- now-seconds [] (js/Math.floor (/ (js/Date.now) 1000)))

(defn- nullish [x] (if (nil? x) nil x))

(defn- json-or-null
  "JSON text of a truthy `extra`, else null (a JavaScript truthiness test)."
  [extra]
  (if (and (some? extra) (not (false? extra)) (not (= 0 extra)) (not (= "" extra)))
    (js/JSON.stringify extra)
    nil))

(defn- first-row [rs] (aget rs 0))

(defn- token-values [^js token]
  [(.-token token) (.-clientId token) (.-subject token) (js/JSON.stringify (.-scopes token))
   (nullish (.-resource token)) (json-or-null (.-extra token)) (.-expiresAt token)])

(defn create-sql-auth-persistence-js
  "The persistence over the postgres.js handle `sql`."
  [^js sql]
  (let [run (fn [pieces & values] (apply tag/exec sql pieces values))
        view-or-undefined (fn [view row] (if row (view row) js/undefined))
        update-extra (fn ^:async update-extra [statement token extra]
                       (let [rs (await (.unsafe sql statement #js [token (if extra (js/JSON.stringify extra) nil)]))]
                         (pos? (.-length rs))))]
    #js {:init (fn ^:async init []
                 (doseq [id ["CREATE_SESSIONS_TABLE" "CREATE_ACCESS_TOKENS_TABLE" "CREATE_REFRESH_TOKENS_TABLE" "CREATE_CLIENTS_TABLE"]]
                   (await (.unsafe sql (schema/sql-statement-js id))))
                 js/undefined)
         :getSession (fn ^:async get-session* [id]
                       (view-or-undefined rows/auth-session-view-js (first-row (await (run get-session id (now-seconds))))))
         :setSession (fn ^:async set-session* [^js session]
                       (await (apply run set-session
                                     [(.-id session) (.-subject session) (.-clientId session) (js/JSON.stringify (.-scopes session))
                                      (nullish (.-resource session)) (json-or-null (.-extra session)) (.-expiresAt session)]))
                       js/undefined)
         :deleteSession (fn ^:async delete-session* [id] (await (run delete-session id)) js/undefined)
         :getAccessToken (fn ^:async get-access-token* [token]
                           (view-or-undefined rows/auth-token-view-js (first-row (await (run get-access-token token (now-seconds))))))
         :setAccessToken (fn ^:async set-access-token* [token]
                           (await (apply run set-access-token (token-values token))) js/undefined)
         :deleteAccessToken (fn ^:async delete-access-token* [token] (await (run delete-access-token token)) js/undefined)
         :updateAccessTokenExtra (fn [token extra]
                                   (update-extra "UPDATE access_tokens SET extra = $2::jsonb WHERE token = $1 RETURNING token" token extra))
         :getRefreshToken (fn ^:async get-refresh-token* [token]
                            (view-or-undefined rows/auth-token-view-js (first-row (await (run get-refresh-token token (now-seconds))))))
         :setRefreshToken (fn ^:async set-refresh-token* [token]
                            (await (apply run set-refresh-token (token-values token))) js/undefined)
         :deleteRefreshToken (fn ^:async delete-refresh-token* [token] (await (run delete-refresh-token token)) js/undefined)
         :updateRefreshTokenExtra (fn [token extra]
                                    (update-extra "UPDATE refresh_tokens SET extra = $2::jsonb WHERE token = $1 RETURNING token" token extra))
         :getClient (fn ^:async get-client* [client-id]
                      (view-or-undefined rows/auth-client-view-js (first-row (await (run get-client client-id)))))
         :setClient (fn ^:async set-client* [^js client]
                      (await (run set-client (.-clientId client) (.-clientSecret client) (.-clientName client)
                                  (js/JSON.stringify (.-redirectUris client)) (.-tokenEndpointAuthMethod client)
                                  (js/JSON.stringify (.-grantTypes client)) (js/JSON.stringify (.-responseTypes client))))
                      js/undefined)
         :cleanup (fn ^:async cleanup []
                    (let [now (now-seconds)
                          sessions (await (run delete-expired-sessions now))
                          access (await (run delete-expired-access-tokens now))
                          refresh (await (run delete-expired-refresh-tokens now))]
                      (+ (.-count ^js sessions) (.-count ^js access) (.-count ^js refresh))))}))
