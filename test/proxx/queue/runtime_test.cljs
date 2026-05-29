(ns proxx.queue.runtime-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.queue.runtime :as queue-runtime]))

(def reject-policy
  {:queue/status :active
   :queue/concurrency-limit 1
   :queue/max-queue-size 0
   :queue/overflow-policy :reject
   :queue/attempt-timeout-ms 1000
   :queue/max-retries 0
   :queue/retry-backoff :immediate
   :queue/fail-fast? false
   :queue/jitter-factor 0
   :queue/retry-after-respect? true})

(deftest ^:async rejects-when-concurrency-is-saturated-and-queue-is-full
  (try
    (let [state-atom (atom {:active 1 :queued 0 :waiting []})]
      (await (queue-runtime/acquire! state-atom reject-policy nil))
      (is false "acquire should reject when no queue slots are available"))
    (catch :default err
      (is (= :queue/full (:code (ex-data err)))))))
