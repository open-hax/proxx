(ns proxx.federation.protocol-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.protocol :as p]
            [proxx.json :as json]))

(defn- thrown-message [f] (try (f) nil (catch :default e (ex-message e))))

(def envelope
  {"protocolVersion" "bridge-ws-v0" "sentAt" "2026-03-23T05:00:00.000Z" "traceId" "t1"
   "ownerSubject" "did:plc:z72i7hdynmk6r22z27h6tvur" "clusterId" "local-dev" "agentId" "agent-1"})

(defn- frame [type & kvs] (apply assoc (assoc envelope "type" type) kvs))

(def hello
  (frame "hello" "peerDid" "did:web:local" "environment" "local" "bridgeAgentVersion" "0.1.0" "authMode" "at_did"
         "labels" ["laptop" " oauth "]
         "topology" {"groups" [{"groupId" "group-a" "nodeIds" ["a1" "a2"]}]
                     "nodes" [{"groupId" "group-a" "nodeId" "a1" "labels" ["default"]}]
                     "defaultExecutionPolicy" "group_affinity"}))

(def capability
  {"providerId" "openai" "modelPrefixes" ["gpt-"] "models" ["m" "m"] "authType" "api_key"
   "accountCount" 2 "availableAccountCount" 1 "supportsModelsList" true "supportsChatCompletions" true
   "supportsResponses" false "supportsStreaming" true "supportsWarmImport" false
   "credentialMobility" "importable" "credentialOrigin" "local_api_key"
   "topologyTargets" [{"groupId" "group-a" "nodeId" "a1"}]})

(deftest hello-with-topology
  (let [m (p/parse-message hello)]
    (is (= "hello" (get m "type")))
    (is (= ["laptop" "oauth"] (get m "labels")) "entries are trimmed")
    (is (= "group_affinity" (get-in m ["topology" "defaultExecutionPolicy"])))
    (is (= 2 (count (get-in m ["topology" "groups" 0 "nodeIds"]))))
    (is (not (contains? m "capabilitiesHash")) "absent optionals stay absent")))

(deftest capabilities-defaults-and-trimming
  (let [m (p/parse-message (frame "capabilities" "sessionId" " s1 " "capabilities" [capability]))
        c (get-in m ["capabilities" 0])]
    (is (= "s1" (get m "sessionId")))
    (is (= [] (get c "paths")) "absent string arrays normalize to []")
    (is (= ["m" "m"] (get c "models")) "duplicates are the sender's business")
    (is (= [{"groupId" "group-a" "nodeId" "a1"}] (get c "topologyTargets")))))

