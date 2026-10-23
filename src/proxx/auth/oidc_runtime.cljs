;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-runtime
  "Bounded, non-authoritative in-memory product bindings. Restart requires SSO."
  (:require [proxx.auth.oidc-law :as law]
            [proxx.extern.oidc-client :as io]))

(defn current-time [adapters] ((or (:now adapters) io/now)))

(defn create-state [] {:transactions (atom {}) :sessions (atom {}) :discovery (atom nil) :renewing (atom {}) :devices (atom {})})

(defn ^:async relying-party! [state config]
  (or @(:discovery state)
      (let [rp (await (io/discover! config))]
        (reset! (:discovery state) rp)
        rp)))

(defn prune! [state now]
  (swap! (:transactions state)
         #(into {} (filter (fn [[_ tx]] (< now (+ (:created-at tx) law/transaction-ttl-ms))) %)))
  (swap! (:sessions state)
         #(into {} (filter (fn [[_ session]] (law/current-session? session now)) %))))

(defn ^:async begin! [state config now]
  (prune! state now)
  (when (>= (count @(:transactions state)) law/max-transactions)
    (throw (ex-info "login_busy" {:status 503 :error "login_busy"})))
  (let [rp (await (relying-party! state config))
        authorization (await (io/authorization! rp config))
        binding (io/random-secret)]
    ;; Recheck after async discovery; reserve synchronously before returning.
    (when (>= (count @(:transactions state)) law/max-transactions)
      (throw (ex-info "login_busy" {:status 503 :error "login_busy"})))
    (swap! (:transactions state) assoc (:state authorization)
           (assoc authorization :binding (io/digest binding) :created-at now))
    {:url (:url authorization) :binding binding}))

(defn consume! [state state-value binding now]
  (let [transaction (get @(:transactions state) state-value)]
    ;; Synchronous read+delete before any await: a state can win only once.
    (swap! (:transactions state) dissoc state-value)
    (when (law/valid-transaction? transaction (when binding (io/digest binding)) now)
      transaction)))

(defn ^:async local-auth! [adapters session]
  (let [user (await ((:get-user adapters) (:user-id session)))
        memberships (await ((:get-memberships adapters) (:user-id session)))]
    (law/local-context (js->clj user :keywordize-keys true)
                       (js->clj memberships :keywordize-keys true) session)))

(defn- ^:async renew! [state config adapters previous]
  (let [rp (await (relying-party! state config))
        renewed (await (io/refresh! rp config previous))]
    (try
      (when-not (law/renewal-admitted? previous renewed)
        (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
      (let [current (merge previous (select-keys renewed [:access-token :refresh-token :expires-at]))
            evidence (await (io/introspect! rp (:access-token current)))
            now (current-time adapters)
            bound (min (:session-expires-at previous) (law/session-bound current evidence now))]
        (when-not (and (law/grant-admitted? config current evidence now)
                       (= previous (get @(:sessions state) (:key previous))))
          (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
        (let [current (assoc current :session-expires-at bound)]
          (swap! (:sessions state) assoc (:key previous) current)
          current))
      (catch :default error
        (try (await (io/revoke-session! rp renewed)) (catch :default _ nil))
        (throw error)))))

(defn- ^:async current-session! [state config adapters session]
  (if (and (:key session) (:refresh-token session)
           (<= (- (:expires-at session) (current-time adapters)) law/refresh-window-ms))
    (if-let [pending (get @(:renewing state) (:key session))]
      (await pending)
      (let [pending (renew! state config adapters session)]
        (swap! (:renewing state) assoc (:key session) pending)
        (try (await pending)
             (finally (swap! (:renewing state) dissoc (:key session))))))
    session))

(defn ^:async verify! [state config adapters session now]
  (try
    (when-not (law/current-session? session now)
      (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
    (let [session (await (current-session! state config adapters session))
          rp (await (relying-party! state config))
          evidence (await (io/introspect! rp (:access-token session)))
          auth (await (local-auth! adapters session))
          current (max now (current-time adapters))]
      (when-not (and (law/grant-admitted? config session evidence current)
                     (< (- current now) 5000)
                     (or (nil? (:key session)) (= session (get @(:sessions state) (:key session)))))
        (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
      (when (:refresh-token session) (law/session-bound session evidence current))
      (if auth
        (assoc auth :sessionExpiresAt (min (or (:session-expires-at session) (:expires-at session))
                                            (law/session-bound session evidence current))
                    :expiresAt (min (:expires-at session) (law/session-bound session evidence current)))
        (throw (ex-info "account_link_required" {:status 403 :error "account_link_required"}))))
    (catch :default error
      (when (:key session)
        (let [[before _] (swap-vals! (:sessions state) dissoc (:key session))]
          (when-let [current (get before (:key session))]
            (try (await (io/revoke-session! (await (relying-party! state config)) current))
                 (catch :default _ nil)))))
      (throw error))))

(defn ^:async establish! [state config adapters tokens current? now]
  (let [rp (await (relying-party! state config))
        {:keys [claims access-token refresh-token expires-at]} tokens
        user-id (law/linked-user-id (:links config) (:iss claims) (:sub claims))
        session {:issuer (:iss claims) :subject (:sub claims) :user-id user-id
                 :access-token access-token :refresh-token refresh-token :nonce (:nonce claims)
                 :expires-at (or expires-at (* 1000 (:exp claims)))}]
    (try
      (when-not user-id
        (throw (ex-info "account_link_required" {:status 403 :error "account_link_required"})))
      (await (verify! state config adapters session now))
      (prune! state now)
      (when (>= (count @(:sessions state)) law/max-sessions)
        (throw (ex-info "login_busy" {:status 503 :error "login_busy"})))
      (let [evidence (await (io/introspect! rp access-token))
            bound (law/session-bound tokens evidence (current-time adapters))
            handle (io/random-secret)]
        (when-not (law/grant-admitted? config session evidence (current-time adapters))
          (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
        (when-not (current?)
          (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
        (swap! (:sessions state) assoc (io/digest handle)
               (assoc session :key (io/digest handle) :session-expires-at bound))
        {:handle handle :expires-at bound})
      (catch :default error
        ;; Orphaned grants are best-effort revoked; never retain an unlinked token.
        (try (await (io/revoke-session! rp session)) (catch :default _ nil))
        (throw error)))))

(defn ^:async complete! [state config adapters query transaction now]
  (let [rp (await (relying-party! state config))
        tokens (await (io/exchange! rp config query transaction))]
    (await (establish! state config adapters tokens (constantly true) now))))

(defn session [state handle] (when handle (get @(:sessions state) (io/digest handle))))
(defn remove-session! [state handle]
  (when handle (swap! (:sessions state) dissoc (io/digest handle))))
