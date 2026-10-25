(ns proxx.federation.sse-channel-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.federation.sse-channel :as sse]))

(deftest framing
  (is (= "data: {\"a\":1}\n\n" (sse/data-frame "{\"a\":1}")))
  (is (= "event: ping\ndata: 5\n\n" (sse/event-frame "ping" "5"))))

(deftest close-events-only-for-application-codes
  (is (= "event: close\ndata: {\"code\":4001,\"reason\":\"bye\"}\n\n" (sse/close-frame 4001 "\"bye\"")))
  (doseq [code [nil 0 1000 3999]]
    (is (nil? (sse/close-frame code "\"\"")) (str code))))
