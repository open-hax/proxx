;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-law
  "Product admission laws. Remote identity supplies no local capabilities.")

(def transaction-ttl-ms 300000)
(def max-transactions 1000)
(def max-sessions 10000)
(def recheck-ms 10000)
(def authority-timeout-seconds 5)
(def start-path "/api/auth/axxium/start")
(def callback-path "/api/auth/axxium/callback")
(def logout-path "/api/auth/axxium/logout")
(def status-path "/api/auth/axxium/status")
(def public-paths #{start-path callback-path logout-path status-path})

(defn nonblank? [s] (and (string? s) (boolean (re-find #"\S" s))))

(defn links-valid? [issuer links]
  (and (vector? links)
       (every? #(and (= issuer (:issuer %)) (nonblank? (:subject %))
                     (nonblank? (:userId %))) links)
       (= (count links) (count (set (map (juxt :issuer :subject) links))))))

(defn configuration-admitted? [config links]
  (and (not (:allowUnauthenticated config))
       (nonblank? (:clientId config)) (nonblank? (:clientSecret config))
       (links-valid? (:issuer config) links)))

(defn linked-user-id
  "Only an explicit qualified link may select an existing product account.
   Ambiguous or missing links refuse, including email/name collisions."
  [links issuer subject]
  (let [matches (filter #(and (= issuer (:issuer %)) (= subject (:subject %))) links)]
    (when (= 1 (count matches)) (:userId (first matches)))))

(defn valid-transaction? [transaction browser-binding now]
  (and transaction (nonblank? browser-binding)
       (= browser-binding (:binding transaction))
       (<= (:created-at transaction) now)
       (< now (+ (:created-at transaction) transaction-ttl-ms))))

(defn current-session? [session now]
  (and session (number? (:expires-at session)) (< now (or (:session-expires-at session) (:expires-at session)))))

(defn grant-admitted?
  "Client-scoped RFC7662 evidence is mandatory. Some authorities omit aud/iss
   for opaque tokens; when present they must match. client_id, sub, exp and
   openid scope remain mandatory. No positive cache or clock-skew extension."
  [config session evidence now]
  (let [{:keys [active client_id sub exp scope iss aud]} evidence
        audience (if (string? aud) [aud] aud)]
    (and (current-session? session now)
         (< now (:expires-at session))
         (true? active) (= (:clientId config) client_id)
         (= (:subject session) sub) (= (:issuer config) (:issuer session))
         (or (nil? iss) (= (:issuer config) iss))
         (or (nil? aud) (and (sequential? audience)
                            (some #{(:clientId config)} audience)))
         (number? exp) (< now (* exp 1000))
         (string? scope) (contains? (set (re-seq #"\S+" scope)) "openid"))))

(defn local-context
  "Re-read local memberships. Never import remote roles or bootstrap an owner."
  [user memberships session]
  (let [active (filter #(and (= "active" (:tenantStatus %))
                             (contains? #{"owner" "admin" "member" "viewer"}
                                        (:role %))) memberships)
        membership (or (some #(when (= (:active-tenant-id session) (:tenantId %)) %) active)
                       (first active))]
    (when (and (= (:user-id session) (:id user)) (nonblank? (:subject user)) membership)
      {:kind "ui_session" :source "cookie" :userId (:id user)
       :subject (:subject user) :tenantId (:tenantId membership)
       :role (:role membership) :memberships (vec active)
       :oidc {:issuer (:issuer session) :subject (:subject session)}})))

(defn same-origin? [config origin] (= (:publicOrigin config) origin))
(defn safe-method? [method] (contains? #{"GET" "HEAD" "OPTIONS"} method))
(defn csrf-admitted? [config method origin]
  (or (safe-method? method) (same-origin? config origin)))

(defn node-enrollment-path?
  "Browser identity cannot enroll or operate a relay node."
  [path]
  (boolean (or (re-find #"^/api/(ui|v1)/federation/bridges?(?:/|$)" path)
               (re-find #"^/api/(ui|v1)/bridge(?:/|$)" path))))

(defn transport-context-current? [admitted current]
  (= (select-keys admitted [:userId :subject :tenantId :role :memberships :oidc])
     (select-keys current [:userId :subject :tenantId :role :memberships :oidc])))

(defn tenant-admitted? [auth tenant-id]
  (boolean (some #(= tenant-id (:tenantId %)) (:memberships auth))))

(def invalid-authorization-codes
  #{"OAUTH_JWT_CLAIM_COMPARISON_FAILED" "OAUTH_JWT_TIMESTAMP_CHECK_FAILED"
    "OAUTH_INVALID_RESPONSE" "OAUTH_RESPONSE_IS_NOT_CONFORM"
    "OAUTH_AUTHORIZATION_RESPONSE_ERROR" "OAUTH_RESPONSE_BODY_ERROR"
    "ERR_JWT_CLAIM_VALIDATION_FAILED" "ERR_JWT_EXPIRED"
    "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"})

(defn callback-failure [code]
  (if (contains? invalid-authorization-codes code)
    {:status 400 :error "invalid_authorization_response"}
    {:status 503 :error "authority_unavailable"}))

(def session-limit-ms 86400000)
(def refresh-window-ms 30000)

(defn session-bound [tokens evidence now]
  (if (:refresh-token tokens)
    (let [bound (:root_session_expires_at evidence)]
      (when-not (and (number? bound) (< now (* bound 1000)))
        (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
      (min (+ now session-limit-ms) (* bound 1000)))
    (:expires-at tokens)))

(defn renewal-admitted? [session renewed]
  (and (= (:issuer session) (get-in renewed [:claims :iss]))
       (= (:subject session) (get-in renewed [:claims :sub]))
       (nonblank? (:refresh-token renewed))
       (not= (:refresh-token session) (:refresh-token renewed))
       (or (nil? (get-in renewed [:claims :nonce]))
           (= (:nonce session) (get-in renewed [:claims :nonce])))))

(def device-start-path "/api/auth/axxium/device/start")
(def device-poll-path "/api/auth/axxium/device/poll")
(def device-cancel-path "/api/auth/axxium/device/cancel")
(def device-paths #{device-start-path device-poll-path device-cancel-path})

(defn device-poll-admission [tx now]
  (cond (nil? tx) :refuse
        (<= (:expires-at tx) now) :expired
        (= "completing" (:status tx)) :refuse
        (< now (:next-poll tx)) :slow
        :else :continue))
