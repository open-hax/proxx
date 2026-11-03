(ns proxx.proxy.control-plane-test
  "Canonical /api/v1 control-plane surfaces served by the proxy: observability, tools, host
   dashboard, events and federation (missing-store behaviour). Ported from src/tests/proxy.test.ts."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-d :as h :refer [with-proxy-app with-env]]))

(defn- json-ok [body] {:status 200 :headers {"content-type" "application/json"} :body (h/json-str body)})

(defn- base-opts [extra]
  (merge {:keys ["key-a"] :upstream-handler (fn [_ _] (json-ok {"ok" true}))} extra))

(def ^:private ui-auth {"authorization" "Bearer ui-token"})

(defn- ui-opts [] (base-opts {:proxy-auth-token "ui-token"}))

(defn- ui-get [app url] (h/inject app {:method "GET" :url url :headers ui-auth}))

(defn- ui-send [app method url payload]
  (h/inject app {:method method :url url :headers (assoc ui-auth "content-type" "application/json") :payload payload}))

(deftest ^:async api-v1-request-logs-dashboard-overview-and-analytics-provider-model-work-on-the-canonical-observability-surface
  (let [now (js/Date.now)]
    (await
     (with-proxy-app
       (base-opts
        {:request-logs-payload
         {"entries" [{"id" "entry-1" "timestamp" (- now 30000) "providerId" "openai" "accountId" "acct-1"
                      "authType" "oauth_bearer" "model" "gpt-5.4" "upstreamMode" "responses"
                      "upstreamPath" "/v1/responses" "status" 200 "latencyMs" 120 "promptTokens" 70
                      "completionTokens" 30 "totalTokens" 100 "costUsd" 0.1 "energyJoules" 10
                      "waterEvaporatedMl" 0.005}]
          "hourlyBuckets" [] "dailyBuckets" [] "dailyModelBuckets" [] "dailyAccountBuckets" []
          "accountAccumulators" []}})
       (fn ^:async run [{:keys [app]}]
        (let [logs (await (h/inject app {:method "GET" :url "/api/v1/request-logs?limit=1"}))
              overview (await (h/inject app {:method "GET" :url "/api/v1/dashboard/overview?window=daily"}))
              analytics (await (h/inject app {:method "GET" :url "/api/v1/analytics/provider-model?window=daily"}))]
          (is (= 200 (:status logs)))
          (is (map? (:json logs)))
          (is (vector? (get (:json logs) "entries")))
          (is (map? (get-in (:json logs) ["entries" 0])))
          (is (= "openai" (get-in (:json logs) ["entries" 0 "providerId"])))
          (is (= 200 (:status overview)))
          (is (map? (:json overview)))
          (is (map? (get (:json overview) "summary")))
          (is (= 100 (get-in (:json overview) ["summary" "tokens24h"])))
          (is (= "openai" (get-in (:json overview) ["summary" "topProvider"])))
          (is (= 200 (:status analytics)))
          (is (map? (:json analytics)))
          (is (vector? (get (:json analytics) "models")))
          (is (map? (get-in (:json analytics) ["models" 0])))
          (is (= "gpt-5.4" (get-in (:json analytics) ["models" 0 "model"])))))))))

(deftest ^:async api-v1-tools-returns-seeded-tools-for-the-requested-model
  (await
   (with-proxy-app
     (base-opts {})
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/api/v1/tools?model=gpt-5.3-codex"}))]
        (is (= 200 (:status r)))
        (is (map? (:json r)))
        (is (= "gpt-5.3-codex" (get (:json r) "model")))
        (is (vector? (get (:json r) "tools")))
        (is (pos? (count (get (:json r) "tools")))))))))

(deftest ^:async api-v1-hosts-self-and-hosts-overview-work-on-the-canonical-host-dashboard-surface
  (await
   (with-env {"HOST_DASHBOARD_TARGETS_JSON" (h/json-str [{"id" "local" "label" "Local host"}])
              "HOST_DASHBOARD_SELF_ID" "local"}
     (fn ^:async run []
      (await
       (with-proxy-app
         (ui-opts)
         (fn ^:async run [{:keys [app]}]
          (let [self (await (ui-get app "/api/v1/hosts/self"))
                overview (await (ui-get app "/api/v1/hosts/overview"))
                hosts (get (:json overview) "hosts")]
            (is (= 200 (:status self)))
            (is (map? (:json self)))
            (is (= "local" (get (:json self) "id")))
            (is (= "Local host" (get (:json self) "label")))
            (is (vector? (get (:json self) "errors")))
            (is (= 200 (:status overview)))
            (is (map? (:json overview)))
            (is (= "local" (get (:json overview) "selfTargetId")))
            (is (vector? hosts))
            (is (= 1 (count hosts)))
            (is (map? (first hosts)))
            (is (= "local" (get (first hosts) "id")))))))))))

(deftest ^:async api-v1-events-routes-are-wired-and-report-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [listed (await (ui-get app "/api/v1/events"))
            tags (await (ui-get app "/api/v1/events/tags"))
            added (await (ui-send app "POST" "/api/v1/events/example/tag" {"tag" "needs-review"}))
            removed (await (ui-send app "DELETE" "/api/v1/events/example/tag" {"tag" "needs-review"}))]
        (is (= 503 (:status listed)))
        (is (re-find #"(?i)Event store not available" (:body listed)))
        (is (= 503 (:status tags)))
        (is (= 503 (:status added)))
        (is (= 503 (:status removed))))))))

