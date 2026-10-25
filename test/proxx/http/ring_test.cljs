(ns proxx.http.ring-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.http.api-v1 :as api-v1]
            [proxx.http.health :as health]
            [proxx.runtime.ring :as http]
            [proxx.runtime.routes :as routes]))

(defn- new-app [] ((js/require "fastify")))

(defn- ^:async call [app opts]
  (let [res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res)
     :headers (js->clj (.-headers res))
     :json (try (js->clj (.json res)) (catch :default _ nil))
     :text (.-payload res)}))

(deftest ^:async handlers-are-data-in-data-out
  (let [app (new-app)]
    (http/register!
     app
     [{:method :get :path "/plain" :handler (fn [_] {:body {"a" 1 "b" [1 2]}})}
      {:method :get :path "/status" :handler (fn [_] {:status 202 :headers {"x-test" "yes"} :body "hello"})}
      {:method :post :path "/echo/:id"
       :handler (fn ^:async echo [{:keys [method path query params headers body]}]
                  (await (js/Promise.resolve nil))
                  ;; read every value through the Clojure maps: echoing the maps whole would
                  ;; pass even if they were unconverted JS objects
                  {:body {"method" (name method) "path" path
                          "x" (get query "x") "y" (get query "y")
                          "id" (get params "id")
                          "ctype" (get headers "content-type")
                          "k" (get body "k") "n" (get body "n")
                          "types" [(map? query) (map? params) (map? headers) (map? body)]}})}
      {:method :get :path "/denied"
       :handler (fn [_] (throw (ex-info "nope" {:http/status 403 :http/headers {"x-reason" "policy"}})))}
      {:method :get :path "/boom" :handler (fn [_] (throw (js/Error. "unexpected")))}
      {:method :get :path "/empty" :handler (fn [_] {:status 204})}])
    (let [plain (await (call app {:method "GET" :url "/plain"}))
          status (await (call app {:method "GET" :url "/status"}))
          echo (await (call app {:method "POST" :url "/echo/42?x=1&y=2" :payload #js {:k "v" :n 3}}))
          denied (await (call app {:method "GET" :url "/denied"}))
          boom (await (call app {:method "GET" :url "/boom"}))
          empty (await (call app {:method "GET" :url "/empty"}))]
      (is (= 200 (:status plain)))
      (is (= {"a" 1 "b" [1 2]} (:json plain)))
      (is (= 202 (:status status)))
      (is (= "yes" (get (:headers status) "x-test")))
      (is (= "hello" (:text status)))
      (is (= {"method" "post" "path" "/echo/42" "x" "1" "y" "2" "id" "42"
              "ctype" "application/json" "k" "v" "n" 3 "types" [true true true true]}
             (:json echo)))
      (is (= 403 (:status denied)))
      (is (= {"error" {"message" "nope"}} (:json denied)))
      (is (= "policy" (get (:headers denied) "x-reason")))
      (is (= 500 (:status boom)) "non-http errors fall through to Fastify's own handling")
      (is (= 204 (:status empty)))
      (is (= "" (:text empty))))
    (await (.close app))))

(defn- status-js [pid total available cooldown next]
  #js {:providerId pid :authType "api_key" :totalAccounts total :availableAccounts available
       :cooldownAccounts cooldown :nextReadyInMs next})

(deftest health-report-shapes
  (is (= {"service" "open-hax-openai-proxy" "authMode" "token" "ok" true
          "keyPool" {"providerId" "p" "authType" "api_key" "totalKeys" 3 "availableKeys" 2 "cooldownKeys" 1 "nextReadyInMs" 0}
          "keyPoolProviders" {"p" {"providerId" "p" "authType" "api_key" "totalAccounts" 3 "availableAccounts" 2
                                   "cooldownAccounts" 1 "nextReadyInMs" 0}}}
         (health/report {:token-configured? true
                         :default-status {:provider-id "p" :auth-type "api_key" :total-accounts 3 :available-accounts 2
                                          :cooldown-accounts 1 :next-ready-in-ms 0}
                         :all-statuses {"p" {:provider-id "p" :auth-type "api_key" :total-accounts 3 :available-accounts 2
                                             :cooldown-accounts 1 :next-ready-in-ms 0}}})))
  (is (= {"service" "open-hax-openai-proxy" "authMode" "unauthenticated" "ok" false
          "keyPool" {"error" "boom"} "keyPoolProviders" {}}
         (health/report {:token-configured? false :error "boom"}))))

(deftest ^:async health-route-end-to-end
  (let [app (new-app)
        pool #js {:getStatus (fn [pid] (js/Promise.resolve (status-js pid 3 2 1 0)))
                  :getAllStatuses (fn [] (js/Promise.resolve #js {:p (status-js "p" 3 2 1 0)}))}]
    (routes/register-health-routes-js app #js {:keyPool pool :upstreamProviderId "p" :proxyAuthTokenConfigured true})
    (let [res (await (call app {:method "GET" :url "/health"}))]
      (is (= 200 (:status res)))
      (is (true? (get-in res [:json "ok"])))
      (is (= "token" (get-in res [:json "authMode"])))
      (is (= 3 (get-in res [:json "keyPool" "totalKeys"])))
      (is (= #{"p"} (set (keys (get-in res [:json "keyPoolProviders"]))))))
    (await (.close app)))
  (let [app (new-app)
        pool #js {:getStatus (fn [_] (js/Promise.reject (js/Error. "pool down")))
                  :getAllStatuses (fn [] (js/Promise.resolve #js {}))}]
    (routes/register-health-routes-js app #js {:keyPool pool :upstreamProviderId "p" :proxyAuthTokenConfigured false})
    (let [res (await (call app {:method "GET" :url "/health"}))]
      (is (= 200 (:status res)) "a failing pool is reported in the body, not as an HTTP error")
      (is (false? (get-in res [:json "ok"])))
      (is (= {"error" "pool down"} (get-in res [:json "keyPool"]))))
    (await (.close app))))

(deftest api-v1-index-counts
  (let [body (api-v1/index)]
    (is (= {"planned" 2 "implemented" 6} (get body "summary")))
    (is (= ["credentials" "federation" "sessions" "settings" "hosts" "events" "observability" "mcp"]
           (vec (keys (get body "endpoints"))))
        "presentation order is part of the contract")))

(deftest ^:async api-v1-index-route
  (let [app (new-app)]
    (routes/register-api-v1-index-route-js app)
    (let [res (await (call app {:method "GET" :url "/api/v1"}))]
      (is (= 200 (:status res)))
      (is (= "1.0.0" (get-in res [:json "version"]))))
    (await (.close app))))
