(ns proxx.federation.agent-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.agent :as a]
            [proxx.federation.protocol :as p]))

(def opts {:owner-subject "o" :peer-did "did:web:x" :cluster-id "c" :agent-id "ag" :environment "e"
           :bridge-agent-version "1" :auth-mode "admin_key" :labels ["l"] :reconnect-min-ms 500 :reconnect-max-ms 5000})
(defn- env [& {:as m}] (merge {:now-ms 1700000000000 :trace-id "tr" :ws-open? true} m))
(def connected (assoc a/initial-state :session-id "S" :state :connected))

(deftest hello-has-no-session-even-when-one-is-remembered
  (let [[frame st] (a/hello-frame connected opts (env))]
    (is (not (contains? frame "sessionId")) "port bug found by the differential harness")
    (is (p/valid-frame? frame))
    (is (= (get frame "sentAt") (:last-sent-at st)))))

(deftest hello-ack-establishes-the-session
  (let [[fx st] (a/on-message (assoc a/initial-state :reconnect-attempt 3 :heartbeat-sequence 9) opts (env)
                              {"type" "hello_ack" "sessionId" "S" "sentAt" "2026-01-01T00:00:00.000Z" "heartbeatIntervalMs" 777})]
    (is (= [:publish-snapshot :start-heartbeat :connected] (map :fx fx)))
    (is (= 777 (:interval-ms (second fx))))
    (is (= {:state :connected :session-id "S" :reconnect-attempt 0 :heartbeat-sequence 0}
           (select-keys st [:state :session-id :reconnect-attempt :heartbeat-sequence])))
    (is (= "2026-01-01T00:00:00.000Z" (:last-received-at st)))))

(deftest inbound-requests
  (testing "GET runs at once; other methods wait for the final chunk"
    (is (= [{:fx :handle-request :request {"type" "request_open" "method" "GET" "streamId" "s"} :body-text ""}]
           (first (a/on-message connected opts (env) {"type" "request_open" "method" "GET" "streamId" "s"}))))
    (let [[_ st] (a/on-message connected opts (env) {"type" "request_open" "method" "POST" "streamId" "s"})
          [fx1 st] (a/on-message st opts (env) {"type" "request_chunk" "streamId" "s" "chunk" "ab" "encoding" "utf8"})
          [fx2 st] (a/on-message st opts (env) {"type" "request_chunk" "streamId" "s" "chunk" "Y2Q=" "encoding" "base64" "final" true})]
      (is (empty? fx1))
      (is (= "abcd" (:body-text (first fx2))))
      (is (empty? (:inbound st)))))
  (testing "a chunk for an unknown stream is reported and remembered as an error"
    (let [[fx st] (a/on-message connected opts (env) {"type" "request_chunk" "streamId" "x" "chunk" "a" "encoding" "utf8"})]
      (is (= "bridge_request_stream_missing" (get-in (first fx) [:frame "code"])))
      (is (= "bridge_request_stream_missing" (:code (:last-error st)))))))

(deftest errors-need-a-session-and-an-open-socket
  (is (= [[] a/initial-state] (a/send-error a/initial-state opts (env) {:code "c" :message "m" :retryable true})))
  (is (empty? (first (a/send-error connected opts (env :ws-open? false) {:code "c" :message "m" :retryable true})))))

(deftest streamed-responses-imply-missing-head-and-end
  (let [stream a/initial-stream
        [fx st stream] (a/stream-event connected opts (env) "s" stream {"type" "response_chunk" "chunk" "x"})
        types (fn [fx] (map #(get-in % [:frame "type"]) fx))]
    (is (= ["response_head" "response_chunk"] (types fx)) "a chunk before any head gets a 200 head")
    (is (= 200 (get-in (first fx) [:frame "status"])))
    (let [[fx _] (a/stream-finish st opts (env) "s" stream)]
      (is (= ["response_end"] (types fx)) "the missing end is supplied"))
    (let [[fx _] (a/stream-finish st opts (env) "s" a/initial-stream)]
      (is (= ["response_head" "response_end"] (types fx))))))

(deftest provenance-defaults-to-this-cluster
  (is (= "c" (get (a/merge-provenance nil {} opts) "servedByClusterId")))
  (is (= "other" (get (a/merge-provenance {"servedByClusterId" "base"} {"servedByClusterId" "other"} opts) "servedByClusterId")))
  (is (= "base" (get (a/merge-provenance {"providerId" "base"} {} opts) "providerId"))))

(deftest reconnect-backoff
  (is (= [500 1000 2000 4000 5000 5000] (map #(a/reconnect-delay-ms opts %) [1 2 3 4 5 6])))
  (let [[fx st] (a/schedule-reconnect (assoc a/initial-state :state :connected) opts)]
    (is (= [:clear-reconnect :arm-reconnect] (map :fx fx)))
    (is (= {:state :reconnecting :reconnect-attempt 1} (select-keys st [:state :reconnect-attempt]))))
  (is (empty? (first (a/schedule-reconnect (a/stop a/initial-state) opts))) "a stopped agent never reconnects"))

(deftest heartbeat-numbers-frames-from-one
  (let [[fx st] (a/heartbeat-frame connected opts (env))
        [fx2 _] (a/heartbeat-frame st opts (env))]
    (is (= 1 (get-in (first fx) [:frame "sequence"])))
    (is (= 2 (get-in (first fx2) [:frame "sequence"])))
    (is (p/valid-frame? (:frame (first fx))))))

(deftest buffered-responses
  (let [[fx _] (a/buffered-response connected opts (env) "s" {"status" 201 "body" "hi"})]
    (is (= ["response_head" "response_chunk" "response_end"] (map #(get-in % [:frame "type"]) fx)))
    (is (= true (get-in (second fx) [:frame "final"])))
    (is (every? #(p/valid-frame? (:frame %)) fx)))
  (is (= 2 (count (first (a/buffered-response connected opts (env) "s" {"status" 204}))))))
