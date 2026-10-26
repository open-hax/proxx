(ns proxx.http.app-test
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is testing]]
            [proxx.app.wiring :as wiring]
            [proxx.http.app :as app]
            [proxx.runtime.app :as runtime-app]))

(deftest route-classes-are-data
  (is (= {:action :preflight} (app/request-plan "OPTIONS" "/api/v1/me" nil)))
  (is (= {:action :public} (app/request-plan "GET" "/health" nil)))
  (is (= {:action :public} (app/request-plan "GET" "/custom/gh" "/custom/gh")))
  (is (= {:action :authenticate :ui-session? true} (app/request-plan "GET" "/api/v1" nil)))
  (is (= {:action :authenticate :ui-session? true} (app/request-plan "GET" "/auth/zzz" nil)))
  (testing "only the exact public paths are public"
    (is (= :authenticate (:action (app/request-plan "GET" "/health/" nil))))
    (is (= :authenticate (:action (app/request-plan "GET" "//health" nil))))
    (is (= {:action :authenticate :ui-session? false} (app/request-plan "GET" "/v1/models" nil))))
  (is (= "/v1/chat/completions" (app/raw-path "/v1/chat/completions?a=1?b"))))

(deftest cors-echoes-origin
  (is (= "https://o" (get (app/cors-headers "https://o") "Access-Control-Allow-Origin")))
  (is (= "*" (get (app/cors-headers nil) "Access-Control-Allow-Origin")))
  (is (= "" (get (app/cors-headers "") "Access-Control-Allow-Origin"))))

(def ^:private bridge-facts
  {:headers {"x-open-hax-bridge-auth" "internal" "x-open-hax-federation-owner-subject" " owner "}
   :path "/v1/chat/completions" :remote-address "127.0.0.1" :default-tenant-id "default"})

(deftest bridge-internal-auth-pins-the-loopback-trust
  (is (= {"kind" "legacy_admin" "tenantId" "default" "role" "owner" "source" "none" "subject" "owner"}
         (app/bridge-internal-auth bridge-facts)))
  (is (= "t9" (get (app/bridge-internal-auth (assoc-in bridge-facts [:headers "x-open-hax-bridge-tenant-id"] " t9 ")) "tenantId")))
  (testing "every condition is needed"
    (is (nil? (app/bridge-internal-auth (assoc bridge-facts :remote-address "10.0.0.5"))))
    (is (nil? (app/bridge-internal-auth (assoc bridge-facts :path "/api/v1/me"))))
    (is (nil? (app/bridge-internal-auth (assoc-in bridge-facts [:headers "x-open-hax-bridge-auth"] "Internal"))))
    (is (nil? (app/bridge-internal-auth (assoc-in bridge-facts [:headers "x-open-hax-federation-owner-subject"] "  "))))))

(deftest quota
  (is (true? (app/quota-checked? "POST" "/v1/embeddings" {"kind" "legacy_admin"})))
  (is (false? (app/quota-checked? "GET" "/v1/embeddings" {"kind" "legacy_admin"})))
  (is (false? (app/quota-checked? "POST" "/v1/models" {"kind" "legacy_admin"})))
  (is (false? (app/quota-checked? "POST" "/api/chat" {"kind" "legacy_admin"})) "native Ollama routes are not quota-enforced")
  (is (false? (app/quota-checked? "POST" "/v1/embeddings" {"kind" "unauthenticated"})))
  (is (nil? (app/quota-exceeded-response "t" nil 99)))
  (is (nil? (app/quota-exceeded-response "t" 0 99)))
  (is (nil? (app/quota-exceeded-response "t" 5 4)))
  (let [r (app/quota-exceeded-response "t1" 5 5)]
    (is (= 429 (:status r)))
    (is (= {"x-open-hax-error-code" "tenant_quota_exceeded" "retry-after" 60} (:headers r)))
    (is (= "Tenant request quota exceeded for t1. Allowed requests per minute: 5." (get-in r [:body "error" "message"])))
    (is (= "rate_limit_error" (get-in r [:body "error" "type"])))))

(deftest key-touch
  (let [auth {"kind" "tenant_api_key" "tenantId" "t" "keyId" "k"}]
    (is (true? (app/touch-key? auth "POST" "/v1/x" true)))
    (is (false? (app/touch-key? auth "GET" "/v1/x" true)))
    (is (false? (app/touch-key? auth "POST" "/api/v1/x" true)))
    (is (false? (app/touch-key? auth "POST" "/v1/x" false)))
    (is (false? (app/touch-key? (dissoc auth "keyId") "POST" "/v1/x" true)))))

