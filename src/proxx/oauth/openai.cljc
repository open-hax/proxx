(ns proxx.oauth.openai
  "OpenAI (ChatGPT/Codex) OAuth: every decision that does not touch the
  network, the clock or a random source.

  Inputs are wire data (string-keyed JWT claims and token responses); outputs
  are internal values (keyword maps) or ordered `[[k v] ...]` parameter lists
  that the edge serialises as a query or form body. Order matters on the wire,
  so parameter lists are vectors, never maps.

  Untrusted claims are read leniently: a field of the wrong type is treated as
  absent instead of crashing the flow (the legacy code threw a TypeError for a
  numeric `sub`, or smuggled a non-string through as an account id)."
  (:require [clojure.string :as str]
            [proxx.oauth.flow :as flow]))

(def default-client-id "app_EMoamEEZ73f0CkXaXp7hrann")
(def default-issuer "https://auth.openai.com")
(def default-scopes "openid profile email offline_access")
(def default-callback-port "1455")
(def default-token-expiry-buffer-ms 60000)

;; ---------------------------------------------------------------------------
;; Configuration
;; ---------------------------------------------------------------------------

(defn callback-port
  "The browser callback port from `OPENAI_OAUTH_CALLBACK_PORT` (a string, or
  nil): digits only, 1..65535, otherwise the Codex default; always rendered
  canonically."
  [raw]
  (let [trimmed (str/trim (if (string? raw) raw ""))]
    (if (re-matches #"\d+" trimmed)
      (let [port (flow/parse-int trimmed)]
        (if (and (flow/finite-number? port) (<= 1 port 65535))
          (str (long port))
          default-callback-port))
      default-callback-port)))

(defn- trimmed-or [value default]
  (let [t (when (string? value) (str/trim value))]
    (if (seq t) t default)))

(defn normalize-options
  "Defaults for the manager options (blank strings fall back as well)."
  [{:keys [oauth-scopes client-id issuer client-secret]}]
  {:oauth-scopes (trimmed-or oauth-scopes default-scopes)
   :client-id (trimmed-or client-id default-client-id)
   :issuer (trimmed-or issuer default-issuer)
   :client-secret (flow/blank->nil client-secret)})

;; ---------------------------------------------------------------------------
;; PKCE
;; ---------------------------------------------------------------------------

