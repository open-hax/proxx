(ns proxx.runtime.proxy-test
  "Ported from src/tests/proxy-headers.test.ts, proxy-rate-limit.test.ts and
  rate-limit-classify.test.ts. The TS shim (src/lib/proxy.ts) only wrapped these
  edge functions, so the tests drive proxx.runtime.proxy directly."
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.runtime.proxy :as edge]))

;; ---- proxy-headers (3 tests) ---------------------------------------------

(defn- headers [obj] (js/Headers. obj))
(defn- forward [m] (headers (edge/forward-headers-js (clj->js m))))
(defn- for-credential [m credential options]
  (headers (edge/upstream-headers-for-credential-js (clj->js m) (clj->js credential) (some-> options clj->js))))

(deftest forward-headers-never-pass-browser-cookies-upstream
  (let [h (forward {"cookie" "session=abc" "expect" "100-continue" "x-custom-trace" "trace-1"})]
    (is (nil? (.get h "cookie")))
    (is (nil? (.get h "expect")))
    (is (= "trace-1" (.get h "x-custom-trace")))))

(deftest openai-oauth-upstream-headers-strip-browser-fingerprints-and-inject-codex-originator
  (let [h (for-credential {"accept" "application/json"
                           "accept-language" "en-US,en;q=0.9"
                           "cookie" "proxy_auth=abc"
                           "origin" "http://127.0.0.1:5174"
                           "referer" "http://127.0.0.1:5174/credentials"
                           "priority" "u=1, i"
                           "sec-ch-ua" "\"Chromium\";v=\"135\""
                           "sec-fetch-site" "same-site"
                           "user-agent" "Mozilla/5.0"
                           "x-forwarded-for" "203.0.113.10"
                           "x-real-ip" "203.0.113.10"}
                          {"providerId" "openai" "accountId" "acc-1" "token" "access-token-1"
                           "authType" "oauth_bearer" "chatgptAccountId" "workspace-a"}
                          {"useOpenAiCodexHeaderProfile" true})]
    (is (= "Bearer access-token-1" (.get h "authorization")))
    (is (= "workspace-a" (.get h "chatgpt-account-id")))
    (is (= "codex_cli_rs" (.get h "originator")))
    (is (= "application/json" (.get h "accept")))
    (doseq [stripped ["accept-language" "origin" "referer" "priority" "sec-ch-ua" "sec-fetch-site"
                      "user-agent" "x-forwarded-for" "x-real-ip"]]
      (is (nil? (.get h stripped)) stripped))))

(deftest non-openai-upstream-headers-keep-caller-user-agent-without-codex-profile
  (let [h (for-credential {"user-agent" "Mozilla/5.0" "x-custom-trace" "trace-2"}
                          {"providerId" "requesty" "accountId" "acc-2" "token" "api-key-2" "authType" "api_key"}
                          nil)]
    (is (= "Bearer api-key-2" (.get h "authorization")))
    (is (= "Mozilla/5.0" (.get h "user-agent")))
    (is (= "trace-2" (.get h "x-custom-trace")))
    (is (nil? (.get h "originator")))))

;; ---- proxy-rate-limit (18 tests) -----------------------------------------

(defn- retry-after [v] (edge/parse-retry-after-ms-js v))
(defn- wait-ms [m] (edge/parse-wait-time-from-message-js m))

(deftest parse-retry-after-ms-parses-seconds-as-number
  (is (= 30000 (retry-after "30")))
  (is (= 1500 (retry-after "1.5")))
  (is (= 0 (retry-after "0"))))

(deftest parse-retry-after-ms-parses-http-date-format
  (let [future (.toUTCString (js/Date. (+ (js/Date.now) 60000)))
        result (retry-after future)]
    (is (and (some? result) (> result 55000) (< result 65000)))))

(deftest parse-retry-after-ms-returns-undefined-for-invalid-input
  (is (undefined? (retry-after nil)))
  (is (undefined? (retry-after "")))
  (is (undefined? (retry-after "invalid"))))

