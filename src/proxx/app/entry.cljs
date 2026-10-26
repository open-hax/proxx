(ns proxx.app.entry
  "The Node entry of the Proxx server: `node dist/cljs/main.js` (pnpm start, Docker,
  PM2). Telemetry, configuration, the application (`proxx.app.main`), listening
  and graceful shutdown (formerly src/main.ts).

  The stores and managers the application composes are host classes loaded from
  the host module (default `dist/app.js`; `PROXX_HOST_MODULE` overrides it, e.g.
  `src/app.ts` under `node --import tsx`)."
  (:require ["node:path" :as path]
            ["node:url" :as url]
            [clojure.string :as str]
            [proxx.app.main :as app-main]
            [proxx.runtime :as runtime]
            [proxx.runtime.config :as config]
            [proxx.runtime.pricing :as pricing]
            [proxx.runtime.telemetry :as telemetry]))

(def ^:private default-host-module "dist/app.js")
(def ^:private default-manifest "./resources/policies/runtime/00-manifest.edn")

(defn- env [k] (aget js/process.env k))

(defn policy-manifest-path
  "Absolute path of the runtime policy manifest (the PROXX_/PROXY_CLJS_POLICY_MANIFEST
  aliases, else the default)."
  []
  (let [configured (some (fn [k] (let [v (env k)] (when (and (string? v) (seq (str/trim v))) (str/trim v))))
                         ["PROXX_CLJS_POLICY_MANIFEST" "PROXY_CLJS_POLICY_MANIFEST"])]
    (.resolve path (js/process.cwd) (or configured default-manifest))))

(def ^:private import-module
  "Dynamic `import()`: Closure cannot transpile the expression, so it is spelled
  where the compiler does not look."
  (js/Function. "specifier" "return import(specifier)"))

(defn- ^:async load-host []
  (let [file (.resolve path (js/process.cwd) (or (env "PROXX_HOST_MODULE") default-host-module))
        ^js module (await (import-module (.-href (.pathToFileURL url file))))]
    (await (.prepare module))
    module))

(defn- ^:async shutdown!
  [^js app signal]
  (let [^js log (.-log app)]
    (.info log #js {"signal" signal} "shutdown: received signal, closing server")
    ;; Stop accepting connections and let in-flight requests finish (Fastify's graceful close).
    (try (await (.close app))
         (catch :default err (.warn log #js {"err" err} "shutdown: error while closing server")))
    (try (await (telemetry/shutdown-telemetry-js))
         (catch :default err (.warn log #js {"err" err} "shutdown: error while shutting down telemetry")))
    (js/process.exit 0)))

(defn ^:async main []
  (telemetry/init-telemetry-js js/process.env)
  (let [^js host-module (await (load-host))
        ^js loaded-config (config/load-config-js js/process.env (js/process.cwd) (policy-manifest-path))
        manifest (or (.-cljsPolicyManifestPath loaded-config) "resources/policies/runtime/00-manifest.edn")]
    (try (pricing/set-policy-model-pricing-overrides-js (runtime/load-model-pricing-overrides-js manifest))
         (catch :default error (js/console.warn "Failed to load policy pricing overrides:" error)))
    (let [^js app (await (app-main/create-app-js loaded-config (.-host host-module)))
          ^js log (.-log app)
          shutting-down (atom false)]
      (.info log #js {"entry" "proxx.app.entry"} "CLJS runtime loaded")
      (await (.listen app #js {"host" (.-host loaded-config) "port" (.-port loaded-config)}))
      (.info log #js {"host" (.-host loaded-config) "port" (.-port loaded-config)} "open-hax-openai-proxy listening")
      (doseq [signal ["SIGINT" "SIGTERM"]]
        (.on js/process signal
             (fn []
               (when-not @shutting-down
                 (reset! shutting-down true)
                 (shutdown! app signal))))))))

(defn start!
  "The module's init-fn: run `main`, and fail the process on a startup error."
  []
  (-> (main)
      (.catch (fn [error]
                (js/console.error error)
                (js/process.exit 1)))))
