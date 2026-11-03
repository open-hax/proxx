(ns proxx.http.observability-app-test
  "src/tests/observability-routes.test.ts: the application registers the /api/ui observability endpoints."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.host-support :as hs]))

(def ^:private overrides
  {:localOllamaModelPatterns [":2b" ":3b" ":4b"] :requestLogsMaxEntries 5000 :enableKeyRandomWalk false
   :upstreamTransientRetryCount 0 :oauthRefreshMaxConcurrency 1 :oauthRefreshBackgroundIntervalMs 60000
   :oauthRefreshProactiveWindowMs 60000 :concurrencyThrottleMaxRetries 0})

(defn- observability-upstream [^js req ^js res]
  (.setHeader res "content-type" "application/json")
  (set! (.-statusCode res) 200)
  (if (.startsWith (or (.-url req) "/") "/v1/models")
    (.end res (js/JSON.stringify #js {"object" "list" "data" #js []}))
    (.end res (js/JSON.stringify #js {"ok" true}))))

(deftest ^:async create-app-registers-api-ui-observability-endpoints
  (let [{:keys [temp-dir paths]} (await (hs/create-fixture-dir "proxx-observability-routes-"
                                                               {:keys-payload {"providers" []}
                                                                :models-payload {"models" []}
                                                                :prompt-affinity-payload {"entries" []}
                                                                :settings-payload {"tenants" {}}}))]
    (try
      (await
       (hs/with-ok-upstream
         observability-upstream
         (fn ^:async run [port]
           (let [^js app (await (hs/create-app (hs/proxy-config port {:paths paths :auth-token "test-token" ; pragma: allowlist secret
                                                                      :allow-unauthenticated true
                                                                      :overrides overrides})))]
             (try
               (let [overview (await (hs/inject app {:method "GET" :url "/api/ui/dashboard/overview?window=daily"}))]
                 (is (= 200 (:status overview)))
                 (is (= "daily" (get-in overview [:json "window"])))
                 (is (some? (get-in overview [:json "summary"]))))
               (let [logs (await (hs/inject app {:method "GET" :url "/api/ui/request-logs?limit=5"}))]
                 (is (= 200 (:status logs)))
                 (is (vector? (get-in logs [:json "entries"]))))
               (finally (await (.close app))))))))
      (finally (await (hs/remove-dir temp-dir))))))
