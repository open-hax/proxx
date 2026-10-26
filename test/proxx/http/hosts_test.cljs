(ns proxx.http.hosts-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.hosts :as hosts]))

(deftest timeout-clamps
  (is (= 5000 (hosts/timeout-ms nil)))
  (is (= 5000 (hosts/timeout-ms "")))
  (is (= 5000 (hosts/timeout-ms "abc")))
  (is (= 5000 (hosts/timeout-ms "100")))
  (is (= 7000 (hosts/timeout-ms "7000")))
  (is (= 60000 (hosts/timeout-ms "999999")))
  (is (= 8000 (hosts/timeout-ms " 8000x")))
  (is (= 5000 (hosts/timeout-ms "Infinity"))))

(deftest base-url
  (is (= "http://a:1" (hosts/base-url {"host" "a:1"} "http")))
  (is (= "https://c" (hosts/base-url {"x-forwarded-host" "c" "x-forwarded-proto" "https"} "http")))
  (testing "a present-but-empty Host does not fall back to X-Forwarded-Host"
    (is (nil? (hosts/base-url {"host" "" "x-forwarded-host" "c"} "http"))))
  (testing "an empty X-Forwarded-Proto is honoured (?? keeps \"\")"
    (is (= "://a" (hosts/base-url {"host" "a" "x-forwarded-proto" ""} "http"))))
  (is (nil? (hosts/base-url {} "http"))))

(deftest authorization
  (is (= 401 (:status (hosts/authorize nil))))
  (is (= 403 (:status (hosts/authorize {"kind" "tenant_api_key" "role" "owner"}))))
  (is (= 403 (:status (hosts/authorize {"kind" "ui_session" "role" "viewer"}))))
  (is (nil? (hosts/authorize {"kind" "ui_session" "role" "admin"})))
  (is (nil? (hosts/authorize {"kind" "legacy_admin"}))))

(deftest self-selection
  (is (= {:id "b"} (hosts/select-self [{:id "a"} {:id "b"}] "b")))
  (is (= {:id "a"} (hosts/select-self [{:id "a"} {:id "b"}] nil)))
  (is (nil? (hosts/select-self [] "a")))
  (is (= {"generatedAt" "t" "selfTargetId" nil "hosts" []} (hosts/overview "t" nil []))))
