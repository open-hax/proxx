(ns proxx.queue.policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy.contracts :as contracts]
            [proxx.queue.policy :as queue-policy]))

(def template
  {:contract/id :queue/default
   :contract/kind :request-queue-template
   :queue/name "Default queue"
   :queue/status :active
   :queue/concurrency-limit 4
   :queue/max-queue-size 10
   :queue/overflow-policy :reject
   :queue/attempt-timeout-ms 1000
   :queue/total-timeout-ms 5000
   :queue/max-retries 2
   :queue/retry-backoff :exponential
   :queue/fail-fast? false
   :queue/jitter-factor 0.2
   :queue/base-interval-ms 100
   :queue/retry-after-respect? true})

(deftest exponential-backoff-without-jitter
  (let [policy {:queue/retry-backoff :exponential
                :queue/base-interval-ms 100
                :queue/jitter-factor 0}]
    (is (= [0 100 200 400 800 1600]
           (mapv #(queue-policy/backoff-ms policy %) (range 6))))))

(deftest resolve-queue-policy-inherits-template-defaults
  (let [instance {:contract/id :queue/openai-chat
                  :contract/kind :request-queue-instance
                  :queue/template-id :queue/default
                  :queue/provider-id "openai"
                  :queue/concurrency-limit nil}
        compiled {:index (contracts/index-contracts [template instance])}]
    (is (= (:queue/concurrency-limit template)
           (:queue/concurrency-limit
            (queue-policy/resolve-queue-policy compiled {:provider-id "openai"}))))
    (is (= :reject
           (:queue/overflow-policy
            (queue-policy/resolve-queue-policy compiled {:provider-id "openai"}))))))

(deftest resolve-queue-policy-instance-override-wins
  (let [instance {:contract/id :queue/openai-chat
                  :contract/kind :request-queue-instance
                  :queue/template-id :queue/default
                  :queue/provider-id "openai"
                  :queue/concurrency-limit 1}
        compiled {:index (contracts/index-contracts [template instance])}]
    (is (= 1 (:queue/concurrency-limit
              (queue-policy/resolve-queue-policy compiled {:provider-id "openai"}))))))

(deftest classify-rate-limit-normalizes-provider-ids
  (let [classification {:contract/id :rate-limit/xiaomi
                        :contract/kind :rate-limit-classification
                        :match/provider-id "xiaomi"
                        :classify/status 429
                        :classify/result :rate-limit/volume}
        compiled {:index (contracts/index-contracts [classification])}]
    (is (= :rate-limit/volume
           (queue-policy/classify-rate-limit compiled "  XiAoMi  " 429 nil)))))
