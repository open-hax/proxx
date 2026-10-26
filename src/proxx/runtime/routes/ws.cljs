(ns proxx.runtime.routes.ws
  "WebSocket upgrades of the control plane (src/routes/api/ui/ws): the bridge
  relay and the request-log hub. Origin and authorization decisions are
  proxx.http.streams / proxx.http.ui-auth; this namespace owns the `upgrade`
  listener and the hub/relay lifecycle."
  (:require [proxx.http.streams :as streams]
            [proxx.http.ui-auth :as ui-auth]
            [proxx.runtime.route-auth :as route-auth]))

(def bridge-ws-path "/api/ui/federation/bridge/ws")
(def request-log-ws-path "/api/v1/federation/observability/ws")

(defn- header
  "First value of a header that Node may deliver as a string or an array."
  [^js headers k]
  (let [v (aget headers k)]
    (cond (string? v) v
          (array? v) (aget v 0))))

(defn- err-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- ^:async authorize-upgrade!
  "Origin, then identity, then the right hub. Rejections go to the hub/relay that
  owns the endpoint."
  [{:keys [auth-deps ^js bridge-relay ^js request-log-ws-hub]} bridge-ws? ^js request socket head ^js url reject]
  (let [headers (.-headers request)
        origin (aget headers "origin")
        forwarded-host (let [f (aget headers "x-forwarded-host")] (if (some? f) f (let [h (aget headers "host")] (if (some? h) h "localhost"))))]
    (if-not (streams/origin-allowed? origin forwarded-host)
      (reject 403 #js {:error "invalid_origin"})
      (let [auth (await (route-auth/resolve-control-auth auth-deps (header headers "authorization") (header headers "cookie")))]
        (cond
          (nil? auth) (reject 401 #js {:error "unauthorized"})
          (not (ui-auth/can-manage-federation? auth)) (reject 403 #js {:error "forbidden"})
          bridge-ws? (.handleAuthorizedUpgrade bridge-relay request socket head (clj->js (streams/identity-of auth true)))
          :else (let [params (.-searchParams url)
                      owner-subject (.get params "ownerSubject")
                      route-kind (.get params "routeKind")]
                  (.handleAuthorizedUpgrade request-log-ws-hub request socket head
                                            (clj->js (streams/identity-of auth false))
                                            (clj->js (streams/request-log-subscription owner-subject route-kind)))))))))

(defn upgrade-handler
  "The `upgrade` listener. A request target `new URL` cannot parse throws from
  the listener, as it did in the TypeScript original (pinned in ws_test)."
  [{:keys [^js bridge-relay ^js request-log-ws-hub ^js log] :as ctx}]
  (fn [^js request socket head]
    (let [url (js/URL. (or (.-url request) "/") "http://127.0.0.1")
          pathname (.-pathname url)
          bridge-ws? (= pathname bridge-ws-path)
          request-log-ws? (= pathname request-log-ws-path)]
      (when (or bridge-ws? request-log-ws?)
        (let [reject (fn [status payload]
                       (if bridge-ws?
                         (.rejectUpgrade bridge-relay socket status payload)
                         (.rejectUpgrade request-log-ws-hub socket status payload)))]
          (-> (authorize-upgrade! ctx bridge-ws? request socket head url reject)
              (.catch (fn [e]
                        (.warn log #js {:error (err-message e)} "failed to authorize websocket upgrade")
                        (reject 401 #js {:error "unauthorized"})))))))))

(defn register-web-socket-routes-js
  "deps: {proxyAuthToken, sqlCredentialStore?, authPersistence?, proxyTokenPepper, defaultTenantId,
  requestLogStore, createBridgeRelay (fn), createRequestLogWsHub (fn of the store)}.
  Returns {bridgeRelay, requestLogWsHub}."
  [^js app ^js deps]
  (let [bridge-relay ((.-createBridgeRelay deps))
        request-log-ws-hub ((.-createRequestLogWsHub deps) (.-requestLogStore deps))
        handler (upgrade-handler {:auth-deps {:proxy-auth-token (.-proxyAuthToken deps)
                                              :sql-credential-store (.-sqlCredentialStore deps)
                                              :auth-persistence (.-authPersistence deps)
                                              :pepper (.-proxyTokenPepper deps)
                                              :default-tenant-id (.-defaultTenantId deps)}
                                  :bridge-relay bridge-relay
                                  :request-log-ws-hub request-log-ws-hub
                                  :log (.-log app)})]
    (.on (.-server app) "upgrade" handler)
    (.addHook app "onClose"
              (fn ^:async close-hubs []
                (.off (.-server app) "upgrade" handler)
                (await (.close request-log-ws-hub))
                (await (.close bridge-relay))))
    #js {:bridgeRelay bridge-relay :requestLogWsHub request-log-ws-hub}))
