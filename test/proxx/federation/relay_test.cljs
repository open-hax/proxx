(ns proxx.federation.relay-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.protocol :as p]
            [proxx.federation.relay :as r]
            [proxx.federation.stream :as s]
            [proxx.json :as json]))

(def t0 1700000000000)
(defn- env [& {:as extra}] (merge {:now-ms t0 :ids ["id-1" "id-2" "id-3"]} extra))
(def identity* {:auth-kind "legacy_admin" :subject "admin" :tenant-id "t1"})

(defn- frame [type & kvs]
  (apply assoc {"type" type "protocolVersion" "bridge-ws-v0" "sentAt" "2026-03-23T05:00:00.000Z" "traceId" "tr"
                "ownerSubject" "did:o" "clusterId" "c" "agentId" "a"}
         kvs))
(defn- text [f] (json/write f))
(def hello (frame "hello" "peerDid" "did:web:x" "environment" "local" "bridgeAgentVersion" "0.1" "authMode" "at_did"
                  "labels" ["l"]))

(defn- connected [] (second (r/accept-hello r/empty-state hello identity* (env :ids ["s1" "ack-trace"]))))
(defn- sends [fx] (filter #(= :send (:fx %)) fx))
(defn- error-codes [fx] (map #(get-in % [:frame "code"]) (sends fx)))

(deftest accept-hello
  (let [[ack state] (r/accept-hello r/empty-state hello identity* (env :ids ["s1" "tr-ack"]))
        s (r/get-session state "s1")]
    (is (p/valid-frame? ack))
    (is (= {"sessionId" "s1" "heartbeatIntervalMs" 15000 "maxConcurrentStreams" 32 "maxFrameBytes" 262144}
           (select-keys ack ["sessionId" "heartbeatIntervalMs" "maxConcurrentStreams" "maxFrameBytes"])))
    (is (= :connected (:state s)))
    (is (= "2026-03-23T05:00:00.000Z" (:connected-at s)) "connectedAt is the hello's own sentAt")
    (is (= [] (:capabilities s)))
    (is (= "t1" (:tenant-id s)))))

(deftest sessions-list-newest-first-and-stably
  (let [hello-at (fn [t] (assoc hello "sentAt" t))
        add (fn [st id t] (second (r/accept-hello st (hello-at t) identity* (env :ids [id "x"]))))
        st (-> r/empty-state (add "a" "2026-01-01T00:00:00.000Z") (add "b" "2026-03-01T00:00:00.000Z")
               (add "c" "2026-01-01T00:00:00.000Z"))]
    (is (= ["b" "a" "c"] (map :session-id (r/list-sessions st))))))

(deftest disconnected-sessions-are-pruned-after-retention
  (let [st (connected)
        [_ st] (r/disconnect st "s1" (env))
        later (+ t0 r/session-retention-ms 1)]
    (is (= :disconnected (:state (r/get-session st "s1"))))
    (is (some? (r/get-session (r/prune-disconnected st (+ t0 r/session-retention-ms)) "s1")) "exactly at the cutoff is kept")
    (is (nil? (r/get-session (r/prune-disconnected st later) "s1")))))

(deftest heartbeat-capabilities-health-update-the-session
  (let [st (connected)
        [fx st] (r/handle-message st "s1" (text (frame "heartbeat" "sequence" 4 "activeStreams" 2)) (env))
        s (r/get-session st "s1")]
    (is (empty? fx))
    (is (= 4 (:last-heartbeat-sequence s)))
    (is (= 2 (:active-streams s)))
    (is (nil? (:queued-requests s)) "an absent optional resets the previous value, as before")
    (is (= "2026-03-23T05:00:00.000Z" (:last-seen-at s)))))

(deftest error-frames
  (let [st (connected)]
    (testing "unparseable text on a known session"
      (let [[fx st'] (r/handle-message st "s1" "{" (env))]
        (is (= ["bridge_message_invalid"] (error-codes fx)))
        (is (= "s1" (get-in (first (sends fx)) [:frame "sessionId"])))
        (is (= "" (get-in (first (sends fx)) [:frame "ownerSubject"])) "a bare session id carries no owner")
        (is (nil? (:recent-error (r/get-session st' "s1"))))))
    (testing "unknown session"
      (is (= ["bridge_session_not_found"] (error-codes (first (r/handle-message st "nope" (text (frame "heartbeat" "sequence" 1)) (env)))))))
    (testing "frame addressed to another session"
      (let [[fx st'] (r/handle-message st "s1" (text (frame "heartbeat" "sessionId" "other" "sequence" 1 "streamId" "x")) (env))]
        (is (= ["bridge_session_mismatch"] (error-codes fx)))
        (is (= "x" (get-in (first (sends fx)) [:frame "streamId"])))
        (is (= "bridge_session_mismatch" (:code (:recent-error (r/get-session st' "s1")))))))
    (testing "duplicate hello and frames the relay does not execute"
      (is (= ["bridge_duplicate_hello"] (error-codes (first (r/handle-message st "s1" (text hello) (env))))))
      (let [[fx _] (r/handle-message st "s1" (text (frame "request_open" "streamId" "z" "method" "GET" "path" "/" "headers" {} "hopCount" 0)) (env))]
        (is (= ["bridge_execution_not_implemented"] (error-codes fx)))
        (is (true? (get-in (first (sends fx)) [:frame "retryable"])))))
    (testing "every error frame the relay originates is a valid frame"
      (doseq [fx [(first (r/handle-message st "s1" "{" (env)))
                  (first (r/handle-message st "nope" (text (frame "heartbeat" "sequence" 1)) (env)))
                  (first (r/handle-message st "s1" (text hello) (env)))]]
        (is (every? #(p/valid-frame? (:frame %)) (sends fx)))))))

(defn- open [st & {:as input}]
  (r/open-request st "s1" (merge {:path "/v1/models" :timeout-ms 100} input) (env :ids ["st-1" "t-a" "t-b"] :channel-open? true)))

(deftest open-request
  (let [[fx st stream-id] (open (connected) :method "POST" :body "{\"a\":1}" :request-context {"tenantId" "t1"})
        frames (map :frame (sends fx))]
    (is (= "st-1" stream-id))
    (is (= [:register-stream :arm-timer :send :send] (map :fx fx)))
    (is (= ["request_open" "request_chunk"] (map #(get % "type") frames)))
    (is (every? p/valid-frame? frames))
    (is (= {"accept" "application/json"} (get (first frames) "headers")) "default headers")
    (is (= true (get (second frames) "final")))
    (is (contains? (:pending st) "st-1")))
  (testing "no body, no chunk frame; GET by default"
    (let [[fx _ _] (open (connected))]
      (is (= 1 (count (sends fx))))
      (is (= "GET" (get-in (first (sends fx)) [:frame "method"])))))
  (testing "rejections"
    (is (= "bridge session s1 is not connected"
           (try (r/open-request (second (r/disconnect (connected) "s1" (env))) "s1" {:path "/"} (env :channel-open? true))
                (catch :default e (ex-message e)))))
    (is (= "bridge session s1 has no open channel"
           (try (r/open-request (connected) "s1" {:path "/"} (env :channel-open? false)) (catch :default e (ex-message e)))))))

(deftest response-frames-correlate-by-stream-id
  (let [[_ st _] (open (connected))
        head (text (frame "response_head" "streamId" "st-1" "status" 200 "headers" {}))]
    (is (= [:stream-push] (map :fx (first (r/handle-message st "s1" head (env))))))
    (is (empty? (first (r/handle-message st "s1" (text (frame "response_head" "streamId" "other" "status" 200 "headers" {})) (env))))
        "frames for unknown streams are dropped")
    (let [[fx st'] (r/handle-message st "s1" (text (frame "response_end" "streamId" "st-1")) (env))]
      (is (= [:clear-timer :stream-end] (map :fx fx)))
      (is (empty? (:pending st'))))
    (let [[fx st'] (r/handle-message st "s1" (text (frame "error" "streamId" "st-1" "code" "boom" "message" "bad" "retryable" true)) (env))]
      (is (= "boom: bad" (:message (second fx))))
      (is (empty? (:pending st')))
      (is (= "boom" (:code (:recent-error (r/get-session st' "s1"))))))))

(deftest timeout-disconnect-close-and-release
  (let [[_ st _] (open (connected))]
    (is (= "bridge request timed out for /v1/models" (:message (first (first (r/request-timed-out st "st-1")))) ))
    (is (empty? (first (r/request-timed-out st "gone"))) "a timer for a finished stream is a no-op")
    (let [[fx st'] (r/disconnect st "s1" (env))]
      (is (= [:unregister-channel :clear-timer :stream-fail] (map :fx fx)))
      (is (= "bridge session s1 closed during request st-1" (:message (last fx))))
      (is (empty? (:pending st'))))
    (is (empty? (first (r/disconnect st "unknown" (env)))))
    (let [[fx st'] (r/close-all st)]
      (is (= "bridge relay closed" (:message (last fx))))
      (is (empty? (:pending st'))))
    (is (empty? (:pending (second (r/release-request st "st-1")))))))

(deftest connection-handshake
  (let [conn {:session-id nil}
        run (fn [txt] (r/handle-connection-message r/empty-state conn txt (env :identity identity*)))]
    (testing "only a hello may open a connection"
      (let [[fx _ conn'] (run (text (frame "heartbeat" "sequence" 1)))]
        (is (= ["bridge_hello_required"] (error-codes fx)))
        (is (= {:fx :close :code 1008 :reason "bridge_hello_required"} (last fx)))
        (is (nil? (:session-id conn'))))
      (is (= ["bridge_message_decode_failed"] (error-codes (first (run "nope"))))))
    (testing "a hello registers the channel and acks"
      (let [[fx state' conn'] (run (text hello))]
        (is (= [:register-channel :send] (map :fx fx)))
        (is (= (:session-id conn') (get-in (second fx) [:frame "sessionId"])))
        (is (some? (r/get-session state' (:session-id conn'))))))
    (testing "transport errors"
      (let [fx (r/connection-error nil "bridge_binary_frames_not_supported" "no binary" (env))]
        (is (= [:send :close] (map :fx fx)))
        (is (= "" (get-in (first fx) [:frame "sessionId"])))))))

(deftest stream-queue-discipline
  (testing "frames wait for a consumer, consumers wait for frames"
    (let [[fx st] (s/push s/empty-stream :a)
          [out st] (s/pull st :w1)]
      (is (empty? fx))
      (is (= {:yield :a} out))
      (let [[out st] (s/pull st :w1)
            [fx st] (s/push st :b)]
        (is (= :wait out))
        (is (= [[:resolve-event :w1 :b]] fx))
        (is (empty? (:waiters st))))))
  (testing "the terminal frame is delivered, then every parked consumer is released"
    (let [[_ st] (s/pull s/empty-stream :w1)
          [_ st] (s/pull st :w2)
          [fx st] (s/finish st :end)]
      (is (= [[:resolve-event :w1 :end] [:resolve-done :w2]] fx))
      (is (= :done (first (s/pull st :w3))))))
  (testing "a failure surfaces only after queued frames are drained"
    (let [[_ st] (s/push s/empty-stream :a)
          [fx st] (s/fail st "boom")]
      (is (empty? fx))
      (let [[o1 st] (s/pull st :w)
            [o2 st] (s/pull st :w)]
        (is (= {:yield :a} o1))
        (is (= {:fail "boom"} o2))
        (is (= {:fail "boom"} (first (s/pull st :w))) "and keeps failing"))))
  (testing "failing rejects parked consumers; closing releases them as done"
    (let [[_ st] (s/pull s/empty-stream :w1)]
      (is (= [[:reject :w1 "x"]] (first (s/fail st "x"))))
      (is (= [[:resolve-done :w1]] (first (s/close st)))))))

(deftest frames-for-unknown-streams-still-count-as-sign-of-life
  ;; Port bug found by the differential harness: dropping an orphan response frame
  ;; must still record the session's lastSeenAt.
  (let [st (connected)
        [fx st'] (r/handle-message st "s1" (text (frame "response_chunk" "streamId" "gone" "chunk" "x" "encoding" "utf8" "sentAt" "2026-04-01T00:00:00.000Z")) (env))]
    (is (empty? fx))
    (is (= "2026-04-01T00:00:00.000Z" (:last-seen-at (r/get-session st' "s1"))))))
