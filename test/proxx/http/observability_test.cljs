(ns proxx.http.observability-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.observability :as obs]))

(def admin {"kind" "legacy_admin" "tenantId" "default"})
(def session {"kind" "ui_session" "tenantId" "t1" "role" "owner" "memberships" [{"tenantId" "t1" "role" "owner"}]})
(def api-key {"kind" "tenant_api_key" "tenantId" "t1" "keyId" "k1"})

(deftest request-log-scope
  (testing "the admin sees what it asks for"
    (is (= {:tenant-id "t2" :key-id "k"} (obs/request-log-scope admin {"tenantId" " T2 " "keyId" " k "}))))
  (testing "a session defaults to its own tenant and may not look at others"
    (is (= {:tenant-id "t1" :key-id nil} (obs/request-log-scope session {})))
    (is (= 403 (get-in (obs/request-log-scope session {"tenantId" "t2"}) [:response :status]))))
  (testing "a tenant key is pinned to its own key"
    (is (= {:tenant-id "t1" :key-id "k1"} (obs/request-log-scope api-key {})))
    (is (= {:tenant-id "t1" :key-id "k1"} (obs/request-log-scope api-key {"keyId" "k1"})))
    (is (= 403 (get-in (obs/request-log-scope api-key {"keyId" "k2"}) [:response :status])))
    (is (= {:tenant-id "t1" :key-id nil} (obs/request-log-scope (dissoc api-key "keyId") {"keyId" "k2"}))
        "a key without an id overrides the requested key with nothing"))
  (testing "repeated parameters are not strings and are ignored"
    (is (= {:tenant-id "t1" :key-id nil} (obs/request-log-scope session {"tenantId" ["t1" "t2"]})))))

(deftest usage-scope
  (is (= {:scope {:tenantId "t2" :issuer "i"}} (obs/usage-scope admin {"tenantId" "T2" "issuer" " i "})))
  (is (= {:scope {:tenantId "t1"}} (obs/usage-scope session {})))
  (is (= 403 (get-in (obs/usage-scope session {"tenantId" "t9"}) [:response :status])))
  (is (= {:scope {:tenantId "t1" :keyId "k1"}} (obs/usage-scope api-key {"keyId" " k1 "})))
  (is (= 403 (get-in (obs/usage-scope api-key {"keyId" "other"}) [:response :status])))
  (testing "an empty tenant id on the caller is carried as given, not dropped"
    (is (= {:scope {:tenantId ""}} (obs/usage-scope {"kind" "ui_session" "tenantId" ""} {})))))

(deftest filters
  (is (= {:limit 200} (obs/request-log-filters {} {})))
  (is (= {:providerId "p" :tenantId "t" :keyId "k" :issuer "i" :limit 2000 :before "b"}
         (obs/request-log-filters {"providerId" "p" "issuer" " i " "limit" "99999" "before" "b"}
                                  {:tenant-id "t" :key-id "k"})))
  (is (= 200 (:limit (obs/request-log-filters {"limit" "abc"} {}))))
  (is (not (contains? (obs/request-log-filters {"before" ""} {}) :before))))

(deftest tools-and-sources
  (is (= "gpt-5.3-codex" (obs/tool-model {})))
  (is (= "gpt-5.3-codex" (obs/tool-model {"model" "  "})))
  (is (= "m" (obs/tool-model {"model" " m "})))
  (is (= :sql (obs/overview-source {:sql? true :scoped? true})))
  (is (= :scoped (obs/overview-source {:scoped? true})))
  (is (= :entries (obs/overview-source {:log-count 3})))
  (is (= :rollups (obs/overview-source {:log-count 3 :persisted-rollups? true})))
  (is (= :rollups (obs/overview-source {:log-count 0})))
  (is (= :entries (obs/analytics-source {:log-count 1})))
  (is (= :rollups (obs/analytics-source {:log-count 0})))
  (is (obs/mcp-seed-cache-fresh? 0 29999))
  (is (not (obs/mcp-seed-cache-fresh? 0 30000)))
  (is (not (obs/mcp-seed-cache-fresh? nil 1))))
