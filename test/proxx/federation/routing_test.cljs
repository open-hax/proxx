(ns proxx.federation.routing-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.routing :as r]))

(deftest who-is-asking
  (is (= "t1" (r/bridge-tenant-id {"tenantId" "t1" "kind" "legacy_admin"})))
  (is (= "default" (r/bridge-tenant-id {"kind" "legacy_admin"})))
  (is (nil? (r/bridge-tenant-id {"kind" "ui_session"})))
  (is (= "" (r/bridge-tenant-id {"tenantId" ""})) "an empty tenant id is the caller's problem, not defaulted")
  (is (= "did:plc:abcdefghijklmnopqrstuvwx" (r/subject-did {"subject" " did:plc:abcdefghijklmnopqrstuvwx "})))
  (is (= "did:web:t.example" (r/subject-did {"subject" "user" "tenantId" "did:web:t.example"})))
  (is (nil? (r/subject-did {"subject" "user" "tenantId" "t"})))
  (is (r/hop-limit-exceeded? 1))
  (is (not (r/hop-limit-exceeded? 0))))

(deftest relay-session-selection
  (let [session {"state" "connected" "ownerSubject" "o" "tenantId" "t"}]
    (is (r/session-eligible? session "o" "t") "no health report yet is fine")
    (is (r/session-eligible? (assoc session "health" {"upstreamHealthy" true "availableAccountCount" 1}) "o" "t"))
    (is (not (r/session-eligible? (assoc session "health" {"upstreamHealthy" true "availableAccountCount" 0}) "o" "t")))
    (is (not (r/session-eligible? (assoc session "health" {"upstreamHealthy" false "availableAccountCount" 3}) "o" "t")))
    (is (not (r/session-eligible? (assoc session "state" "disconnected") "o" "t")))
    (is (not (r/session-eligible? session "other" "t")))
    (is (not (r/session-eligible? session "o" "other")) "a session never serves another tenant"))
  (let [allowed (r/allowed-provider-ids [" OpenAI " "" "  "])]
    (is (= #{"openai"} allowed))
    (is (r/capability-admissible? {"providerId" "openai" "availableAccountCount" 1} allowed))
    (is (not (r/capability-admissible? {"providerId" "zai" "availableAccountCount" 1} allowed)))
    (is (not (r/capability-admissible? {"providerId" "openai" "availableAccountCount" 0} allowed)))
    (is (r/capability-admissible? {"providerId" "zai" "availableAccountCount" 1} #{}) "no restriction admits any provider")))

(deftest serving-a-bridged-request
  (doseq [ok ["/v1/models" "/v1/chat/completions?x=1" "/api/bridge/credentials/export"]]
    (is (r/bridge-path-allowed? ok) ok))
  (doseq [bad ["/api/ui/federation/accounts" "/v1/../api/ui/x" "/v1/models/" ""]]
    (is (not (r/bridge-path-allowed? bad)) bad))
  (is (r/bridge-path-allowed? "//evil/v1/models")
      "kept from the original: a URL parser reads `//evil` as a host, so only the pathname is judged; the forwarded request still targets the local server")
  (is (= {"accept" "application/json" "x-open-hax-bridge-auth" "internal" "x-open-hax-federation-hop" "1"
          "x-open-hax-federation-owner-subject" "o"}
         (r/bridge-request-headers {:owner-subject "o"})) "the bridge identity marker replaces the admin token")
  (is (= "t" (get (r/bridge-request-headers {:owner-subject "o" :tenant-id " t "}) "x-open-hax-bridge-tenant-id")))
  (is (not (contains? (r/bridge-request-headers {:owner-subject "o" :tenant-id "  "}) "x-open-hax-bridge-tenant-id")))
  (is (= "" (get (r/bridge-request-headers {:owner-subject "o" :accept ""}) "accept")) "an empty accept is kept, only a missing one defaults")
  (testing "text travels as utf8, binary as base64"
    (doseq [t ["" "text/plain" "application/json; charset=utf-8" "application/xml" "text/event-stream"]]
      (is (r/utf8-chunk-encoding? t) t))
    (is (not (r/utf8-chunk-encoding? "image/png")))))

(deftest content-types
  (is (r/event-stream-content-type? "Text/Event-Stream; charset=utf-8"))
  (is (not (r/event-stream-content-type? nil)))
  (is (r/json-content-type? "application/json"))
  (is (= "a" (r/response-content-type {"Content-Type" "a"})))
  (is (= "" (r/response-content-type {}))))

(deftest federated-requests
  (let [account {"providerId" "openai" "accountId" "a" "sourcePeerId" "p1" "ownerSubject" "o"
                 "availabilityState" "remote_route" "warmRequestCount" 3}]
    (is (= {"authorization" "Bearer c" "x-open-hax-federation-hop" "2" "x-open-hax-federation-owner-subject" "o"
            "x-open-hax-forced-provider" "openai" "x-open-hax-forced-account-id" "a"}
           (r/forwarded-request-overrides "c" 1 "o" account)))
    (is (= {"x-open-hax-federation-owner-subject" "o" "x-open-hax-federation-routed-peer" "p1"
            "x-open-hax-federation-routed-provider" "openai" "x-open-hax-federation-routed-account" "a"
            "x-open-hax-federation-imported" "true"}
           (r/routed-response-headers "o" "p1" account true)))
    (is (not (contains? (r/routed-response-headers "o" "p1" account false) "x-open-hax-federation-imported")))
    (is (= "p1:openai:a" (get (r/routed-diff-event account false) "entityKey")))
    (is (= true (get-in (r/routed-diff-event account true) ["payload" "importedCredential"]))))
  (is (not (r/copyable-response-header? "Set-Cookie")) "a peer can never set cookies on our reply")
  (is (not (r/copyable-response-header? "X-Open-Hax-Forced-Provider")))
  (is (r/copyable-response-header? "content-type"))
  (is (r/active-peer? {"status" " Active "}))
  (is (= ["http://c/api/v1/federation/accounts/export" "http://c/api/ui/federation/accounts/export"]
         (r/export-urls {"baseUrl" "http://b" "controlBaseUrl" "http://c"})))
  (is (= "http://b/api/v1/federation/accounts/export" (first (r/export-urls {"baseUrl" "http://b"}))))
  (is (= "openai\u0000 a " (r/local-account-key " OpenAI " " a ")) "the account id keeps its spaces")
  (is (r/warm-import-allowed? false false) "no policy, no constraint")
  (is (not (r/warm-import-allowed? true false)))
  (is (r/warm-import-allowed? true true)))
