(ns proxx.runtime.routes.hosts
  "Host dashboard routes (src/routes/hosts). Reads the environment and the
  snapshots at the edge; decisions are proxx.http.hosts."
  (:require [proxx.http.hosts :as hosts]
            [proxx.runtime.host-dashboard :as dash]
            [proxx.runtime.ring :as ring]))

(defn- env-trimmed [^js env k]
  (let [v (aget env k)]
    (when (string? v) (not-empty (.trim v)))))

(defn- ^:async snapshot-handler
  "Shared by both routes: `kind` is :self or :overview. `cfg` holds what the TS
  read once at registration (socket path, runtime root, timeout)."
  [kind ^js env targets {:keys [socket runtime-root timeout]} {:keys [auth headers raw]}]
  (or (hosts/authorize auth)
      (let [self-id (dash/infer-self-host-dashboard-target-id-js
                     #js {:targets targets
                          :explicitSelfId (aget env "HOST_DASHBOARD_SELF_ID")
                          :requestBaseUrl (hosts/base-url headers (.-protocol ^js raw))
                          :requestHost (let [h (get headers "host")] (when (string? h) h))})
            local (fn [target] (dash/collect-local-host-dashboard-snapshot-js
                                #js {:target target :dockerSocketPath socket :runtimeRoot runtime-root}))]
        (case kind
          :self (if-let [target (:t (hosts/select-self (map (fn [^js t] {:id (.-id t) :t t}) (array-seq targets)) self-id))]
                  {:body (await (local target))}
                  (hosts/no-targets))
          :overview (let [snapshots (await (js/Promise.all
                                            (to-array
                                             (map (fn [^js target]
                                                    (if (and self-id (= self-id (.-id target)))
                                                      (local target)
                                                      (dash/fetch-remote-host-dashboard-snapshot-js
                                                       #js {:target target
                                                            :authToken (dash/resolve-host-dashboard-target-token-js target env)
                                                            :timeoutMs timeout})))
                                                  (array-seq targets)))))]
                      {:body (hosts/overview (.toISOString (js/Date.)) self-id snapshots)})))))

(defn routes
  "`env` is the process environment; socket/root/timeout are read once here,
  the explicit self id and target tokens per request, as the TS did."
  [^js env prefix]
  (let [targets (dash/load-host-dashboard-targets-from-env-js env)
        cfg {:socket (env-trimmed env "HOST_DASHBOARD_DOCKER_SOCKET_PATH")
             :runtime-root (env-trimmed env "HOST_DASHBOARD_RUNTIME_ROOT")
             :timeout (hosts/timeout-ms (aget env "HOST_DASHBOARD_REQUEST_TIMEOUT_MS"))}]
    [{:method :get :path (str prefix "/hosts/self")
      :handler (fn [req] (snapshot-handler :self env targets cfg req))}
     {:method :get :path (str prefix "/hosts/overview")
      :handler (fn [req] (snapshot-handler :overview env targets cfg req))}]))

(defn register-host-routes-js [app ^js env prefix]
  (ring/register! app (routes env prefix)))
