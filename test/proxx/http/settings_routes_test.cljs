(ns proxx.http.settings-routes-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.settings :as settings]
            [proxx.runtime.routes.settings :as routes]
            [proxx.runtime.ring :as ring]))

(def admin #js {:kind "legacy_admin" :source "bearer" :tenantId "default" :role "owner"})
(def session #js {:kind "ui_session" :role "owner" :tenantId "t1" :subject "sub-1"
                  :memberships #js [#js {:tenantId "t1" :role "owner" :tenantName "One"}
                                    #js {:tenantId "t2" :role "viewer"}]})
(def key-auth #js {:kind "tenant_api_key" :tenantId "t3"})

(defn- app-with-auth [auth deps]
  (let [app ((js/require "fastify"))]
    (.addHook app "onRequest" (fn [^js req _ done] (when auth (set! (.-openHaxAuth req) auth)) (done)))
    (routes/register-settings-routes-js app deps "/api/v1")
    app))

(defn- ^:async call [app opts]
  (let [res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res) :json (try (js->clj (.json res)) (catch :default _ nil))}))

(defn- store-deps [calls]
  #js {:proxySettingsStore #js {:getForTenant (fn [t] (swap! calls conj [:get t]) (js/Promise.resolve #js {:fastMode false :tenant t}))
                                :setForTenant (fn [patch t] (swap! calls conj [:set (js->clj patch) t])
                                                (js/Promise.resolve (js/Object.assign #js {:fastMode false} patch)))}
       :sqlCredentialStore #js {:listTenants (fn [] (js/Promise.resolve #js [#js {:id "x" :name "X" :status "active"}]))
                                :listTenantApiKeys (fn [t] (js/Promise.resolve #js [#js {:id "k1" :tenant t}]))
                                :createTenantApiKey (fn [t label scopes pepper] (swap! calls conj [:create t label (js->clj scopes) pepper])
                                                      (js/Promise.resolve #js {:id "new" :label label}))
                                :revokeTenantApiKey (fn [_ key-id] (js/Promise.resolve (= key-id "k1")))}
       :proxyTokenPepper "pepper"
       :log #js {:info (fn [& args] (swap! calls conj [:log (count args)]))}})

(deftest settings-update-decisions
  (is (= {:response {:status 401 :body {"error" "unauthorized"}}} (settings/settings-update nil {})))
  (is (= 403 (get-in (settings/settings-update {"kind" "tenant_api_key"} {}) [:response :status])))
  (is (= 403 (get-in (settings/settings-update {"kind" "ui_session" "role" "viewer"} {}) [:response :status])))
  (is (= {:tenant-id "t1" :patch {}} (settings/settings-update {"kind" "ui_session" "role" "admin" "tenantId" "t1"} nil)))
  (testing "absent fields are omitted, null is kept, invalid is a 400 naming the field"
    (is (= {:tenant-id "default" :patch {"requestsPerMinute" nil "allowedModels" ["a"] "fastMode" true}}
           (settings/settings-update {"kind" "legacy_admin"} {"requestsPerMinute" nil "allowedModels" [" A "] "fastMode" "yes"})))
    (is (= {:status 400 :body {"error" "invalid_requests_per_minute"}}
           (:response (settings/settings-update {"kind" "legacy_admin"} {"requestsPerMinute" "abc" "allowedModels" "bad"}))))
    (is (= "invalid_allowed_models" (get-in (settings/settings-update {"kind" "legacy_admin"} {"allowedModels" "bad"}) [:response :body "error"])))
    (is (= "invalid_disabled_provider_ids" (get-in (settings/settings-update {"kind" "legacy_admin"} {"disabledProviderIds" 5}) [:response :body "error"])))))

(deftest api-key-spec
  (is (= {:label "ci" :scopes ["proxy:use"]} (settings/new-api-key-spec {"label" " ci "})))
  (is (= {:label "ci" :scopes ["a"]} (settings/new-api-key-spec {"label" "ci" "scopes" ["a" 1]})))
  (is (= {:error "label_required"} (settings/new-api-key-spec {"label" "  "})))
  (is (= {:error "label_required"} (settings/new-api-key-spec nil))))

(deftest ^:async settings-read-and-write
  (let [calls (atom [])
        anon (app-with-auth nil (store-deps calls))
        app (app-with-auth admin (store-deps calls))]
    (is (= {:status 401 :json {"error" "unauthorized"}} (await (call anon {:method "GET" :url "/api/v1/settings"}))))
    (is (= {"fastMode" false "tenant" "default"} (:json (await (call app {:method "GET" :url "/api/v1/settings"})))))
    (let [res (await (call app {:method "POST" :url "/api/v1/settings" :payload #js {:fastMode "on" :requestsPerMinute 30}}))]
      (is (= 200 (:status res)))
      (is (= true (get-in res [:json "fastMode"])))
      (is (= 30 (get-in res [:json "requestsPerMinute"]))))
    (is (some #{[:set {"requestsPerMinute" 30 "fastMode" true} "default"]} @calls))
    (is (some #(= :log (first %)) @calls))
    (is (= 400 (:status (await (call app {:method "POST" :url "/api/v1/settings" :payload #js {:requestsPerMinute "nope"}})))))
    (await (.close anon)) (await (.close app))))

(deftest ^:async me-and-tenants
  (let [calls (atom [])
        app (app-with-auth admin (store-deps calls))
        sess (app-with-auth session (store-deps calls))]
    (let [me (:json (await (call app {:method "GET" :url "/api/v1/me"})))]
      (is (= "default" (get me "activeTenantId")))
      (is (= [{"id" "x" "name" "X" "status" "active"}] (get me "tenants"))))
    (is (= {"tenants" [{"id" "x" "name" "X" "status" "active"}]} (:json (await (call app {:method "GET" :url "/api/v1/tenants"})))))
    (let [me (:json (await (call sess {:method "GET" :url "/api/v1/me"})))]
      (is (= [{"id" "t1" "name" "One" "status" "active"} {"id" "t2" "name" "t2" "status" "active"}] (get me "tenants")))
      (is (= 2 (count (get me "memberships")))))
    (let [no-store (app-with-auth session #js {:proxySettingsStore #js {}})]
      (is (= {:status 501 :json {"error" "tenant_store_not_supported"}} (await (call no-store {:method "GET" :url "/api/v1/tenants"}))))
      (is (= [] (get (:json (await (call no-store {:method "GET" :url "/api/v1/me"}))) "tenants")) "/me tolerates a missing store")
      (await (.close no-store)))
    (await (.close app)) (await (.close sess))))

(deftest ^:async tenant-api-keys
  (let [calls (atom [])
        sess (app-with-auth session (store-deps calls))
        k (app-with-auth key-auth (store-deps calls))]
    (is (= {"tenantId" "t1" "keys" [{"id" "k1" "tenant" "t1"}]} (:json (await (call sess {:method "GET" :url "/api/v1/tenants/t1/api-keys"})))))
    (is (= 403 (:status (await (call sess {:method "GET" :url "/api/v1/tenants/t2/api-keys"})))) "a viewer membership cannot manage keys")
    (is (= 403 (:status (await (call k {:method "GET" :url "/api/v1/tenants/t3/api-keys"})))))
    (let [res (await (call sess {:method "POST" :url "/api/v1/tenants/t1/api-keys" :payload #js {:label " ci " :scopes #js ["a" 1]}}))]
      (is (= 201 (:status res)))
      (is (= {"id" "new" "label" "ci"} (:json res))))
    (is (some #{[:create "t1" "ci" ["a"] "pepper"]} @calls))
    (is (= {:status 400 :json {"error" "label_required"}} (await (call sess {:method "POST" :url "/api/v1/tenants/t1/api-keys" :payload #js {}}))))
    (is (= {"ok" true "tenantId" "t1" "keyId" "k1"} (:json (await (call sess {:method "DELETE" :url "/api/v1/tenants/t1/api-keys/k1"})))))
    (is (= {:status 404 :json {"error" "tenant_api_key_not_found"}} (await (call sess {:method "DELETE" :url "/api/v1/tenants/t1/api-keys/nope"}))))
    (await (.close sess)) (await (.close k))))

(deftest ^:async select-tenant
  (let [updates (atom [])
        persistence #js {:getAccessToken (fn [t] (js/Promise.resolve (when (= t "good") #js {:subject "sub-1" :extra #js {:a 1}})))
                         :getRefreshToken (fn [t] (js/Promise.resolve (when (= t "r-good") #js {:subject "sub-1"})))
                         :updateAccessTokenExtra (fn [t extra] (swap! updates conj [:access t (js->clj extra)]) (js/Promise.resolve))
                         :updateRefreshTokenExtra (fn [t extra] (swap! updates conj [:refresh t (js->clj extra)]) (js/Promise.resolve))}
        sess (app-with-auth session #js {:authPersistence persistence})
        admin-app (app-with-auth admin #js {:authPersistence persistence})
        no-persist (app-with-auth session #js {})
        url "/api/v1/tenants/T2/select"]
    (is (= {:status 501 :json {"error" "auth_persistence_not_supported"}} (await (call no-persist {:method "POST" :url url}))))
    (is (= {:status 400 :json {"error" "ui_session_required"}} (await (call admin-app {:method "POST" :url url}))))
    (is (= {:status 403 :json {"error" "forbidden"}} (await (call sess {:method "POST" :url "/api/v1/tenants/other/select" :headers #js {:cookie "proxy_auth=good"}}))))
    (is (= {:status 401 :json {"error" "session_cookie_missing"}} (await (call sess {:method "POST" :url url}))))
    (is (= {:status 401 :json {"error" "invalid_session"}} (await (call sess {:method "POST" :url url :headers #js {:cookie "proxy_auth=bad"}}))))
    (let [res (await (call sess {:method "POST" :url url :headers #js {:cookie "proxy_auth=good; proxy_refresh=r-good"}}))]
      (is (= {:status 200 :json {"ok" true "activeTenantId" "t2"}} res)))
    (is (= [[:access "good" {"a" 1 "activeTenantId" "t2"}] [:refresh "r-good" {"activeTenantId" "t2"}]] @updates))
    (doseq [a [sess admin-app no-persist]] (await (.close a)))))
