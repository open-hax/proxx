(ns proxx.auth.persistence
  "Row -> record mapping for the OAuth session tables (sessions, access and
  refresh tokens, clients). Rows are string-keyed snake_case; records leave as
  string-keyed camelCase data. JSON columns hold lists (`scopes`, URIs, ...);
  unparsable or missing lists fall back to the documented defaults. `extra`
  (an arbitrary JSON document) is not touched here: the edge parses it and
  attaches the original value."
  (:require [clojure.string :as str]))

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
