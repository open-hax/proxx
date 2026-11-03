(ns proxx.oauth.factory-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.oauth.factory :as factory]))

(deftest jwt-expiry
  (is (= 1700000000000 (factory/jwt-expiry-ms {"exp" 1700000000})))
  (is (= 1500 (factory/jwt-expiry-ms {"exp" 1.5})))
  (doseq [claims [nil [] "s" 5 {} {"exp" "1"} {"exp" nil} {"exp" js/NaN} {"exp" js/Infinity}]]
    (is (nil? (factory/jwt-expiry-ms claims)) (pr-str claims))))

(deftest refresh-decision
  (let [base {:provider-id "factory" :auth-type "oauth_bearer" :refresh-token "r"}
        now 1000000
        soon (+ now 1000)
        far (+ now factory/refresh-buffer-ms 1)]
    (is (true? (factory/needs-refresh? base soon now)) "JWT exp inside the buffer")
    (is (false? (factory/needs-refresh? base far now)))
    (is (false? (factory/needs-refresh? base (+ now factory/refresh-buffer-ms) now)) "exactly at the buffer is not yet")
    (testing "the JWT expiry beats the stored one"
      (is (false? (factory/needs-refresh? (assoc base :expires-at soon) far now)))
      (is (true? (factory/needs-refresh? (assoc base :expires-at soon) nil now))))
    (is (false? (factory/needs-refresh? base nil now)) "no expiry information: do not force")
    (is (false? (factory/needs-refresh? (assoc base :refresh-token "") soon now)))
    (is (false? (factory/needs-refresh? (assoc base :refresh-token nil) soon now)))
    (is (false? (factory/needs-refresh? (assoc base :provider-id "openai") soon now)))
    (is (false? (factory/needs-refresh? (assoc base :auth-type "api_key") soon now)))))

(deftest auth-v2-envelope
  (is (= ["a" "b" "c"] (factory/split-auth-v2 " a:b:c \n")))
  (is (= ["" "" ""] (factory/split-auth-v2 "::")))
  (doseq [bad ["" "a:b" "a:b:c:d"]]
    (is (thrown-with-msg? ExceptionInfo #"Invalid auth.v2.file format" (factory/split-auth-v2 bad)) (pr-str bad)))
  (is (= {:access-token "at" :refresh-token "rt"} (factory/auth-v2-credentials {"access_token" " at " "refresh_token" "rt "})))
  (is (= {:access-token "at" :refresh-token ""} (factory/auth-v2-credentials {"access_token" "at" "refresh_token" 5})))
  (is (thrown-with-msg? ExceptionInfo #"missing access_token" (factory/auth-v2-credentials {"access_token" "  "})))
  (is (thrown-with-msg? ExceptionInfo #"missing access_token" (factory/auth-v2-credentials [])) "arrays are objects in JS")
  (is (thrown-with-msg? ExceptionInfo #"not a valid JSON object" (factory/auth-v2-credentials nil)))
  (is (thrown-with-msg? ExceptionInfo #"not a valid JSON object" (factory/auth-v2-credentials "s"))))

(deftest workos-refresh-validation
  (is (= {:access-token "a" :refresh-token "r"} (factory/refreshed-tokens {"access_token" " a " "refresh_token" "r"})))
  (is (thrown-with-msg? ExceptionInfo #"missing access_token" (factory/refreshed-tokens {"refresh_token" "r"})))
  (is (thrown-with-msg? ExceptionInfo #"missing refresh_token" (factory/refreshed-tokens {"access_token" "a" "refresh_token" " "})))
  (is (thrown-with-msg? ExceptionInfo #"invalid JSON" (factory/refreshed-tokens nil)))
  (is (= [["grant_type" "refresh_token"] ["refresh_token" "x"] ["client_id" factory/client-id]]
         (factory/refresh-params "x"))))

(deftest device-flow-decisions
  (doseq [[raw ms] [[5 5000] [2.5 2500] [0 5000] [-1 5000] ["5" 5000] [nil 5000]]]
    (is (= ms (factory/device-interval-ms raw)) (pr-str raw)))
  (is (= "https://c" (factory/verification-url {"verification_uri_complete" "https://c" "verification_uri" "https://u"})))
  (is (= "https://u" (factory/verification-url {"verification_uri_complete" "" "verification_uri" "https://u"})))
  (is (nil? (factory/verification-url {"verification_uri_complete" nil})))
  (is (= [:pending] (factory/device-poll-failure-plan 400 "authorization_pending")))
  (is (= [:slow-down] (factory/device-poll-failure-plan 400 "slow_down")))
  (is (= [:expired "Device authorization expired_token"] (factory/device-poll-failure-plan 400 "expired_token")))
  (is (= [:expired "Device authorization access_denied"] (factory/device-poll-failure-plan 400 "access_denied")))
  (is (= [:failed "WorkOS device poll failed: 500 unknown error"] (factory/device-poll-failure-plan 500 nil)))
  (is (= [:failed "WorkOS device poll failed: 400 weird"] (factory/device-poll-failure-plan 400 "weird"))))

(deftest token-mapping
  (let [uuid-calls (atom 0)
        new-uuid #(do (swap! uuid-calls inc) "uuid")]
    (is (= {:access-token "a" :refresh-token "r" :account-id "factory-u1" :email "e@x" :expires-at 5000}
           (factory/factory-tokens {"access_token" "a" "refresh_token" "r" "user" {"id" "u1" "email" "e@x"}} 5000 new-uuid)))
    (is (zero? @uuid-calls) "no uuid is drawn when the user has an id")
    (is (= "factory-uuid" (:account-id (factory/factory-tokens {"access_token" "a"} nil new-uuid))))
    (is (= "factory-uuid" (:account-id (factory/factory-tokens {"access_token" "a" "user" {"id" ""}} nil new-uuid))))
    (is (not (contains? (factory/factory-tokens {"access_token" "a"} nil new-uuid) :expires-at)))
    (is (= 3 @uuid-calls))))

(deftest request-params
  (is (= [["client_id" factory/client-id] ["redirect_uri" "r"] ["response_type" "code"] ["state" "s"]]
         (factory/browser-authorize-params "r" "s")))
  (is (= ["grant_type" "code" "client_id"] (mapv first (factory/code-exchange-params "c"))))
  (is (= ["grant_type" "device_code" "client_id"] (mapv first (factory/device-poll-params "d")))))
