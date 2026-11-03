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

(deftest ^:async attempt-signal-extends-the-timeout-once-streaming-starts
  ;; The attempt timeout aborts a request that never answers; once a stream has
  ;; started, `extendTimeout` on the signal swaps it for :queue/stream-timeout-ms.
  (let [policy (assoc reject-policy :queue/attempt-timeout-ms 30 :queue/stream-timeout-ms 500)
        aborted-early (atom nil)
        result (await (queue-runtime/run-attempt
                       (fn ^:async task [^js controller]
                         (let [signal (.-signal controller)]
                           (is (fn? (aget signal "extendTimeout")) "signal carries extendTimeout")
                           (.extendTimeout signal)
                           (await (js/Promise. (fn [resolve] (js/setTimeout resolve 120))))
                           (reset! aborted-early (.-aborted signal))
                           :streamed))
                       0 policy nil))]
    (is (= :streamed result))
    (is (false? @aborted-early) "past the attempt timeout, but extended")))

(deftest ^:async attempt-without-extension-times-out
  (let [policy (assoc reject-policy :queue/attempt-timeout-ms 30)]
    (try
      (await (queue-runtime/run-attempt
              (fn ^:async task [^js _controller] (await (js/Promise. (fn [_] nil))))
              0 policy nil))
      (is false "should time out")
      (catch :default err
        (is (= :queue/attempt-timeout (:code (ex-data err))))
        (is (= 5000 (:retry-after-ms (ex-data err))) "timeouts advertise a retry delay")))))
