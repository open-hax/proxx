(ns proxx.runtime.host-dashboard
  "Effects of the host dashboard: the Docker unix socket, Caddyfile reads and
  the remote /api/ui/hosts/self fetch. Parsing, summarizing and snapshot
  assembly are proxx.dashboard.host; this namespace converts at the edge and
  sequences the reads. Exported names and object shapes are those of the
  TypeScript module it replaced (absent optional fields are present-but-undefined)."
  (:require ["node:fs/promises" :as fsp]
            ["node:http" :as http]
            ["node:path" :as path]
            [proxx.dashboard.host :as host]
            [proxx.json :as json]))

(def ^:private docker-timeout-ms 5000)

(defn- undef [x] (if (nil? x) js/undefined x))
(defn- now-iso [] (.toISOString (js/Date.)))
(defn- err-message [e] (if (instance? js/Error e) (.-message e) (str e)))

(defn- target->js [t]
  #js {:id (get t "id") :label (get t "label") :baseUrl (undef (get t "baseUrl"))
       :publicHost (undef (get t "publicHost")) :authToken (undef (get t "authToken"))
       :authTokenEnv (undef (get t "authTokenEnv")) :notes (undef (get t "notes"))})

(defn- route->js [r]
  #js {:host (get r "host") :matcher (undef (get r "matcher"))
       :matchPaths (clj->js (get r "matchPaths")) :upstreams (clj->js (get r "upstreams"))})

(defn- snapshot->js [s]
  #js {:id (get s "id") :label (get s "label") :source (get s "source") :fetchedAt (get s "fetchedAt")
       :reachable (get s "reachable") :baseUrl (undef (get s "baseUrl")) :publicHost (undef (get s "publicHost"))
       :notes (undef (get s "notes")) :errors (clj->js (get s "errors"))
       :containers (clj->js (get s "containers")) :routes (if (= "local" (get s "source"))
                   (to-array (map route->js (get s "routes")))
                   (clj->js (get s "routes"))) ;; remote routes pass through untouched
       :summary (clj->js (get s "summary"))})

(defn- js->target [^js t] (js->clj t))

(defn- rethrow-as-error [e] (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

;; ---------------------------------------------------------------------------
;; Pure entry points
;; ---------------------------------------------------------------------------

(defn load-host-dashboard-targets-from-env-js [^js env]
  (try (to-array (map target->js (host/parse-targets (aget env "HOST_DASHBOARD_TARGETS_JSON"))))
       (catch :default e (rethrow-as-error e))))

(defn resolve-host-dashboard-target-token-js [target ^js env]
  (undef (host/resolve-token (js->target target) #(aget env %))))

(defn infer-self-host-dashboard-target-id-js [^js input]
  (undef (host/infer-self-id (mapv js->target (array-seq (.-targets input)))
                             {:explicit-self-id (.-explicitSelfId input)
                              :request-base-url (.-requestBaseUrl input)
                              :request-host (.-requestHost input)})))

(defn parse-caddy-routes-js [source]
  (to-array (map route->js (host/parse-caddy-routes source))))

;; ---------------------------------------------------------------------------
;; Local snapshot
;; ---------------------------------------------------------------------------

(defn- docker-request-json [socket-path request-path]
  (js/Promise.
   (fn [resolve reject]
     (let [req (.request http #js {:socketPath socket-path :path request-path :method "GET"
                                   :headers #js {"Host" "docker"}}
                         (fn [^js response]
                           (let [chunks (array)]
                             (.on response "data" (fn [chunk] (.push chunks (if (.isBuffer js/Buffer chunk) chunk (.from js/Buffer chunk)))))
                             (.on response "end"
                                  (fn []
                                    (let [body (.toString (.concat js/Buffer chunks) "utf8")
                                          status (or (.-statusCode response) 500)]
                                      (if (>= status 400)
                                        (reject (js/Error. (str "docker API " status ": " (if (seq body) body "request failed"))))
                                        (try (resolve (js/JSON.parse body))
                                             (catch :default e (reject (if (instance? js/Error e) e (js/Error. (str e))))))))))))) ]
       (.setTimeout req docker-timeout-ms #(.destroy req (js/Error. "docker socket request timed out")))
       (.on req "error" reject)
       (.end req)))))

(defn- ^:async list-docker-containers [socket-path]
  (host/container-summaries (js->clj (await (docker-request-json socket-path "/containers/json?all=1")))))

(defn- ^:async first-readable-file [paths]
  (loop [[p & more] paths]
    (when p
      (let [content (try (await (.readFile fsp p "utf8")) (catch :default _ nil))]
        (if (and content (seq (.trim content)))
          content
          (recur more))))))

(defn- ^:async load-local-caddy-routes [runtime-root]
  (let [candidates (map #(.resolve path %) (host/caddy-candidate-paths [(or runtime-root "") (.cwd js/process)]))]
    (if-let [text (await (first-readable-file candidates))]
      (host/parse-caddy-routes text)
      [])))

(defn ^:async collect-local-host-dashboard-snapshot-js
  "Snapshot of this host: Docker containers (when a socket is configured) and Caddy routes.
  input: {target, dockerSocketPath?, runtimeRoot?}."
  [^js input]
  (let [target (js->target (.-target input))
        errors (atom [])
        containers (if-let [socket (.-dockerSocketPath input)]
                     (try (await (list-docker-containers socket))
                          (catch :default e (swap! errors conj (err-message e)) []))
                     (do (swap! errors conj "docker socket not configured") []))
        routes (try (await (load-local-caddy-routes (.-runtimeRoot input)))
                    (catch :default e (swap! errors conj (err-message e)) []))]
    (snapshot->js (host/local-snapshot target (now-iso) @errors containers routes))))

;; ---------------------------------------------------------------------------
;; Remote snapshot
;; ---------------------------------------------------------------------------

(defn ^:async fetch-remote-host-dashboard-snapshot-js
  "Snapshot of a remote host from its /api/ui/hosts/self. input: {target, authToken?, timeoutMs}."
  [^js input]
  (let [target (js->target (.-target input))
        base-url (some-> (get target "baseUrl") .trim)]
    (if-not (seq base-url)
      (snapshot->js (host/unavailable-snapshot target "remote" "target baseUrl is not configured" (now-iso)))
      (let [controller (js/AbortController.)
            timeout (js/setTimeout #(.abort controller) (.-timeoutMs input))]
        (try
          (let [headers (js/Headers.)
                token (.-authToken input)
                _ (when (and token (seq token)) (.set headers "authorization" (str "Bearer " token)))
                ^js response (await (js/fetch (str base-url "/api/ui/hosts/self")
                                              #js {:method "GET" :headers headers :signal (.-signal controller)}))
                text (await (.text response))
                body (if (pos? (count text)) (js->clj (js/JSON.parse text)) {})]
            (snapshot->js (host/remote-snapshot target base-url (.-ok response) (.-status response) body (now-iso))))
          (catch :default e
            (snapshot->js (host/unavailable-snapshot target "remote" (err-message e) (now-iso))))
          (finally (js/clearTimeout timeout)))))))