(deftest errors-and-not-found
  (is (= {:status 401 :headers {"x-open-hax-error-code" "unauthorized"}
          :body {"error" {"message" "Unauthorized" "type" "invalid_request_error" "param" nil "code" "unauthorized"}}}
         app/unauthorized-response))
  (let [{:keys [level response]} (app/error-plan {:status 418 :message "m" :type "t" :code ""})]
    (is (= :warn level))
    (is (= "" (get-in response [:body "error" "code"])) "an empty code stays in the body")
    (is (nil? (:headers response)) "but sets no header"))
  (is (= 500 (get-in (app/error-plan nil) [:response :status])))
  (is (str/includes? (get-in (app/not-found-response "GET" "/v1/x") [:body "error" "message"]) "Unsupported endpoint: GET /v1/x. Supported endpoints: POST /v1/chat/completions"))
  (is (= "unsupported_endpoint" (get-in (app/not-found-response "GET" "/api/v1/x") [:body "error" "code"])))
  (is (str/includes? (get-in (app/not-found-response "GET" "/api/x") [:body "error"]) "Supported native endpoints"))
  (is (= {:status 404 :body {"ok" false "error" "Not Found"}} (app/not-found-response "GET" "/zzz"))))

(deftest landing-and-console-url
  (is (= "https://fwd:5174" (app/web-console-url {:forwarded-host "fwd:8080" :host "h" :forwarded-proto "https" :protocol "http" :web-port "5174"})))
  (is (= "http://localhost:9" (app/web-console-url {:host "" :protocol "" :web-port " 9 "})))
  (is (= "http://a b:5174" (app/web-console-url {:host "a b" :protocol "http" :web-port ""}))
      "an unparseable host falls back to its text before the first colon")
  (is (= "http://a:5174" (app/web-console-url {:host "a:99" :protocol "http" :web-port ""})))
  (is (str/includes? (app/landing-page "http://x\"y:1") "href=\"http://x&quot;y:1\"")))

