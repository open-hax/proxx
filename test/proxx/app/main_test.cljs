(ns proxx.app.main-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.app.main :as app-main]))

(defn- noop-async [v] (fn [] (js/Promise.resolve v)))

(defn- fake-host
  "A host whose stores are in-memory fakes recording their lifecycle into `calls`."
  [calls]
  (let [record (fn [x] (swap! calls conj x))
        life (fn [name & methods]
               (let [o #js {}]
                 (doseq [m methods]
                   (aset o m (fn [& _] (record (str name "." m)) (js/Promise.resolve nil))))
                 o))]
    #js {"isOpenAiHttpError" (fn [_] false)
         "defaultTenantId" "default"
         "proxyAuthCookieName" "proxy_auth"
         "sql" #js {}
         "keyPool" (fn [opts]
                     (record (str "keyPool:" (.-defaultProviderId opts)))
                     (let [o (life "keyPool" "warmup")]
                       (aset o "getStatus" (fn [_] (js/Promise.resolve #js {"providerId" "p" "authType" "api_key" "totalAccounts" 1
                                                                            "availableAccounts" 1 "cooldownAccounts" 0 "nextReadyInMs" 0})))
                       (aset o "getAllStatuses" (fn [] (js/Promise.resolve #js {})))
                       (aset o "getAllExpiredWithRefreshTokens" (fn [] #js []))
                       (aset o "getExpiringAccounts" (fn [_] #js []))
                       o))
         "credentialStore" (fn [& _] (life "credentialStore" "close"))
         "runtimeCredentialStore" (fn [& _] #js {})
         "oauthManager" (fn [& _] #js {})
         "createTokenRefreshRuntime" (fn [_]
                                       #js {"tokenRefreshManager" (doto (life "refresh" "stopAndWait")
                                                                    (aset "startBackgroundRefresh" (fn [_] (record "refresh.start"))))
                                            "refreshExpiredOAuthAccount" (fn [] nil)
                                            "refreshFactoryAccount" (fn [] nil)
                                            "ensureFreshAccounts" (fn [] nil)})
         "quotaMonitor" (fn [& _] (doto #js {} (aset "start" (fn [] (record "quota.start"))) (aset "stop" (fn [] (record "quota.stop")))))
         "buildOllamaCatalogRoutes" (fn [_] #js [])
         "getDeclaredProviderRoutes" (fn [_] #js [])
         "providerCatalogStore" (fn [& _]
                                  #js {"getCatalog" (fn [_] (js/Promise.resolve #js {"catalog" #js {"modelIds" #js ["m1" "m2"]}}))})
         "requestLogStore" (fn [& _] (life "requestLog" "warmup" "close"))
         "requestLogSseHub" (fn [_] (life "hub" "close"))
         "promptAffinityStore" (fn [_] (life "affinity" "init" "close"))
         "pheromoneStore" (fn [& _] (life "pheromone" "warmup" "close"))
         "proxySettingsStore" (fn [& _] (doto (life "settings" "warmup")
                                          (aset "getForTenant" (fn [_] (js/Promise.resolve #js {})))))
         "createEnvFederationBridgeAgent" (fn [_] js/undefined)
         "handleBridgeRequest" (fn [& _] nil)
         "injectNativeBridge" (fn [& _] nil)
         "executeFederatedRequestRouting" (fn [& _] nil)
         "modelIdsToNativeTags" (fn [ids] #js {"models" ids})
         "routes" #js {"v1Collaborators" (fn [] #js {})
                       "embeddingsCollaborators" (fn [] #js {})
                       "mediaCollaborators" (fn [] #js {})
                       "registerWebSocketRoutes" (fn [_app _deps] (js/Promise.resolve #js {"bridgeRelay" #js {"listSessions" (fn [] #js [])}}))
                       "registerBridgeSseRoutes" (noop-async nil)
                       "registerRequestLogSseRoutes" (noop-async nil)
                       "registerApiV1Routes" (noop-async nil)
                       "registerObservabilityRoutes" (noop-async nil)}}))

(def ^:private config
  #js {"allowUnauthenticated" true "proxyAuthToken" nil "upstreamProviderId" "vivgrid" "openaiProviderId" "openai"
       "disabledProviderIds" #js [] "keysFilePath" "keys.json" "keyReloadMs" 1 "keyCooldownMs" 1
       "requestLogsFilePath" "data/request-logs.jsonl" "requestLogsMaxEntries" 1 "requestLogsFlushMs" 1
       "settingsFilePath" "data/settings.json" "promptAffinityFlushMs" 1
       "oauthRefreshMaxConcurrency" 1 "oauthRefreshBackgroundIntervalMs" 1 "oauthRefreshProactiveWindowMs" 1
       "githubOAuthCallbackPath" "/auth/github/callback" "cljsPolicyManifestPath" "resources/policies/runtime/00-manifest.edn"
       "requestTimeoutMs" 1000})

(defn- ^:async call [^js app opts]
  (let [res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res) :headers (js->clj (.-headers res)) :text (.-payload res)
     :json (try (js->clj (.json res)) (catch :default _ nil))}))

(deftest ^:async the-application-composes-stores-and-serves-its-own-routes
  (let [calls (atom [])
        ^js app (await (app-main/create-app-js config (fake-host calls)))]
    (try
      (testing "stores are built, warmed and started from the plan"
        (is (= ["keyPool:vivgrid"] (filter #(.startsWith % "keyPool:") @calls)))
        (is (every? (set @calls) ["keyPool.warmup" "requestLog.warmup" "affinity.init" "pheromone.warmup" "settings.warmup"
                                  "refresh.start" "quota.start"])))
      (testing "/health reports through the CLJS route"
        (let [r (await (call app {:method "GET" :url "/health"}))]
          (is (= 200 (:status r)))
          (is (true? (get (:json r) "ok")))))
      (testing "models: the merged catalogue the policy allows"
        (let [r (await (call app {:method "GET" :url "/v1/models"}))]
          (is (= 200 (:status r)))
          (is (= ["m1" "m2"] (map #(get % "id") (get (:json r) "data"))))
          (is (= "list" (get (:json r) "object"))))
        (is (= 200 (:status (await (call app {:method "GET" :url "/v1/models/m1"})))))
        (let [r (await (call app {:method "GET" :url "/v1/models/zzz"}))]
          (is (= 404 (:status r)))
          (is (= "model_not_found" (get (:headers r) "x-open-hax-error-code")))
          (is (= "Model not found: zzz" (get-in (:json r) ["error" "message"])))))
      (testing "native tags and the OpenAPI document"
        (is (= {"models" ["m1" "m2"]} (:json (await (call app {:method "GET" :url "/api/tags"})))))
        (let [r (await (call app {:method "GET" :url "/api/v1/openapi.json"}))]
          (is (= "Proxx API" (get-in (:json r) ["info" "title"]))))
        (is (= 302 (:status (await (call app {:method "GET" :url "/api/docs"})))))
        (is (= "/docs" (get (:headers (await (call app {:method "GET" :url "/api/docs"}))) "location"))))
      (testing "unknown routes answer the shared 404"
        (is (= 404 (:status (await (call app {:method "GET" :url "/nope"}))))))
      (finally
        (await (.close app))))
    (testing "closing stops what was started, background first"
      (is (= ["refresh.stopAndWait" "quota.stop"] (take 2 (filter #{"refresh.stopAndWait" "quota.stop"} @calls))))
      (is (every? (set @calls) ["hub.close" "affinity.close" "pheromone.close" "requestLog.close" "credentialStore.close"])))))