(deftest rejections-carry-the-peer-visible-message
  (is (= "bridge message must be an object" (thrown-message #(p/parse-message nil))))
  (is (= "bridge message type must be a non-empty string" (thrown-message #(p/parse-message {}))))
  (is (= "bridge message protocolVersion must be one of bridge-ws-v0"
         (thrown-message #(p/parse-message (assoc hello "protocolVersion" "v9")))))
  (is (= "bridge message sentAt must be an ISO timestamp"
         (thrown-message #(p/parse-message (assoc hello "sentAt" "yesterday")))))
  (is (= "unsupported bridge message type: nope" (thrown-message #(p/parse-message (frame "nope")))))
  (is (= "bridge message authMode must be one of admin_key, at_did, did_signed_challenge"
         (thrown-message #(p/parse-message (assoc hello "authMode" "other")))))
  (is (= "bridge message labels[1] must be a non-empty string"
         (thrown-message #(p/parse-message (assoc hello "labels" ["ok" "  "])))))
  (is (= "bridge message capabilities[0].credentialMobility must be one of local_only, descriptor_only, importable, non_exportable, access_token_only"
         (thrown-message #(p/parse-message (frame "capabilities" "capabilities" [(assoc capability "credentialMobility" "x")]))))
      "enum errors name the full field path")
  (is (= "bridge message accountCount must be a non-negative integer"
         (thrown-message #(p/parse-message (frame "capabilities" "capabilities" [(assoc capability "accountCount" 1.5)]))))))

(deftest absent-is-not-null
  (testing "an absent optional object is fine, a null one is not"
    (is (not (contains? (p/parse-message hello) "requestContext")))
    (is (= "bridge message topology must be an object when present"
           (thrown-message #(p/parse-message (assoc hello "topology" nil)))))
    (is (= "bridge message queuedRequests must be a non-negative integer when present"
           (thrown-message #(p/parse-message (frame "heartbeat" "sequence" 1 "queuedRequests" nil))))))
  (testing "the chunk 'final' flag defaults to false only when absent"
    (let [chunk (frame "request_chunk" "streamId" "s" "chunk" " raw " "encoding" "utf8")]
      (is (= false (get (p/parse-message chunk) "final")))
      (is (= " raw " (get (p/parse-message chunk) "chunk")) "chunk bodies are not trimmed")
      (is (= "bridge message final must be a boolean" (thrown-message #(p/parse-message (assoc chunk "final" nil))))))))

(deftest header-records
  (let [open (frame "request_open" "streamId" "st" "method" "POST" "path" "/v1/x" "hopCount" 0
                    "headers" {" accept " "a"})]
    (is (= {"accept" "a"} (get (p/parse-message open) "headers")) "header names are trimmed")
    (is (= "bridge message headers.  must be a string header pair"
           (thrown-message #(p/parse-message (assoc open "headers" {" " "a"})))))
    (is (= "bridge message headers.x must be a string header pair"
           (thrown-message #(p/parse-message (assoc open "headers" {"x" 1})))))))

(deftest intentional-divergence-arrays-are-not-objects
  ;; TypeScript's isRecord([]) is true, so an array where an object belongs was
  ;; walked as an empty (or index-keyed) record. The wire contract says
  ;; objects; arrays are rejected outright.
  (is (= "bridge message must be an object" (thrown-message #(p/parse-message [])))
      "TS: 'bridge message type must be a non-empty string'")
  (is (= "bridge message must be an object" (thrown-message #(p/parse-message ["a"]))))
  (is (= "bridge message topology must be an object when present"
         (thrown-message #(p/parse-message (assoc hello "topology" []))))
      "TS accepted [] as an empty topology")
  (is (= "bridge message headers must be an object"
         (thrown-message #(p/parse-message (frame "request_open" "streamId" "s" "method" "GET" "path" "/"
                                                 "hopCount" 0 "headers" ["x"]))))
      "TS normalized ['x'] to {'0': 'x'}"))

(deftest parse-message-json
  (is (= "hello" (get (p/parse-message-json (json/write hello)) "type")))
  (is (thrown? js/Error (p/parse-message-json "{"))))

(deftest parsed-frames-satisfy-the-frame-schema
  (doseq [f [hello
             (frame "hello_ack" "sessionId" "s" "heartbeatIntervalMs" 15000 "maxConcurrentStreams" 32 "maxFrameBytes" 1)
             (frame "heartbeat" "sequence" 1 "activeStreams" 0)
             (frame "capabilities" "capabilities" [capability])
             (frame "health_report" "health" {"processHealthy" true "upstreamHealthy" true "availableAccountCount" 1
                                              "localOauthBootstrapReady" false "queuedRequests" 0
                                              "nodes" [{"groupId" "g" "nodeId" "n" "reachable" true}]})
             (frame "request_open" "streamId" "s" "method" "GET" "path" "/" "headers" {} "hopCount" 0
                    "requestContext" {"tenantId" "t"} "routingIntent" {"model" "m"})
             (frame "request_chunk" "streamId" "s" "chunk" "x" "encoding" "utf8" "final" true)
             (frame "response_head" "streamId" "s" "status" 200 "headers" {"a" "b"} "providerId" "p")
             (frame "response_chunk" "streamId" "s" "chunk" "x" "encoding" "base64")
             (frame "response_end" "streamId" "s" "usage" {"totalTokens" 3})
             (frame "error" "code" "c" "message" "m" "retryable" false)]]
    (let [parsed (p/parse-message f)]
      (is (p/valid-frame? parsed) (str "parsed " (get f "type") " is a valid frame"))
      (is (= parsed (p/parse-message (json/parse (p/encode-frame parsed)))) "encode then parse is the identity"))))

(deftest encode-frame-refuses-malformed-frames
  (is (= "bridge frame is not well-formed: response_head.status.0"
         (thrown-message #(p/encode-frame (frame "response_head" "streamId" "s" "status" "200" "headers" {})))))
  (is (some? (thrown-message #(p/encode-frame (assoc (p/parse-message hello) "protocolVersion" "v0")))))
  (is (some? (thrown-message #(p/encode-frame {"type" "mystery"}))))
  (testing "empty envelope strings are legal on the wire: relay error frames use them before a session exists"
    (is (string? (p/encode-frame (frame "error" "sessionId" "" "ownerSubject" "" "clusterId" "" "agentId" ""
                                        "code" "c" "message" "m" "retryable" false))))))
