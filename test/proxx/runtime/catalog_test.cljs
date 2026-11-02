(ns proxx.runtime.catalog-test
  "Ported from src/tests/provider-catalog.test.ts (4 tests): the catalog store
  against real in-process HTTP servers. The TS ProviderCatalogStore was a shim
  over proxx.runtime.catalog with the TS http helpers handed in; the CLJS
  equivalents of those helpers are handed in here. The config is the real
  loadConfig output with the same overrides the TS literal applied."
  (:require ["node:fs" :as fs]
            ["node:http" :as http]
            ["node:os" :as os]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [proxx.http.url :as url]
            [proxx.runtime.catalog :as catalog]
            [proxx.runtime.config :as config]
            [proxx.runtime.http :as http-edge]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(def ^:private deps
  #js {:fetchWithResponseTimeout (fn [u init timeout-ms] (http-edge/fetch-with-response-timeout-js u init timeout-ms))
       :joinUrl (fn [base p] (url/join-url base p))})

(defn- build-config ^js [overrides]
  (js/Object.assign
   (config/load-config-js #js {"PROXY_AUTH_TOKEN" "test-token" "PROXY_ALLOW_UNAUTHENTICATED" "true"
                               "PROXY_TOKEN_PEPPER" "test-pepper"}
                          (js/process.cwd) manifest)
   overrides))