(deftest refresh-and-model-merging
  (let [accounts [{"accountId" "a" "authType" "oauth_bearer" "refreshToken" "r"}
                  {"accountId" "b" "authType" "oauth_bearer" "refreshToken" "  "}
                  {"accountId" "c" "authType" "api_key" "refreshToken" "r"}
                  {"accountId" "d" "authType" "oauth_bearer" "refreshToken" "r"}]]
    (is (= ["a" "d"] (map #(get % "accountId") (app/refresh-candidates accounts nil))))
    (is (= ["d"] (map #(get % "accountId") (app/refresh-candidates accounts " d "))))
    (is (= ["a" "d"] (map #(get % "accountId") (app/refresh-candidates accounts "   ")))))
  (is (= ["m1" "m2"] (app/advertised-model-ids [{"capabilities" [{"models" ["m1" "m2"]} {"models" ["m1"]}]}])))
  (is (= ["a" "b" "c"] (app/merge-model-ids ["a" "b"] ["b" "c"]))))

(deftest wiring-plan
  (let [no-db (wiring/plan {"openaiProviderId" " " "disabledProviderIds" ["factory"]})
        db (wiring/plan {"databaseUrl" "postgres://x" "openaiProviderId" " oa " "oauthRefreshMaxConcurrency" 2
                         "oauthRefreshBackgroundIntervalMs" 5 "oauthRefreshProactiveWindowMs" 9})]
    (is (false? (get no-db "database")))
    (is (= [] (get no-db "storeInit")))
    (is (false? (get no-db "includeFactoryCatalogRoutes")))
    (is (= "openai" (get-in no-db ["quotaMonitor" "providerId"])))
    (is (true? (get db "database")))
    (is (= ["credential" "accountHealth" "event" "requestUsage" "federation" "tenantProviderPolicy" "authPersistence"]
           (map #(get % "id") (get db "storeInit"))))
    (is (= ["federation" "tenantProviderPolicy"] (map #(get % "id") (remove #(get % "required") (get db "storeInit")))))
    (is (= "oa" (get-in db ["quotaMonitor" "providerId"])))
    (is (= {"expiryBufferMs" 60000 "maxConsecutiveFailures" 3 "maxConcurrency" 2 "backgroundIntervalMs" 5 "proactiveRefreshWindowMs" 9}
           (get db "tokenRefresh")))
    (is (true? (get db "includeFactoryCatalogRoutes")))
    (is (false? (get (wiring/plan {"databaseUrl" ""}) "database")))))

;; --- the hooks through a real in-process Fastify -------------------------------

(defn- hooked-app [{:keys [rpm count touched]}]
  (let [app ((js/require "fastify"))
        sql #js {:resolveTenantApiKey (fn [t _] (js/Promise.resolve (when (= t "tk") #js {:id "k1" :tenantId "t1" :scopes #js []})))
                 :touchTenantApiKeyLastUsed (fn [t k] (swap! touched conj [t k]) (js/Promise.resolve nil))}]
    (runtime-app/install-request-hook-js
     app #js {:config #js {:allowUnauthenticated false :proxyAuthToken "fake-token" :proxyTokenPepper "pep" :githubOAuthCallbackPath "/gh"}
              :sqlCredentialStore sql
              :sqlAuthPersistence #js {}
              :proxySettingsStore #js {:getForTenant (fn [_] (js/Promise.resolve #js {:requestsPerMinute rpm}))}
              :requestLogStore #js {:countRequestsSince (fn [_ _] count)}
              :defaultTenantId "default"
              :cookieName "tok"})
    (.get app "/v1/who" (fn [^js req _] #js {:auth (.-openHaxAuth req)}))
    (.post app "/v1/chat/completions" (fn [^js req _] #js {:auth (.-openHaxAuth req)}))
    (.get app "/health" (fn [_ _] "ok"))
    app))

(defn- ^:async call [app opts]
  (let [res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res) :json (try (js->clj (.json res)) (catch :default _ nil))
     :allow-origin (aget (.-headers res) "access-control-allow-origin")
     :retry-after (aget (.-headers res) "retry-after")}))

(deftest ^:async request-hook-decisions
  (let [touched (atom [])
        app (hooked-app {:rpm 2 :count 2 :touched touched})]
    (testing "protected routes need credentials; public ones and preflight do not"
      (is (= 401 (:status (await (call app {:method "GET" :url "/v1/who"})))))
      (is (= 200 (:status (await (call app {:method "GET" :url "/health"})))))
      (is (= "*" (:allow-origin (await (call app {:method "GET" :url "/health"})))))
      (is (= "https://o" (:allow-origin (await (call app {:method "GET" :url "/v1/who" :headers #js {:origin "https://o"}}))))
          "CORS headers are set even on a 401"))
    (testing "the static token is the legacy admin"
      (is (= {"kind" "legacy_admin" "source" "bearer" "tenantId" "default" "role" "owner"}
             (select-keys (get (:json (await (call app {:method "GET" :url "/v1/who" :headers #js {:authorization "Bearer fake-token"}}))) "auth")
                          ["kind" "source" "tenantId" "role"]))))
    (testing "the quota is enforced per tenant on spending routes and answered with 429 + retry-after"
      (let [res (await (call app {:method "POST" :url "/v1/chat/completions" :headers #js {:authorization "Bearer fake-token" :content-type "application/json"} :payload "{}"}))]
        (is (= 429 (:status res)))
        (is (= "60" (:retry-after res)))
        (is (= "tenant_quota_exceeded" (get-in res [:json "error" "code"])))))
    (testing "a tenant key's use is recorded on POSTs under /v1/ only (not when the quota refuses it)"
      (is (= [] @touched)))
    (await (.close app))))

(deftest ^:async hook-key-touch-and-bridge-trust
  (let [touched (atom [])
        app (hooked-app {:rpm nil :count 0 :touched touched})]
    (await (call app {:method "POST" :url "/v1/chat/completions" :headers #js {:authorization "Bearer tk" :content-type "application/json"} :payload "{}"}))
    (await (call app {:method "GET" :url "/v1/who" :headers #js {:authorization "Bearer tk"}}))
    (is (= [["t1" "k1"]] @touched))
    (testing "PINNED: any peer on a loopback address is the bridge, and then the legacy owner"
      (let [headers #js {"x-open-hax-bridge-auth" "internal" "x-open-hax-federation-owner-subject" "o"}]
        (is (= "legacy_admin" (get-in (:json (await (call app {:method "GET" :url "/v1/who" :headers headers :remoteAddress "127.0.0.1"}))) ["auth" "kind"])))
        (is (= 401 (:status (await (call app {:method "GET" :url "/v1/who" :headers headers :remoteAddress "10.1.1.1"})))))))
    (await (.close app))))