;; -------------------------------------------------------------- federation

(def ^:private federation-self-env
  {"FEDERATION_SELF_NODE_ID" "node-1" "FEDERATION_SELF_GROUP_ID" "group-1"
   "FEDERATION_SELF_CLUSTER_ID" "cluster-1" "FEDERATION_SELF_PEER_DID" "did:web:proxy.example"
   "FEDERATION_SELF_PUBLIC_BASE_URL" "https://proxy.example"})

(defn- ^:async check-federation-self []
  (await
   (with-env federation-self-env
     (fn ^:async run []
      (await
       (with-proxy-app
         (ui-opts)
         (fn ^:async run [{:keys [app]}]
          (let [r (await (ui-get app "/api/v1/federation/self"))
                p (:json r)]
            (is (= 200 (:status r)))
            (is (map? p))
            (is (= "node-1" (get p "nodeId")))
            (is (= "group-1" (get p "groupId")))
            (is (= "cluster-1" (get p "clusterId")))
            (is (= "did:web:proxy.example" (get p "peerDid")))
            (is (= "https://proxy.example" (get p "publicBaseUrl")))
            (is (= 0 (get p "peerCount")))))))))))

(deftest ^:async federation-self-route-stays-wired-after-extraction-from-ui-routes-monolith
  (await (check-federation-self)))

(deftest ^:async api-v1-federation-self-exposes-canonical-federation-self-metadata
  (await (check-federation-self)))

(def ^:private peer-body {"ownerCredential" "did:web:owner.example" "label" "Peer 1" "baseUrl" "https://peer.example"})

(deftest ^:async federation-peer-routes-stay-wired-after-extraction-and-report-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [listed (await (ui-get app "/api/v1/federation/peers?ownerSubject=owner-1"))
            created (await (ui-send app "POST" "/api/v1/federation/peers" peer-body))]
        (is (= 503 (:status listed)))
        (is (map? (:json listed)))
        (is (= "federation_store_not_supported" (get (:json listed) "error")))
        (is (= 503 (:status created)))
        (is (map? (:json created)))
        (is (= "federation_store_not_supported" (get (:json created) "error"))))))))

(deftest ^:async api-v1-federation-peer-and-account-routes-stay-wired-and-report-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [listed (await (ui-get app "/api/v1/federation/peers?ownerSubject=owner-1"))
            created (await (ui-send app "POST" "/api/v1/federation/peers" peer-body))
            accounts (await (ui-get app "/api/v1/federation/accounts?ownerSubject=owner-1"))]
        (is (= 503 (:status listed)))
        (is (map? (:json listed)))
        (is (= "federation_store_not_supported" (get (:json listed) "error")))
        (is (= 503 (:status created)))
        (is (= 503 (:status accounts)))
        (is (map? (:json accounts)))
        (is (= "federation_store_not_supported" (get (:json accounts) "error"))))))))

(deftest ^:async api-v1-federation-bridges-lists-canonical-bridge-sessions
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [r (await (ui-get app "/api/v1/federation/bridges"))]
        (is (= 200 (:status r)))
        (is (map? (:json r)))
        (is (vector? (get (:json r) "sessions")))
        (is (= 0 (count (get (:json r) "sessions")))))))))

(deftest ^:async federation-diff-events-route-stays-wired-after-extraction-and-reports-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [r (await (ui-get app "/api/v1/federation/diff-events?ownerSubject=owner-1&afterSeq=5&limit=2"))]
        (is (= 503 (:status r)))
        (is (map? (:json r)))
        (is (= "federation_store_not_supported" (get (:json r) "error"))))))))

(deftest ^:async federation-accounts-route-stays-wired-after-extraction-and-reports-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [r (await (ui-get app "/api/v1/federation/accounts?ownerSubject=owner-1"))]
        (is (= 503 (:status r)))
        (is (map? (:json r)))
        (is (= "federation_store_not_supported" (get (:json r) "error"))))))))

(deftest ^:async federation-projected-account-import-route-stays-wired-after-extraction-and-reports-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [r (await (ui-send app "POST" "/api/v1/federation/projected-accounts/import"
                              {"accounts" [{"sourcePeerId" "peer-1" "ownerSubject" "did:plc:owner-1"
                                            "providerId" "openai" "accountId" "acct-1"}]}))]
        (is (= 503 (:status r)))
        (is (map? (:json r)))
        (is (= "federation_store_not_supported" (get (:json r) "error"))))))))

(deftest ^:async federation-projected-account-imported-route-stays-wired-after-extraction-and-reports-missing-store-cleanly
  (await
   (with-proxy-app
     (ui-opts)
     (fn ^:async run [{:keys [app]}]
      (let [r (await (ui-send app "POST" "/api/v1/federation/projected-accounts/imported"
                              {"sourcePeerId" "peer-1" "providerId" "openai" "accountId" "acct-1"}))]
        (is (= 503 (:status r)))
        (is (map? (:json r)))
        (is (= "federation_store_not_supported" (get (:json r) "error"))))))))