(def ^:private pkce-alphabet
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

(defn pkce-verifier
  "A verifier drawn from the RFC 7636 unreserved alphabet, one character per
  random byte."
  [random-bytes]
  (apply str (map #(nth pkce-alphabet (mod % (count pkce-alphabet))) random-bytes)))

;; ---------------------------------------------------------------------------
;; Requests
;; ---------------------------------------------------------------------------

(defn authorization-params
  "Query parameters of the authorize URL, in wire order."
  [{:keys [redirect-uri challenge state oauth-scopes client-id]}]
  [["response_type" "code"]
   ["client_id" client-id]
   ["redirect_uri" redirect-uri]
   ["scope" (trimmed-or oauth-scopes default-scopes)]
   ["code_challenge" challenge]
   ["code_challenge_method" "S256"]
   ["id_token_add_organizations" "true"]
   ["codex_cli_simplified_flow" "true"]
   ["originator" "codex_cli_rs"]
   ["state" state]])

(defn authorize-endpoint [issuer] (str issuer "/oauth/authorize"))
(defn token-endpoint [issuer] (str issuer "/oauth/token"))
(defn device-usercode-endpoint [issuer] (str issuer "/api/accounts/deviceauth/usercode"))
(defn device-token-endpoint [issuer] (str issuer "/api/accounts/deviceauth/token"))
(defn device-callback-uri [issuer] (str issuer "/deviceauth/callback"))
(defn device-verification-url [issuer] (str issuer "/codex/device"))

(defn- with-secret [params client-secret]
  (cond-> params client-secret (conj ["client_secret" client-secret])))

(defn code-exchange-params [{:keys [code redirect-uri client-id client-secret code-verifier]}]
  (-> [["grant_type" "authorization_code"] ["code" code] ["redirect_uri" redirect-uri]
       ["client_id" client-id]]
      (with-secret client-secret)
      (conj ["code_verifier" code-verifier])))

(defn refresh-params [{:keys [refresh-token client-id client-secret]}]
  (-> [["grant_type" "refresh_token"] ["refresh_token" refresh-token] ["client_id" client-id]]
      (with-secret client-secret)))

(defn redirect-base-plan
  "How the callback base URL is chosen: `:fixed` (always the Codex localhost
  topology), `:rewrite-loopback` (a loopback host is rewritten to localhost on
  the callback port) or `:keep`."
  [allow-host-routed? hostname]
  (if-not allow-host-routed?
    :fixed
    (if (#{"localhost" "127.0.0.1" "::1"} (str/lower-case (str/trim hostname)))
      :rewrite-loopback
      :keep)))

(defn fixed-callback-base [port] (str "http://localhost:" port "/"))

;; ---------------------------------------------------------------------------
;; JWT claims -> account identity
;; ---------------------------------------------------------------------------

(def ^:private auth-claim "https://api.openai.com/auth")
(def ^:private profile-claim "https://api.openai.com/profile")

(defn- first-string
  "The first string value, however blank: the legacy `??` chain stopped at \"\"."
  [& values]
  (some #(when (string? %) %) values))

(defn- claims-of [x] (if (map? x) x {}))

(defn- organization-id [claims]
  (let [orgs (get claims "organizations")
        org (cond (sequential? orgs) (first orgs)
                  (map? orgs) (get orgs "0"))]
    (when (map? org) (get org "id"))))

(defn account-id-from-claims [claims]
  (let [claims (claims-of claims)]
    (first-string (get claims "chatgpt_account_id")
                  (get-in claims [auth-claim "chatgpt_account_id"])
                  (organization-id claims))))

(defn plan-type-from-claims [claims]
  (let [claims (claims-of claims)]
    (first-string (get claims "chatgpt_plan_type")
                  (get-in claims [auth-claim "chatgpt_plan_type"]))))

(defn email-from-claims
  "Lower-cased, trimmed email; a blank top-level `email` shadows the profile one."
  [claims]
  (let [claims (claims-of claims)]
    (when-let [raw (first-string (get claims "email") (get-in claims [profile-claim "email"]))]
      (let [email (str/lower-case (str/trim raw))]
        (when (seq email) email)))))

(defn subject-from-claims [claims]
  (let [sub (get (claims-of claims) "sub")]
    (flow/blank->nil sub)))

(defn identity-discriminator [claims]
  (if-let [subject (subject-from-claims claims)]
    (str "sub:" subject)
    (when-let [email (email-from-claims claims)]
      (str "email:" email))))

(defn storage-account-id
  "`<chatgpt-account-id>-<12 hex of sha256(chatgpt-account-id NUL discriminator)>`.
  This is persisted identity: do not change the recipe."
  [sha256-hex chatgpt-account-id discriminator]
  (str chatgpt-account-id "-" (subs (sha256-hex (str chatgpt-account-id "\u0000" discriminator)) 0 12)))

(defn- nullish-first [a b] (if (some? a) a b))

(defn account-identity
  "Identity from the id token's claims, falling back to the access token's.
  `now-ms` only matters when neither names a ChatGPT account."
  [sha256-hex now-ms id-claims access-claims]
  (let [chatgpt-account-id (nullish-first (some-> id-claims account-id-from-claims)
                                          (some-> access-claims account-id-from-claims))
        email (or (email-from-claims id-claims) (email-from-claims access-claims))
        subject (or (subject-from-claims id-claims) (subject-from-claims access-claims))
        discriminator (or (identity-discriminator id-claims) (identity-discriminator access-claims))
        base (cond-> {} email (assoc :email email) subject (assoc :subject subject))]
    (cond
      (and (seq chatgpt-account-id) discriminator)
      (assoc base :account-id (storage-account-id sha256-hex chatgpt-account-id discriminator)
                  :chatgpt-account-id chatgpt-account-id)

      (seq chatgpt-account-id)
      (assoc base :account-id chatgpt-account-id :chatgpt-account-id chatgpt-account-id)

      :else (assoc base :account-id (str "openai-" now-ms)))))

(defn oauth-tokens
  "The domain tokens for a token-endpoint response `tokens` (string-keyed)."
  [sha256-hex now-ms tokens id-claims access-claims]
  (let [identity (account-identity sha256-hex now-ms id-claims access-claims)
        plan-type (nullish-first (first-string (get tokens "chatgpt_plan_type"))
                                 (nullish-first (some-> id-claims plan-type-from-claims)
                                                (some-> access-claims plan-type-from-claims)))
        refresh-token (get tokens "refresh_token")
        expires-in (get tokens "expires_in")]
    (cond-> (assoc identity :access-token (get tokens "access_token"))
      (some? refresh-token) (assoc :refresh-token refresh-token)
      (number? expires-in) (assoc :expires-at (+ now-ms (* expires-in 1000)))
      (some? plan-type) (assoc :plan-type plan-type))))

(defn token-expired?
  "True when `expires-at` is within `buffer-ms` of now; tokens without an
  expiry never expire."
  ([now-ms expires-at] (token-expired? now-ms expires-at default-token-expiry-buffer-ms))
  ([now-ms expires-at buffer-ms]
   (and (number? expires-at) (>= now-ms (- expires-at buffer-ms)))))

;; ---------------------------------------------------------------------------
;; Device flow
;; ---------------------------------------------------------------------------

(defn device-interval-ms
  "The poll interval from the usercode response's `interval` (seconds, as a string)."
  [interval]
  (let [seconds (flow/parse-int interval)]
    (if (and (flow/finite-number? seconds) (pos? seconds))
      (* seconds 1000)
      flow/default-device-poll-interval-ms)))

(defn device-poll-failure-plan
  "Classify a non-success device poll status: 403/404 mean the user has not
  finished yet; anything else ends the flow."
  [status]
  (if (#{403 404} status)
    [:pending]
    [:failed (str "OpenAI device authorization poll failed with status " status)]))

;; ---------------------------------------------------------------------------
;; Refresh errors
;; ---------------------------------------------------------------------------

(defn refresh-error-facts
  "Facts of a failed refresh: `body` is the parsed JSON error document (or nil
  when it was not JSON). A non-string message is ignored; code and type pass
  through as the provider sent them."
  [status response-text body]
  (let [error (when (map? body) (get body "error"))
        error (when (map? error) error)
        message (flow/blank->nil (get error "message"))]
    (cond-> {:status status
             :message (if message
                        (str "OpenAI token refresh failed with status " status ": " message)
                        (str "OpenAI token refresh failed with status " status))
             :response-body response-text}
      (some? (get error "code")) (assoc :code (get error "code"))
      (some? (get error "type")) (assoc :type (get error "type")))))

(defn terminal-refresh-error?
  "A refresh failure that retrying cannot fix: the refresh token is spent,
  expired or revoked. `facts` is `{:status :code :type :message :response-body}`."
  [{:keys [status code type message response-body]}]
  (or (= code "refresh_token_reused")
      (and (contains? #{400 401} status)
           (let [haystack (str/lower-case (str (or code "") " " (or type "") " " message " " (or response-body "")))]
             (boolean (some #(str/includes? haystack %)
                            ["invalid_grant" "refresh token expired" "refresh_token_expired"
                             "refresh token has already been used" "signing in again"]))))))
