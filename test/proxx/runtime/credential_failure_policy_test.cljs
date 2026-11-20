(ns proxx.runtime.credential-failure-policy-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.runtime :as runtime]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(def ^:private production-failures
  [["kimi-for-coding" 403 "You've reached your 5-hour usage limit."
    :credential-failure/kimi-for-coding-usage-window :credential/quota-exhausted 1800000]
   ["kimi-for-coding" 403 "Monthly usage limit"
    :credential-failure/kimi-for-coding-monthly-limit :credential/quota-exhausted 86400000]
   ["zen" 402 "Insufficient account funds"
    :credential-failure/zen-payment-required :credential/quota-exhausted 3600000]
   ["requesty" 412 "Reached monthly spend limit for API key"
    :credential-failure/requesty-key-spend-limit :credential/quota-exhausted 21600000]
   ["openrouter" 403 "Key limit exceeded (total limit)."
    :credential-failure/openrouter-key-limit :credential/quota-exhausted 3600000]
   ["openrouter" 404 "No allowed providers"
    :credential-failure/openrouter-no-allowed-providers :credential/model-unavailable 21600000]])

(deftest production-manifest-classifies-credential-failures
  (doseq [[provider status message _contract-id result cooldown-ms] production-failures]
    (testing (str provider " " status " " message)
      (is (= {:result result :cooldown-ms cooldown-ms}
             (runtime/classify-credential-failure manifest provider status message)))))
  (is (nil? (runtime/classify-credential-failure manifest "openrouter" 403 "Invalid API key"))))

(deftest production-verifier-retains-credential-failure-result-shape
  (doseq [[provider status message contract-id result cooldown-ms] production-failures]
    (testing (str provider " " status " " message)
      (is (= {"status" "ok"
              "result" (name result)
              "cooldownMs" cooldown-ms
              "disable" false
              "contractId" (str contract-id)}
             (js->clj (runtime/classify-credential-failure-js manifest provider status message))))))
  (is (= {"status" "ok" "result" nil "cooldownMs" nil "disable" false "contractId" nil}
         (js->clj (runtime/classify-credential-failure-js nil "openrouter" 403 "Invalid API key"))))
  (let [result (js->clj (runtime/classify-credential-failure-js
                         (str manifest "-missing") "requesty" 412 "Spend limit"))]
    (is (= "error" (get result "status")))
    (is (string? (get result "error")))))
