(ns proxx.http.ui-auth-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.ui-auth :as a]))

(deftest boolean-parsing
  (doseq [v [true "1" "TRUE" " yes " "On"]] (is (true? (a/parse-boolean v)) (pr-str v)))
  (doseq [v [false "0" "no" "" nil 1 "truthy" {}]] (is (false? (a/parse-boolean v)) (pr-str v))))

(deftest requests-per-minute
  (is (= ::a/absent (a/parse-optional-requests-per-minute ::a/absent)))
  (is (nil? (a/parse-optional-requests-per-minute nil)) "null means no limit")
  (is (= 60 (a/parse-optional-requests-per-minute 60.9)))
  (is (nil? (a/parse-optional-requests-per-minute 0)))
  (is (nil? (a/parse-optional-requests-per-minute -5)))
  (doseq [w ["" "  " "null" "NONE" "off"]] (is (nil? (a/parse-optional-requests-per-minute w)) w))
  (is (= 30 (a/parse-optional-requests-per-minute " 30rpm ")) "parseInt-style leading integer")
  (is (= ::a/absent (a/parse-optional-requests-per-minute "abc")))
  (is (= ::a/absent (a/parse-optional-requests-per-minute "-3")))
  (is (= ::a/absent (a/parse-optional-requests-per-minute true))))

(deftest id-lists
  (is (= ["a" "b"] (a/parse-optional-provider-ids [" A " "b" "a" 5 ""])))
  (is (nil? (a/parse-optional-provider-ids ["", 3])))
  (is (nil? (a/parse-optional-model-ids nil)))
  (is (= ::a/absent (a/parse-optional-model-ids ::a/absent)))
  (is (= ::a/absent (a/parse-optional-model-ids "a,b"))))

(deftest positive-integers
  (is (= 4 (a/parse-optional-positive-integer 4.7)))
  (is (= 12 (a/parse-optional-positive-integer " 12 ")))
  (doseq [v [nil "" 0 -1 "0" "x" true]] (is (nil? (a/parse-optional-positive-integer v)) (pr-str v))))

(def admin {"kind" "legacy_admin"})
(def owner-session {"kind" "ui_session" "role" "owner" "tenantId" "t1"
                    "memberships" [{"tenantId" "t1" "role" "owner" "tenantName" "One"}
                                   {"tenantId" "t2" "role" "viewer" "tenantStatus" "suspended"}]})
(def key-auth {"kind" "tenant_api_key" "tenantId" "t3"})

(deftest authorization
  (testing "no identity is always denied"
    (is (not (a/can-view-tenant? nil "t1")))
    (is (not (a/can-manage-tenant-keys? nil "t1")))
    (is (not (a/can-manage-federation? nil))))
  (testing "legacy admin can do everything"
    (is (a/can-view-tenant? admin "anything"))
    (is (a/can-manage-tenant-keys? admin "anything"))
    (is (a/can-manage-federation? admin)))
  (testing "membership and own-tenant visibility, with normalized ids"
    (is (a/can-view-tenant? owner-session " T2 "))
    (is (a/can-view-tenant? key-auth "T3") "a key sees its own tenant")
    (is (not (a/can-view-tenant? key-auth "t1"))))
  (testing "key management needs an owner/admin membership"
    (is (a/can-manage-tenant-keys? owner-session "t1"))
    (is (not (a/can-manage-tenant-keys? owner-session "t2")))
    (is (not (a/can-manage-tenant-keys? key-auth "t3"))))
  (testing "federation management"
    (is (a/can-manage-federation? owner-session))
    (is (not (a/can-manage-federation? (assoc owner-session "role" "viewer"))))
    (is (not (a/can-manage-federation? key-auth))))
  (is (thrown-with-msg? js/Error #"tenant id must not be empty" (a/can-view-tenant? owner-session "  "))))

(deftest visible-tenants
  (let [fallback [{"id" "x" "name" "X" "status" "active"}]]
    (is (= fallback (a/visible-tenants admin fallback)))
    (is (= [{"id" "t1" "name" "One" "status" "active"} {"id" "t2" "name" "t2" "status" "suspended"}]
           (a/visible-tenants owner-session fallback)))
    (is (= [] (a/visible-tenants key-auth fallback)))))