(deftest wait-time-extracts-seconds-from-wait-x-seconds
  (is (= 23500 (wait-ms "Please wait 23.5 seconds before making another request.")))
  (is (= 1000 (wait-ms "Please wait 1 second.")))
  (is (= 500 (wait-ms "wait 0.5 seconds"))))

(deftest wait-time-extracts-seconds-from-try-again-in-xs
  (is (= 1370 (wait-ms "Please try again in 1.37s.")))
  (is (= 30000 (wait-ms "Rate limit reached. Try again in 30s"))))

(deftest wait-time-extracts-minutes
  (is (= 120000 (wait-ms "Please wait 2 minutes before retrying.")))
  (is (= 60000 (wait-ms "Wait 1 minute."))))

(deftest wait-time-extracts-combined-minutes-and-seconds
  (is (= 150000 (wait-ms "Please wait 2m 30s before making another request.")))
  (is (= 300000 (wait-ms "try again in 5m 0s"))))

(deftest wait-time-extracts-hours
  (is (= 3600000 (wait-ms "Please wait 1 hour before retrying.")))
  (is (= 7200000 (wait-ms "Wait 2 hours."))))

(deftest wait-time-extracts-days
  (is (= 86400000 (wait-ms "Please wait 1 day.")))
  (is (= 259200000 (wait-ms "Wait 3 days."))))

(deftest wait-time-is-case-insensitive
  (is (= 5000 (wait-ms "PLEASE WAIT 5 SECONDS")))
  (is (= 5000 (wait-ms "Wait 5 Seconds before making another request."))))

(deftest wait-time-undefined-for-messages-without-timing
  (is (undefined? (wait-ms "Rate limit exceeded.")))
  (is (undefined? (wait-ms "Service temporarily unavailable.")))
  (is (undefined? (wait-ms "")))
  (is (undefined? (wait-ms "Too many requests."))))

(deftest wait-time-handles-openai-style-messages
  (is (= 23500 (wait-ms "You are sending requests too quickly. Please wait 23.5 seconds before making another request.")))
  (is (= 1370 (wait-ms "Rate limit reached for requests. Please wait 1.37s."))))

