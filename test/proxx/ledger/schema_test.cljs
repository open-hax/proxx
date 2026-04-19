(ns proxx.ledger.schema-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [malli.core :as m]
            [proxx.ledger.schema :as ls]))

(defn valid? [schema-key value]
  (m/validate (get ls/registry schema-key) value))

(deftest session-start-valid
  (testing "well-formed session_start passes validation"
    (is (valid? :ledger/session-start
                {:event-id         "ev-1"
                 :event-type       :session-start
                 :ts               1000
                 :session-id       "S1"
                 :harness-id       "opencode"
                 :harness-cache-key "hck-abc"
                 :derived-cache-key "dck-xyz"
                 :provider-id      "openai"
                 :account-id       "A1"
                 :model-id         "gpt-4o"}))))

(deftest empty-provider-response-valid
  (testing "well-formed empty_provider_response passes validation"
    (is (valid? :ledger/empty-provider-response
                {:event-id   "ev-2"
                 :event-type :empty-provider-response
                 :ts         2000
                 :session-id  "S1"
                 :provider-id "ollama-cloud"
                 :account-id  "A2"
                 :model-id    "qwen-coder"
                 :request-id  "req-1"
                 :http-status 200
                 :raw-body    "{\"error\":\"rate limit exceeded\"}"
                 :outcome     :quota-exhausted-in-body}))))

(deftest cooldown-initiated-valid
  (testing "well-formed account_cooldown_initiated passes validation"
    (is (valid? :ledger/cooldown-initiated
                {:event-id       "ev-3"
                 :event-type     :account-cooldown-initiated
                 :ts             3000
                 :provider-id    "openai"
                 :account-id     "A1"
                 :model-id       "gpt-4o"
                 :reason         :quota-short
                 :cooldown-until 99999000}))))

(deftest health-degraded-valid
  (testing "well-formed account_health_degraded passes validation"
    (is (valid? :ledger/health-degraded
                {:event-id             "ev-4"
                 :event-type           :account-health-degraded
                 :ts                   4000
                 :provider-id          "anthropic"
                 :account-id           "A3"
                 :model-id             "claude-3-5-sonnet"
                 :health-score-before  0.9
                 :health-score-after   0.4
                 :degraded-threshold   0.5
                 :contributing-metrics {:error-rate 0.3
                                        :p50-latency-ms 900.0}}))))

(deftest missing-required-field-fails
  (testing "missing event-id fails validation"
    (is (not (valid? :ledger/session-start
                     {:event-type        :session-start
                      :ts                1000
                      :session-id        "S1"
                      :harness-id        "opencode"
                      :harness-cache-key "hck-abc"
                      :derived-cache-key "dck-xyz"
                      :provider-id       "openai"
                      :account-id        "A1"
                      :model-id          "gpt-4o"})))))
