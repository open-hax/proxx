(ns proxx.strategies.anthropic-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.strategies.anthropic :as anthropic]))

(def request-context
  {:endpoint "https://api.anthropic.test/v1/messages"
   :body {:model "claude-test"
          :messages []}
   :it {:secret "test-secret"}})

(deftest ^:async messages-passthrough-preserves-non-ok-response
  (let [response #js {:ok false :status 429}
        result (await (anthropic/messages-passthrough
                       (assoc request-context
                              :fetch (fn [_url _options]
                                       (js/Promise.resolve response)))))]
    (is (identical? response result))))

(deftest ^:async messages-passthrough-returns-nil-when-fetch-fails
  (let [result (await (anthropic/messages-passthrough
                       (assoc request-context
                              :fetch (fn [_url _options]
                                       (js/Promise.reject (js/Error. "network failure"))))))]
    (is (nil? result))))
