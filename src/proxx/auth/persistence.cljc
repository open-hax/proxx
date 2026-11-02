(ns proxx.auth.persistence
  "Row -> record mapping for the OAuth session tables (sessions, access and
  refresh tokens, clients). Rows are string-keyed snake_case; records leave as
  string-keyed camelCase data. JSON columns hold lists (`scopes`, URIs, ...);
  unparsable or missing lists fall back to the documented defaults. `extra`
  (an arbitrary JSON document) is not touched here: the edge parses it and
  attaches the original value."
  (:require [clojure.string :as str]))

;; Placeholder for an interpolated value in the statement templates below.
(def ^:private hole "~~")

(def default-grant-types ["authorization_code" "refresh_token"])
(def default-response-types ["code"])

(defn- number [x] #?(:cljs (js/Number x) :clj (double x)))

(defn- list-or
  "The parsed list from JSON text `raw` (a truthy string), or `default`.
  `parse` returns data or nil. Any parsed value is returned as-is, as before."
  [raw parse default]
  (if (seq raw)
    (let [parsed (parse raw)] (if (some? parsed) parsed default))
    default))

(defn- with-resource [m row]
  (if (some? (get row "resource")) (assoc m "resource" (get row "resource")) m))

(defn token-view
  "Access- or refresh-token record."
  [row parse]
  (with-resource {"token" (get row "token") "clientId" (get row "client_id") "subject" (get row "subject")
                  "scopes" (list-or (get row "scopes") parse [])
                  "expiresAt" (number (get row "expires_at"))}
    row))

(defn session-view
  "`created-at-s` is the parsed `created_at` in epoch seconds (floored)."
  [row parse created-at-s]
  (with-resource {"id" (get row "id") "subject" (get row "subject") "clientId" (get row "client_id")
                  "scopes" (list-or (get row "scopes") parse [])
                  "createdAt" created-at-s "expiresAt" (number (get row "expires_at"))}
    row))

(defn client-view [row parse]
  {"clientId" (get row "client_id") "clientSecret" (get row "client_secret") "clientName" (get row "client_name")
   "redirectUris" (list-or (get row "redirect_uris") parse [])
   "tokenEndpointAuthMethod" (get row "token_endpoint_auth_method")
   "grantTypes" (list-or (get row "grant_types") parse default-grant-types)
   "responseTypes" (list-or (get row "response_types") parse default-response-types)})

;; ---------------------------------------------------------------------------
;; Statements: tagged templates taken apart ({"strings" [...] "values" [...]}).
;; The literal text is the persisted contract and is byte-for-byte the original.
;; ---------------------------------------------------------------------------

(defn- statement [template values]
  {"strings" (vec (str/split template (re-pattern hole) -1)) "values" (vec values)})

(def ddl-statement-ids
  "Schema statements run by `init`, in order (texts live in resources/db/schema.edn)."
  ["CREATE_SESSIONS_TABLE" "CREATE_ACCESS_TOKENS_TABLE" "CREATE_REFRESH_TOKENS_TABLE" "CREATE_CLIENTS_TABLE"])

(defn select-by-id
  "`table` is one of sessions / access_tokens / refresh_tokens; `column` its key column."
  [table column key now-s]
  (statement (str "\n      SELECT * FROM " table " WHERE " column " = " hole " AND expires_at > " hole "\n    ")
             [key now-s]))

(defn delete-by-key [table column key]
  (statement (str "DELETE FROM " table " WHERE " column " = " hole) [key]))

(defn delete-expired [table now-s]
  (statement (str "DELETE FROM " table " WHERE expires_at <= " hole) [now-s]))

(defn upsert-session
  "`scopes-json` / `extra-json` are serialized by the caller; `extra-json` is nil when there is none."
  [{:keys [id subject client-id scopes-json resource extra-json expires-at]}]
  (statement (str "\n      INSERT INTO sessions (id, subject, client_id, scopes, resource, extra, expires_at)\n"
                  "      VALUES (\n        " hole ",\n        " hole ",\n        " hole ",\n        " hole
                  ",\n        " hole ",\n        " hole ",\n        " hole "\n      )\n"
                  "      ON CONFLICT (id) DO UPDATE SET\n"
                  "        subject = EXCLUDED.subject,\n        client_id = EXCLUDED.client_id,\n"
                  "        scopes = EXCLUDED.scopes,\n        resource = EXCLUDED.resource,\n"
                  "        extra = EXCLUDED.extra,\n        expires_at = EXCLUDED.expires_at\n    ")
             [id subject client-id scopes-json resource extra-json expires-at]))

(defn insert-token
  "Access or refresh token insert (no conflict clause)."
  [table {:keys [token client-id subject scopes-json resource extra-json expires-at]}]
  (statement (str "\n      INSERT INTO " table " (token, client_id, subject, scopes, resource, extra, expires_at)\n"
                  "      VALUES (\n        " hole ",\n        " hole ",\n        " hole ",\n        " hole
                  ",\n        " hole ",\n        " hole ",\n        " hole "\n      )\n    ")
             [token client-id subject scopes-json resource extra-json expires-at]))

(defn update-token-extra
  "`.unsafe` statement; `extra-json` nil clears the column."
  [table token extra-json]
  {"text" (str "UPDATE " table " SET extra = $2::jsonb WHERE token = $1 RETURNING token")
   "values" [token extra-json]})

(defn select-client [client-id]
  (statement (str "\n      SELECT * FROM clients WHERE client_id = " hole "\n    ") [client-id]))

(defn upsert-client
  [{:keys [client-id client-secret client-name redirect-uris-json token-endpoint-auth-method grant-types-json response-types-json]}]
  (statement (str "\n      INSERT INTO clients (client_id, client_secret, client_name, redirect_uris, token_endpoint_auth_method, grant_types, response_types)\n"
                  "      VALUES (\n        " hole ",\n        " hole ",\n        " hole ",\n        " hole
                  ",\n        " hole ",\n        " hole ",\n        " hole "\n      )\n"
                  "      ON CONFLICT (client_id) DO UPDATE SET\n"
                  "        client_secret = EXCLUDED.client_secret,\n        client_name = EXCLUDED.client_name,\n"
                  "        redirect_uris = EXCLUDED.redirect_uris,\n"
                  "        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,\n"
                  "        grant_types = EXCLUDED.grant_types,\n        response_types = EXCLUDED.response_types\n    ")
             [client-id client-secret client-name redirect-uris-json token-endpoint-auth-method grant-types-json response-types-json]))