(defn- mock-key-pool [accounts-by-provider]
  #js {:getAllAccounts (fn [provider-id] (js/Promise.resolve (to-array (get accounts-by-provider provider-id []))))})

(defn- test-account
  ([provider-id] (test-account provider-id "test-token"))
  ([provider-id token] #js {:providerId provider-id :accountId (str provider-id "-account-1") :token token :authType "api_key"}))

(defn- write-models-file! []
  (let [dir (.mkdtempSync fs (path/join (.tmpdir os) "catalog-test-"))
        file (path/join dir "models.json")]
    (.writeFileSync fs file (js/JSON.stringify #js {:models #js []}) "utf8")
    {:dir dir :file file}))

(defn- listen [handler]
  (js/Promise.
   (fn [resolve _]
     (let [server (.createServer http handler)]
       (.listen server 0 "127.0.0.1" (fn [] (resolve server)))))))

(defn- port [^js server] (.-port (.address server)))
(defn- base-url [server] (str "http://127.0.0.1:" (port server)))

(defn- hang-forever [_req ^js res]
  (.writeHead res 200 #js {"content-type" "application/json"})
  (.write res "[")) ; never finish: the connection stays open

(defn- stop [^js server]
  (js/Promise. (fn [resolve _] (.closeAllConnections server) (.close server (fn [_] (resolve nil))))))

(defn- with-route-timeout-ms
  "Run the thunk (returning a promise) with the per-route catalog timeout set."
  [timeout-ms f]
  (let [env (.-env js/process)
        key "PROXY_PROVIDER_CATALOG_ROUTE_TIMEOUT_MS"
        previous (aget env key)]
    (aset env key (str timeout-ms))
    (-> (f)
        (.finally (fn [] (if (undefined? previous) (js-delete env key) (aset env key previous)))))))

(defn- cleanup! [{:keys [dir]}] (.rmSync fs dir #js {:recursive true :force true}))

(defn- store [^js config pool routes ollama-routes]
  (catalog/create-provider-catalog-store-js manifest config pool (to-array routes) (to-array ollama-routes) deps))

(defn- get-catalog [^js s force] (.getCatalog s force))

(deftest ^:async get-catalog-completes-within-timeout-when-a-route-endpoint-is-unresponsive
  ;; Regression: a dead federation peer caused getCatalog() to block all chat and
  ;; responses requests for ~38 minutes (45s per-account timeout x 51 accounts).
  (let [tmp (write-models-file!)
        hanging (await (listen hang-forever))
        responsive (await (listen (fn [^js req ^js res]
                                    (if (= "/v1/models" (.-url req))
                                      (do (.writeHead res 200 #js {"content-type" "application/json"})
                                          (.end res (js/JSON.stringify #js {:data #js [#js {:id "responsive-model"}]})))
                                      (do (.writeHead res 404) (.end res))))))]
    (try
      (let [accounts {"hanging-provider" [(test-account "hanging-provider")]
                      "responsive-provider" [(test-account "responsive-provider")]}
            cfg (build-config #js {:modelsFilePath (:file tmp) :requestTimeoutMs 5000})
            routes [#js {:providerId "hanging-provider" :baseUrl (base-url hanging)}
                    #js {:providerId "responsive-provider" :baseUrl (base-url responsive)}]]
        (await
         (with-route-timeout-ms
           200
           (fn []
             (let [s (store cfg (mock-key-pool accounts) routes [])
                   start (js/Date.now)]
               (.then (get-catalog s true)
                      (fn [^js result]
                        (let [elapsed (- (js/Date.now) start)
                              provider-catalogs (.-providerCatalogs result)]
                          (is (< elapsed 2000) (str "getCatalog should complete within 2s despite hanging route, took " elapsed "ms"))
                          (is (some? (aget provider-catalogs "responsive-provider")) "responsive provider should appear in catalog")
                          (is (= ["responsive-model"] (vec (.-modelIds ^js (aget provider-catalogs "responsive-provider")))))
                          (is (nil? (aget provider-catalogs "hanging-provider")) "hanging provider should NOT appear in catalog")))))))))
      (finally
        (await (stop hanging))
        (await (stop responsive))
        (cleanup! tmp)))))

(deftest ^:async get-catalog-returns-empty-catalog-when-all-routes-time-out
  (let [tmp (write-models-file!)
        slow (await (listen hang-forever))]
    (try
      (let [accounts {"slow-provider" [(test-account "slow-provider")]}
            cfg (build-config #js {:modelsFilePath (:file tmp) :requestTimeoutMs 5000})]
        (await
         (with-route-timeout-ms
           200
           (fn []
             (let [s (store cfg (mock-key-pool accounts) [#js {:providerId "slow-provider" :baseUrl (base-url slow)}] [])
                   start (js/Date.now)]
               (.then (get-catalog s true)
                      (fn [^js result]
                        (let [elapsed (- (js/Date.now) start)]
                          (is (< elapsed 2000) (str "getCatalog should complete within 2s even when all routes hang, took " elapsed "ms"))
                          (is (nil? (aget (.-providerCatalogs result) "slow-provider")) "slow provider should NOT appear in catalog")
                          (is (= 0 (.. result -catalog -modelIds -length)) "catalog should have no discovered models")))))))))
      (finally
        (await (stop slow))
        (cleanup! tmp)))))

(deftest ^:async get-catalog-discovers-local-ollama-models-via-api-tags-without-key-pool-accounts
  (let [tmp (write-models-file!)
        ollama (await (listen (fn [^js req ^js res]
                                (if (= "/api/tags" (.-url req))
                                  (do (.writeHead res 200 #js {"content-type" "application/json"})
                                      (.end res (js/JSON.stringify #js {:models #js [#js {:name "gemma4:latest"}
                                                                                     #js {:name "gemma4:e4b"}
                                                                                     #js {:name "gemma4:31b"}]})))
                                  (do (.writeHead res 404) (.end res))))))]
    (try
      (let [cfg (build-config #js {:modelsFilePath (:file tmp) :ollamaBaseUrl (base-url ollama) :requestTimeoutMs 5000})
            s (store cfg (mock-key-pool {}) [] [#js {:providerId "ollama-local" :baseUrl (base-url ollama)}])
            ^js result (await (get-catalog s true))
            ^js entry (aget (.-providerCatalogs result) "ollama-local")
            ^js resolved (.-catalog result)]
        (is (some? entry) "local ollama provider should appear in catalog")
        (is (= ["gemma4:latest" "gemma4:e4b" "gemma4:31b"] (vec (.-modelIds entry))))
        (is (= "gemma4:31b" (aget (.-aliasTargets resolved) "gemma4:latest"))
            "latest-tag aliases should resolve to the largest concrete ollama variant")
        (is (.includes (.-modelIds resolved) "gemma4:latest")
            "resolved model ids may retain latest-tag aliases internally for request compatibility")
        (is (.includes (.-modelIds resolved) "gemma4:31b") "resolved model ids should include local ollama tag gemma4:31b")
        (is (.includes (.-dynamicOllamaModelIds resolved) "gemma4:31b")
            "dynamic ollama model ids should include concrete local tag"))
      (finally
        (await (stop ollama))
        (cleanup! tmp)))))

(deftest ^:async rotussy-catalog-discovery-falls-back-to-v1-models-when-models-is-unsupported
  (let [tmp (write-models-file!)
        server (await (listen (fn [^js req ^js res]
                                (case (.-url req)
                                  "/v1/models" (do (.writeHead res 200 #js {"content-type" "application/json"})
                                                   (.end res (js/JSON.stringify #js {:data #js [#js {:id "glm-4.7-flash"}]})))
                                  "/models" (do (.writeHead res 404 #js {"content-type" "application/json"})
                                                (.end res (js/JSON.stringify #js {:error "unsupported"})))
                                  (do (.writeHead res 404) (.end res))))))]
    (try
      (let [cfg (build-config #js {:modelsFilePath (:file tmp) :requestTimeoutMs 5000})
            s (store cfg (mock-key-pool {"rotussy" [(test-account "rotussy" "rotussy-test-token")]})
                     [#js {:providerId "rotussy" :baseUrl (base-url server)}] [])
            ^js result (await (get-catalog s true))
            ^js entry (aget (.-providerCatalogs result) "rotussy")]
        (is (= ["glm-4.7-flash"] (vec (if entry (.-modelIds entry) [])))))
      (finally
        (await (stop server))
        (cleanup! tmp)))))
