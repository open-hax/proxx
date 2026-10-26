(ns proxx.ollama.cloud-probe-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.ollama.cloud-probe :as p]))

(deftest error-reading
  (is (= "HTTP 500" (p/error-message 500 "  ")))
  (is (= "rate limited" (p/error-message 429 "{\"error\":{\"message\":\" rate limited \"}}")))
  (is (= "d" (p/error-message 400 "{\"detail\":\"d\"}")))
  (is (= "{\"error\":\"plain\"}" (p/error-message 400 "{\"error\":\"plain\"}")) "a string error is not read as a message (original behaviour)")
  (is (= (str (apply str (repeat 157 "x")) "...") (p/error-message 500 (apply str (repeat 200 "x")))))
  (is (= "weekly_limit" (p/error-code "{\"error\":{\"code\":\" WEEKLY_Limit \"}}")))
  (is (= "x" (p/error-code "{\"code\":\"x\"}")))
  (is (nil? (p/error-code "nope")))
  (is (nil? (p/error-code ""))))

(deftest results
  (let [account {"id" "a1" "displayName" "A" "planType" "pro"}
        ok (p/ok-result "ollama-cloud" account "T" "m" "Hello" 200)
        err (p/error-result "ollama-cloud" account "T" "m" "Missing API key." 401 "missing_api_key")]
    (is (true? (get ok "matchesExpectedOutput")))
    (is (= "Live — replied with \"Hello\"." (get ok "message")))
    (is (= ["providerId" "accountId" "displayName" "planType" "testedAt" "model" "expectedText" "status" "ok"
            "matchesExpectedOutput" "outputText" "upstreamStatus" "message"] (keys ok)))
    (is (= "Live — request completed without assistant text." (get (p/ok-result "p" account "T" "m" "" 200) "message")))
    (is (= ["providerId" "accountId" "displayName" "planType" "testedAt" "model" "expectedText" "status" "ok"
            "matchesExpectedOutput" "upstreamStatus" "errorCode" "message"] (keys err)))))

(deftest payload-and-urls
  (is (= "https://h/api/chat" (p/endpoint "https://h///")))
  (is (= "gemma4:31b" (p/probe-model "  ")))
  (is (= "m" (p/probe-model " m ")))
  (is (= "hello" (p/completion-text {"choices" [{"message" {"content" " hello\n"}}]})))
  (is (= "" (p/completion-text {"choices" []}))))
