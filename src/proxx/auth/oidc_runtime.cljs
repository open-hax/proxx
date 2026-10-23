;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-runtime
  "Bounded, non-authoritative in-memory product bindings. Restart requires SSO."
  (:require [proxx.auth.oidc-law :as law]
            [proxx.extern.oidc-client :as io]))

(defn current-time [adapters] ((or (:now adapters) io/now)))

(defn create-state [] {:transactions (atom {}) :sessions (atom {}) :discovery (atom nil)})

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

(defn ^:async verify! [state config adapters session now]
  (when-not (law/current-session? session now)
    (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
  (let [rp (await (relying-party! state config))
        evidence (await (io/introspect! rp (:access-token session)))]
    (when-not (law/grant-admitted? config session evidence (max now (current-time adapters)))
      (throw (ex-info "unauthorized" {:status 401 :error "unauthorized"})))
    (or (await (local-auth! adapters session))
        (throw (ex-info "account_link_required" {:status 403 :error "account_link_required"})))))

(defn ^:async complete! [state config adapters query transaction now]
  (let [rp (await (relying-party! state config))
        {:keys [claims access-token]} (await (io/exchange! rp config query transaction))
        user-id (law/linked-user-id (:links config) (:iss claims) (:sub claims))
        session {:issuer (:iss claims) :subject (:sub claims) :user-id user-id
                 :access-token access-token :expires-at (* 1000 (:exp claims))}]
    (try
      (when-not user-id
        (throw (ex-info "account_link_required" {:status 403 :error "account_link_required"})))
      (await (verify! state config adapters session now))
      (prune! state now)
      (when (>= (count @(:sessions state)) law/max-sessions)
        (throw (ex-info "login_busy" {:status 503 :error "login_busy"})))
      (let [handle (io/random-secret)]
        (swap! (:sessions state) assoc (io/digest handle) session)
        {:handle handle :expires-at (:expires-at session)})
      (catch :default error
        ;; Orphaned grants are best-effort revoked; never retain an unlinked token.
        (try (await (io/revoke! rp access-token)) (catch :default _ nil))
        (throw error)))))

(defn session [state handle] (when handle (get @(:sessions state) (io/digest handle))))
(defn remove-session! [state handle]
  (when handle (swap! (:sessions state) dissoc (io/digest handle))))
