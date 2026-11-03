(ns proxx.app.entry
  "The Node entry of the Proxx server: `node dist/cljs/main.js` (pnpm start, Docker,
  PM2). Telemetry, configuration, the application (`proxx.app.main`), listening
  and graceful shutdown (formerly src/main.ts).

  The stores and managers the application composes come from `proxx.host`."
  (:require [proxx.host :as host]
            [proxx.policy.manifest-path :refer [policy-manifest-path]]
            [proxx.runtime :as runtime]
            [proxx.runtime.config :as config]
            [proxx.runtime.pricing :as pricing]
            [proxx.runtime.telemetry :as telemetry]))

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
  (await (host/prepare))
  (let [^js loaded-config (config/load-config-js js/process.env (js/process.cwd) (policy-manifest-path))
        manifest (or (.-cljsPolicyManifestPath loaded-config) "resources/policies/runtime/00-manifest.edn")]
    (try (pricing/set-policy-model-pricing-overrides-js (runtime/load-model-pricing-overrides-js manifest))
         (catch :default error (js/console.warn "Failed to load policy pricing overrides:" error)))
    (let [^js app (await (host/create-app-js loaded-config))
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
