(ns proxx.http.proxy-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.proxy :as p]))

(deftest forward-headers
  (is (= {"x-trace" "1" "content-type" "application/json"}
         (p/forward-headers {"cookie" "s=1" "expect" "100-continue" "x-trace" "1" "Authorization" "Bearer x" "empty" ""})))
  (is (= {"accept" "a, b" "content-type" "text/plain"}
         (p/forward-headers {"accept" ["a" "b"] "content-type" "text/plain"})))
  (testing "codex profile strips browser fingerprints but keeps account id"
    (let [h (p/upstream-headers-for-credential
             {"user-agent" "x" "sec-ch-ua" "y" "x-forwarded-for" "1.2.3.4" "accept" "application/json"}
             {:token "t" :chatgpt-account-id "ws"} {:codex-profile? true})]
      (is (= {"accept" "application/json" "content-type" "application/json" "authorization" "Bearer t"
              "chatgpt-account-id" "ws" "originator" "codex_cli_rs"} h))))
  (testing "no token means no authorization header"
    (is (not (contains? (p/upstream-headers-for-credential {} {:token ""} {}) "authorization")))))

(deftest retry-after
  (let [date (fn [s] (when (= s "later") 15000))]
    (is (= 3000 (p/parse-retry-after-ms "3" 0 date)))
    (is (= 5000 (p/parse-retry-after-ms "later" 10000 date)))
    (is (= 0 (p/parse-retry-after-ms "later" 20000 date)) "past dates clamp to zero")
    (is (nil? (p/parse-retry-after-ms "-1" 0 (constantly nil))))
    (is (nil? (p/parse-retry-after-ms nil 0 date)))))

(deftest classification
  (is (= "quota_exhausted" (p/classify-rate-limit-kind {"error" {"message" "Too many requests - quota exceeded"}} 1000)))
  (is (= "concurrency_throttle" (p/classify-rate-limit-kind "Please slow down" nil)))
  (is (= "concurrency_throttle" (p/classify-rate-limit-kind "xyz" 5000)))
  (is (= "quota_exhausted" (p/classify-rate-limit-kind "xyz" 31000)))
  (is (= "quota_exhausted" (p/classify-rate-limit-kind nil nil)) "default falls over")
  (is (= "weekly" (p/ollama-limit-kind {"error" "You have reached your weekly usage limit"}))))

(deftest wait-times
  (is (= 150000 (p/parse-wait-time-from-message "Please try again in 2 minutes 30 seconds.")))
  (is (= 30000 (p/parse-wait-time-from-message "Please try again in 2m30s."))
      "pinned original quirk: \"2m\" has no word boundary before \"30\", so only the seconds count")
  (is (= (+ (* 5 86400000) (* 12 3600000)) (p/parse-wait-time-from-message "try again in 5d 12h")))
  (is (= 1370 (p/parse-wait-time-from-message "Rate limit reached. Please wait 1.37s.")))
  (is (nil? (p/parse-wait-time-from-message "nothing here")))
  (is (nil? (p/parse-wait-time-from-message 5)))
  (is (= 2000 (p/cooldown-from-error-body {"error" {"message" "wait 2 seconds"}})))
  (is (nil? (p/cooldown-from-error-body {"error" "wait 2 seconds"})))
  (is (p/readable-error-content-type? "text/plain"))
  (is (not (p/readable-error-content-type? "application/xml"))))

(deftest openai-error-envelope
  (is (= {"error" {"message" "m" "type" "t" "param" nil}} (p/openai-error "m" "t" nil)))
  (is (= ["message" "type" "code" "param"] (keys (get (p/openai-error "m" "t" "c") "error"))) "key order is wire-visible"))