(defn- response [body status headers]
  (js/Response. (if (string? body) body (js/JSON.stringify (clj->js body)))
                #js {:status status :headers (clj->js headers)}))

(deftest ^:async cooldown-prefers-retry-after-header
  (let [r (response {"error" {"message" "Please wait 100 seconds"}} 429
                    {"content-type" "application/json" "retry-after" "5"})]
    (is (= 5000 (await (edge/extract-rate-limit-cooldown-ms-js r)))
        "header says 5s, body says 100s: the header takes precedence")))

(deftest ^:async cooldown-extracts-from-body-when-header-is-missing
  (let [r (response {"error" {"message" "Please wait 30 seconds before making another request."}} 429
                    {"content-type" "application/json"})]
    (is (= 30000 (await (edge/extract-rate-limit-cooldown-ms-js r))))))

(deftest ^:async cooldown-undefined-when-no-timing-info
  (let [r (response {"error" {"message" "Rate limit exceeded"}} 429 {"content-type" "application/json"})]
    (is (undefined? (await (edge/extract-rate-limit-cooldown-ms-js r))))))

(deftest ^:async cooldown-undefined-for-non-json-response
  (let [r (response "Rate limit exceeded" 429 {"content-type" "text/plain"})]
    (is (undefined? (await (edge/extract-rate-limit-cooldown-ms-js r))))))

(deftest ^:async cooldown-handles-malformed-json-gracefully
  (let [r (response "not json" 429 {"content-type" "application/json"})]
    (is (undefined? (await (edge/extract-rate-limit-cooldown-ms-js r))) "does not throw")))

(deftest ^:async cooldown-extracts-timing-from-nested-error-object
  (let [r (response {"error" {"message" "Please try again in 2 minutes."}} 429 {"content-type" "application/json"})]
    (is (= 120000 (await (edge/extract-rate-limit-cooldown-ms-js r))))))

;; ---- rate-limit-classify (19 tests) --------------------------------------

(defn- classify
  ([body retry-after-ms] (classify body retry-after-ms 30000))
  ([body retry-after-ms threshold]
   (edge/classify-rate-limit-kind-js 429 (some-> body clj->js) retry-after-ms threshold js/undefined js/undefined)))

(defn- msg [m] {"error" {"message" m}})

(deftest classify-ollama-limits-are-quota-exhausted
  (testing "session limit" (is (= "quota_exhausted" (classify {"error" "Session usage limit reached"} 5000))))
  (testing "weekly limit" (is (= "quota_exhausted" (classify {"error" "Weekly usage limit reached"} 60000)))))

(deftest classify-concurrent-request-limit-message
  (is (= "concurrency_throttle" (classify (msg "Too many concurrent requests. Please try again.") 5000))))

(deftest classify-try-again-in-with-short-retry
  (is (= "concurrency_throttle" (classify (msg "Rate limit reached. Please try again in 5s.") 5000))))

(deftest classify-short-retry-after-without-quota-keywords
  (is (= "concurrency_throttle" (classify nil 3000 30000))))

(deftest classify-short-retry-after-with-body
  (is (= "concurrency_throttle" (classify (msg "Slow down please") 8000))))

(deftest classify-quota-exhaustion-message-wins-over-short-retry
  (is (= "quota_exhausted" (classify (msg "Insufficient quota for this account.") 3000))))

(deftest classify-billing-exhaustion
  (is (= "quota_exhausted" (classify (msg "Your account has an outstanding balance.") 5000))))

(deftest classify-credit-exhaustion
  (is (= "quota_exhausted" (classify (msg "Credits exhausted for this plan.") 10000))))

(deftest classify-long-retry-after-without-indicators-is-quota-exhausted
  (is (= "quota_exhausted" (classify nil 120000 30000)) "safe default"))

(deftest classify-no-body-no-retry-after-is-quota-exhausted
  (is (= "quota_exhausted" (edge/classify-rate-limit-kind-js 429 js/undefined js/undefined js/undefined js/undefined js/undefined)) "safe default"))

(deftest classify-zai-style-too-many-requests
  (is (= "concurrency_throttle"
         (classify (msg "Too many requests. Please wait 10.5 seconds before making another request.") 10500))))

(deftest classify-requests-per
  (is (= "concurrency_throttle" (classify (msg "You have exceeded your requests per minute limit.") 5000))))

(deftest classify-daily-limit
  (is (= "quota_exhausted" (classify (msg "You have reached your daily limit.") 5000))))

(deftest classify-plan-limit
  (is (= "quota_exhausted" (classify (msg "Plan limit reached for this billing period.") 5000))))

(deftest classify-capacity-message
  (is (= "concurrency_throttle" (classify (msg "Server is at capacity. Please retry.") 5000))))

(deftest detect-ollama-limit-kind
  (is (= "session" (edge/detect-ollama-limit-kind-js #js {:error "Session usage limit reached"})))
  (is (= "weekly" (edge/detect-ollama-limit-kind-js #js {:error "Weekly usage limit reached"})))
  (is (= "unknown" (edge/detect-ollama-limit-kind-js #js {:error "Something else"}))))

(deftest classify-xiaomi-short-429-is-volume-by-edn-contract
  ;; resources/policies/runtime/80-rate-limit-classification.edn: xiaomi 429 with
  ;; retry-after <= 30s is a volume limit, not a concurrency throttle.
  (let [k (fn [provider status retry]
            (edge/classify-rate-limit-kind-js status (clj->js (msg "slow down")) retry 30000 provider
                                              "resources/policies/runtime/00-manifest.edn"))]
    (is (= "quota_exhausted" (k "xiaomi" 429 5000)))
    (is (= "concurrency_throttle" (k "other" 429 5000)) "no contract: generic heuristics")
    (is (= "concurrency_throttle" (k "xiaomi" 429 60000)) "contract bounded by :max; wording still wins")))
