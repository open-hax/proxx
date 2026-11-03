(ns proxx.oauth.github
  "GitHub login routes: the decisions, as pure functions over request facts.
  Routes (fastify) stay in TypeScript and perform the effects (HTTP to GitHub,
  persistence, headers); they ask this namespace what to do.

  A pending authorization is {:redirect-uri :created-at ...}; the table of them
  is an immutable value (`add-pending`/`take-pending`) held in an atom at the
  edge. Time is always `now-ms`."
  (:require [clojure.string :as str]))

(def authorize-url "https://github.com/login/oauth/authorize")
(def token-url "https://github.com/login/oauth/access_token")
(def user-url "https://api.github.com/user")

(def access-token-ttl-seconds (* 60 60))
(def refresh-token-ttl-seconds (* 30 24 60 60))
(def pending-ttl-ms (* 5 60 1000))
(def scope "read:user user:email")
(def client-id "github-oauth")

;; ---------------------------------------------------------------------------
;; Pending authorizations
;; ---------------------------------------------------------------------------

(defn add-pending [pending state entry] (assoc pending state entry))

(defn take-pending
  "[entry pending'] — the entry is consumed whether or not it has expired."
  [pending state]
  [(get pending state) (dissoc pending state)])

(defn authorize-params
  "Query parameters of the GitHub authorize URL, in wire order."
  [github-client-id redirect-uri state]
  [["client_id" github-client-id] ["redirect_uri" redirect-uri] ["scope" scope] ["state" state]])

(defn callback-rejection
  "The error response for a callback's query, before any state is looked up:
  {:status :body} or nil when the query is acceptable."
  [{:strs [code state error error_description]}]
  (cond
    (seq error) {:status 400 :body (cond-> {"error" error} (some? error_description) (assoc "error_description" error_description))}
    (or (empty? code) (empty? state)) {:status 400 :body {"error" "invalid_request" "error_description" "Missing code or state"}}))

(defn pending-rejection
  "The error response for a looked-up pending entry (nil -> unknown state;
  older than five minutes -> expired), or nil when it is usable."
  [pending now-ms]
  (cond
    (nil? pending) {:status 400 :body {"error" "invalid_state" "error_description" "Invalid or expired state"}}
    (> (- now-ms (:created-at pending)) pending-ttl-ms)
    {:status 400 :body {"error" "expired_state" "error_description" "OAuth state expired"}}))

;; ---------------------------------------------------------------------------
;; Users and sessions
;; ---------------------------------------------------------------------------

(defn normalize-login [login] (str/lower-case (str/trim login)))

(defn refresh-plan
  "What `/auth/refresh` does with the stored refresh token: :missing, :expired
  (delete it; `expires-at` in epoch seconds) or :rotate."
  [found? expires-at now-s]
  (cond
    (not found?) :missing
    (<= expires-at now-s) :expired
    :else :rotate))

(defn admin-account-view
  "Public projection of a stored credential: never includes the secret."
  [{:strs [accountId authType refreshToken expiresAt]}]
  (cond-> {"id" accountId "authType" authType "hasToken" true "hasRefreshToken" (boolean (seq refreshToken))}
    (some? expiresAt) (assoc "expiresAt" expiresAt)))

;; ---------------------------------------------------------------------------
;; Cookies
;; ---------------------------------------------------------------------------

(defn cookie-value
  "The (decoded) value of cookie `name` in a Cookie header, or nil. `decode`
  is the host's URI-component decoder."
  [header name decode]
  (when (seq header)
    (let [prefix (str name "=")]
      (some (fn [part]
              (let [trimmed (str/trim part)]
                (when (str/starts-with? trimmed prefix)
                  (decode (subs trimmed (count prefix))))))
            (str/split header #";" -1)))))

(def ^:private attributes "Path=/; HttpOnly; Secure; SameSite=Strict")

(defn set-cookie-header [name value expires-http-date]
  (str name "=" value "; " attributes "; Expires=" expires-http-date))

(defn clear-cookie-header [name]
  (str name "=; " attributes "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"))

(defn bearer-from-authorization
  "The token of an `Authorization: Bearer ` header (exactly that prefix), or nil."
  [auth]
  (when (and (string? auth) (str/starts-with? auth "Bearer "))
    (subs auth 7)))
