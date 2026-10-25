(ns proxx.oauth.factory
  "Factory.ai (WorkOS) OAuth and the auth.v2 envelope: pure decisions only.
  Crypto, files, HTTP and the clock live in `proxx.runtime.oauth` and
  `proxx.runtime.factory-auth`; JWT payloads arrive here already decoded."
  (:require [clojure.string :as str]
            [proxx.oauth.flow :as flow]))

(def client-id "client_01HNM792M5G5G1A2THWPXKFMXB")
(def base-url "https://api.workos.com")
(def device-authorize-url (str base-url "/user_management/authorize/device"))
(def authenticate-url (str base-url "/user_management/authenticate"))
(def authorize-url (str base-url "/user_management/authorize"))

(def refresh-buffer-ms
  "How long before JWT expiry a Factory token is proactively refreshed (30 minutes)."
  (* 30 60 1000))

;; ---------------------------------------------------------------------------
;; JWT expiry and the refresh decision
;; ---------------------------------------------------------------------------

(defn jwt-expiry-ms
  "Expiry in epoch milliseconds from decoded JWT `claims`, or nil."
  [claims]
  (when (map? claims)
    (let [exp (get claims "exp")]
      (when (flow/finite-number? exp) (* exp 1000)))))

(defn needs-refresh?
  "Whether a Factory OAuth credential should be refreshed now. `jwt-expiry`
  is the expiry decoded from the token itself (preferred over the stored
  `:expires-at`). Without any expiry information a refresh is not forced."
  [{:keys [provider-id auth-type refresh-token expires-at]} jwt-expiry now-ms]
  (boolean
   (and (= provider-id "factory")
        (= auth-type "oauth_bearer")
        (seq refresh-token)
        (cond
          (some? jwt-expiry) (< (- jwt-expiry now-ms) refresh-buffer-ms)
          (number? expires-at) (< (- expires-at now-ms) refresh-buffer-ms)
          :else false))))

;; ---------------------------------------------------------------------------
;; auth.v2 envelope: base64(iv):base64(authTag):base64(ciphertext)
;; ---------------------------------------------------------------------------

(defn split-auth-v2
  "The three base64 segments of an auth.v2 file; anything else is an error."
  [encrypted-content]
  (let [parts (str/split (str/trim encrypted-content) #":" -1)]
    (when-not (= 3 (count parts))
      (throw (ex-info "Invalid auth.v2.file format: expected base64(iv):base64(authTag):base64(ciphertext)"
                      {:error/type :factory-auth/invalid-format})))
    parts))

(defn auth-v2-credentials
  "Validate decrypted auth.v2 JSON (`parsed`, string-keyed) into
  `{:access-token :refresh-token}`; the access token is mandatory."
  [parsed]
  (when-not (or (map? parsed) (sequential? parsed))
    (throw (ex-info "Decrypted auth.v2 content is not a valid JSON object"
                    {:error/type :factory-auth/not-an-object})))
  (let [text (fn [k] (let [v (when (map? parsed) (get parsed k))] (if (string? v) (str/trim v) "")))
        access (text "access_token")]
    (when (empty? access)
      (throw (ex-info "Decrypted auth.v2 content is missing access_token"
                      {:error/type :factory-auth/missing-access-token})))
    {:access-token access :refresh-token (text "refresh_token")}))

;; ---------------------------------------------------------------------------
;; WorkOS token endpoint
;; ---------------------------------------------------------------------------

(defn refresh-params [refresh-token]
  [["grant_type" "refresh_token"] ["refresh_token" refresh-token] ["client_id" client-id]])

(defn refreshed-tokens
  "Validate a WorkOS refresh response (`data`, string-keyed) into
  `{:access-token :refresh-token}`. Both tokens are mandatory. The caller adds
  the JWT expiry."
  [data]
  (when-not (or (map? data) (sequential? data))
    (throw (ex-info "WorkOS token refresh returned invalid JSON" {:error/type :factory-auth/invalid-json})))
  (let [text (fn [k] (let [v (when (map? data) (get data k))] (if (string? v) (str/trim v) "")))
        access (text "access_token")
        refresh (text "refresh_token")]
    (when (empty? access)
      (throw (ex-info "WorkOS token refresh response missing access_token" {:error/type :factory-auth/missing-access-token})))
    (when (empty? refresh)
      (throw (ex-info "WorkOS token refresh response missing refresh_token" {:error/type :factory-auth/missing-refresh-token})))
    {:access-token access :refresh-token refresh}))

(defn device-start-params [] [["client_id" client-id]])

(defn device-poll-params [device-code]
  [["grant_type" "urn:ietf:params:oauth:grant-type:device_code"] ["device_code" device-code] ["client_id" client-id]])

(defn code-exchange-params [code]
  [["grant_type" "authorization_code"] ["code" code] ["client_id" client-id]])

(defn browser-authorize-params [redirect-uri state]
  [["client_id" client-id] ["redirect_uri" redirect-uri] ["response_type" "code"] ["state" state]])

(defn- js-truthy? [v] (not (or (nil? v) (false? v) (= v "") (= v 0))))

(defn verification-url [payload]
  (let [complete (get payload "verification_uri_complete")]
    (if (js-truthy? complete) complete (get payload "verification_uri"))))

(defn device-interval-ms
  "WorkOS reports the interval as a number of seconds."
  [interval]
  (if (and (flow/finite-number? interval) (pos? interval))
    (* interval 1000)
    flow/default-device-poll-interval-ms))

(defn account-id
  "`factory-<user id>`, or `factory-<uuid>` for a user-less response; `new-uuid`
  is a thunk supplied by the edge and called only when needed."
  [user new-uuid]
  (let [id (when (map? user) (get user "id"))]
    (str "factory-" (if (js-truthy? id) id (new-uuid)))))

(defn factory-tokens
  "Domain tokens for a WorkOS authenticate response."
  [response jwt-expiry new-uuid]
  (let [user (get response "user")
        email (when (map? user) (get user "email"))]
    (cond-> {:access-token (get response "access_token")
             :refresh-token (get response "refresh_token")
             :account-id (account-id user new-uuid)}
      (some? email) (assoc :email email)
      (some? jwt-expiry) (assoc :expires-at jwt-expiry))))

(defn device-poll-failure-plan
  "Classify a non-success device poll by the OAuth `error` code (string or nil):
  [:pending] [:slow-down] [:expired reason] or [:failed reason]."
  [status error]
  (cond
    (= error "authorization_pending") [:pending]
    (= error "slow_down") [:slow-down]
    (#{"expired_token" "access_denied"} error) [:expired (str "Device authorization " error)]
    :else [:failed (str "WorkOS device poll failed: " status " " (if (some? error) error "unknown error"))]))
