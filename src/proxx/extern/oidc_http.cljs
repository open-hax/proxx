;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.oidc-http
  "Fastify/cookie/transport adapter for the Axxium relying party."
  (:require [clojure.string :as str]
            [proxx.auth.oidc-law :as law]
            [proxx.auth.oidc-runtime :as runtime]
            [proxx.extern.oidc-client :as io]))

(defn- path [request] (first (str/split (.-url request) #"\?" 2)))
(defn- handle [config request]
  (io/read-cookie (.. request -headers -cookie) (io/cookie-name config :session)))
(defn- status-error [status error] (ex-info error {:status status :error error}))

(defn- refusal [error]
  ;; Never send library errors, URLs, request bodies or credentials to logs/UI.
  (let [data (ex-data error)]
    {:status (or (:status data) 503) :error (or (:error data) "authority_unavailable")}))

(defn- send-refusal! [^js reply error]
  (let [{:keys [status error]} (refusal error)]
    (.header reply "Cache-Control" "no-store")
    (.code reply status)
    (.send reply #js {:error error
                     :message (if (= error "account_link_required")
                                "Approved account linkage is required. Contact your Proxx operator; no accounts were merged."
                                "Shared login could not be verified. Retry sign-in or contact your Proxx operator.")})))

(defn- private-reply! [^js reply]
  (.header reply "Cache-Control" "no-store")
  (.header reply "Referrer-Policy" "no-referrer")
  (.header reply "Content-Security-Policy" "default-src 'none'; frame-ancestors 'none'"))

(defn- guarded [handler]
  (fn ^:async oidc-handler [^js request ^js reply]
    (private-reply! reply)
    (try (await (handler request reply))
         (catch :default error (send-refusal! reply error)))))

(defn- close-stream! [^js raw error]
  (when-not (.-destroyed raw)
    (if (str/includes? (str (.getHeader raw "content-type")) "text/event-stream")
      (do (try (.write raw (str "event: auth_error\ndata: "
                                (js/JSON.stringify (clj->js (dissoc (refusal error) :status)))
                                "\n\n")) (catch :default _ nil))
          (.end raw))
      (.destroy raw))))

(defn- watch-response! [state config adapters request reply session-handle admitted-auth]
  (let [^js raw (.-raw reply)
        timer (atom nil)
        stopped? (atom false)
        stop! (fn [] (reset! stopped? true) (js/clearTimeout @timer))]
    (letfn [(schedule! []
              (let [session (runtime/session state session-handle)
                    delay (max 1 (min law/recheck-ms (- (or (:expires-at session) 0) (runtime/current-time adapters))))]
                (reset! timer (js/setTimeout check! delay))))
            (check! []
              (when-not @stopped?
                (-> (runtime/verify! state config adapters
                                     (runtime/session state session-handle) (runtime/current-time adapters))
                    (.then (fn [auth]
                             (when-not (law/transport-context-current? admitted-auth auth)
                               (throw (status-error 403 "forbidden")))
                             (when-not @stopped? (schedule!))))
                    (.catch (fn [error]
                              (stop!)
                              ;; End protected delivery before further timer work.
                              (close-stream! raw error))))))]
      (.once raw "finish" stop!)
      (.once raw "close" stop!)
      ;; Disconnects also cancel outstanding upstream HTTP work where the
      ;; existing route listens to its socket. Never replace already-sent status.
      (.once (.-raw request) "aborted" stop!)
      (schedule!))))

(defn- register-start! [^js app state config]
  (.get app law/start-path
        (guarded
         (fn ^:async start [_request ^js reply]
           (let [result (await (runtime/begin! state config (io/now)))]
             (.header reply "Set-Cookie" (io/cookie config :transaction (:binding result) 300))
             (.redirect reply (:url result)))))))

(defn- register-callback! [^js app state config adapters]
  (.get app law/callback-path
        (guarded
         (fn ^:async callback [^js request ^js reply]
           (let [url (js/URL. (.-url request) (:publicOrigin config))
                 state-value (.get (.-searchParams url) "state")
                 binding (io/read-cookie (.. request -headers -cookie)
                                         (io/cookie-name config :transaction))
                 transaction (runtime/consume! state state-value binding (io/now))]
             (.header reply "Set-Cookie" (io/cookie config :transaction "" 0))
             (when-not transaction (throw (status-error 400 "invalid_login_state")))
             (let [result (await (runtime/complete! state config adapters
                                  (.-search url) transaction (io/now)))
                   previous (handle config request)]
               ;; Rotate local transport binding; retain no independent refresh.
               (runtime/remove-session! state previous)
               (.header reply "Set-Cookie"
                        #js [(io/cookie config :transaction "" 0)
                             "proxy_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
                             "proxy_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
                             "open_hax_proxy_auth_token=; Path=/; Secure; SameSite=Lax; Max-Age=0"
                             (io/cookie config :session (:handle result)
                                        (max 0 (long (/ (- (:expires-at result) (io/now)) 1000))))])
               (.redirect reply "/")))))))

(defn- register-logout! [^js app state config]
  (.post app law/logout-path
         (guarded
          (fn ^:async logout [^js request ^js reply]
            (when-not (law/same-origin? config (.. request -headers -origin))
              (throw (status-error 403 "invalid_origin")))
            (let [session-handle (handle config request)
                  session (runtime/session state session-handle)]
              (runtime/remove-session! state session-handle)
              (.header reply "Set-Cookie" (io/cookie config :session "" 0))
              (when session
                (await (io/revoke! (await (runtime/relying-party! state config))
                                   (:access-token session))))
              (.send reply #js {:ok true :rootSession "unchanged"}))))))

(defn- register-status! [^js app state config adapters]
  (.get app law/status-path
        (guarded
         (fn ^:async status [^js request ^js reply]
           (let [session-handle (handle config request)]
             (if session-handle
               (let [auth (await (runtime/verify! state config adapters
                                  (runtime/session state session-handle) (runtime/current-time adapters)))]
                 (.send reply (clj->js {:enabled true :authenticated true :auth auth})))
               (.send reply #js {:enabled true :authenticated false})))))))

(defn create-consumer-js [raw-config ^js raw-adapters]
  (let [config (io/require-config! (js->clj raw-config :keywordize-keys true))
        state (runtime/create-state)
        adapters {:get-user (.-getUser raw-adapters) :get-memberships (.-getMemberships raw-adapters)
                  :now (or (.-now raw-adapters) io/now)}]
    (when-not (every? fn? (vals adapters))
      (throw (ex-info "Axxium requires local account and membership lookup" {})))
    #js {:isPublicPath (fn [value] (contains? law/public-paths value))
         :register (fn [^js app]
                     (register-start! app state config)
                     (register-callback! app state config adapters)
                     (register-logout! app state config)
                     (register-status! app state config adapters)
                     ;; Browser identity is not a relay/node grant. This bounded
                     ;; consumer refuses upgrades until transport qualification.
                     (.prependListener (.-server app) "upgrade"
                       (fn [request ^js socket _head]
                         (when (handle config request)
                           (aset request "axxiumUpgradeRefused" true)
                           (.end socket "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                           (.destroySoon socket))))
                     (.addHook app "onClose" (fn ^:async close-consumer []
                                               (reset! (:sessions state) {})
                                               (reset! (:transactions state) {}))))
         :selectTenant
         (fn ^:async select-tenant [request reply tenant-id]
           (try
             (when-not (law/same-origin? config (.. request -headers -origin))
               (throw (status-error 403 "invalid_origin")))
             (let [session-handle (handle config request)
                   auth (await (runtime/verify! state config adapters
                                 (runtime/session state session-handle) (runtime/current-time adapters)))]
               (when-not (law/tenant-admitted? auth tenant-id)
                 (throw (status-error 403 "forbidden")))
               (when-not (runtime/session state session-handle)
                 (throw (status-error 401 "unauthorized")))
               (swap! (:sessions state) update (io/digest session-handle) assoc :active-tenant-id tenant-id)
               (.send ^js reply #js {:ok true :activeTenantId tenant-id}))
             (catch :default error (send-refusal! reply error))))
         :admit (fn ^:async admit [^js request ^js reply]
                  (when-let [session-handle (handle config request)]
                    (try
                      (when-not (law/csrf-admitted? config (.-method request) (.. request -headers -origin))
                        (throw (status-error 403 "invalid_origin")))
                      (when (law/node-enrollment-path? (path request))
                        (throw (status-error 403 "node_grant_required")))
                      (let [auth (await (runtime/verify! state config adapters
                                         (runtime/session state session-handle) (runtime/current-time adapters)))]
                        (watch-response! state config adapters request reply session-handle auth)
                        (clj->js auth))
                      (catch :default error
                        (when (contains? #{401 403} (:status (refusal error)))
                          (runtime/remove-session! state session-handle))
                        (send-refusal! reply error) nil))))}))
