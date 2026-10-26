(ns proxx.web.federation-smoke
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private now "2026-04-03T00:00:00.000Z")

(deftest ^:async federation-page-renders
  (s/stub-fetch!
   [[#"GET .*/api/v1/settings" {"fastMode" false}]
    [#"GET .*/api/v1/federation/self" {"nodeId" "local-primary" "groupId" "g" "clusterId" "c" "peerDid" "did:web:proxx.local" "publicBaseUrl" "http://127.0.0.1:8789" "peerCount" 1}]
    [#"GET .*/api/v1/federation/peers" {"peers" [{"id" "peer-a" "ownerSubject" "o" "peerDid" "did:web:peer-a.local" "label" "Peer A" "baseUrl" "https://peer-a.local"
                                                 "authMode" "admin_key" "auth" {} "status" "healthy" "capabilities" {} "createdAt" now "updatedAt" now}]}]
    [#"GET .*/api/v1/federation/accounts" {"ownerSubject" "o" "localAccounts" [{"providerId" "openai" "accountId" "a"}] "projectedAccounts" [{"providerId" "openai" "accountId" "p"}] "knownAccounts" []}]
    [#"GET .*/api/v1/federation/bridges" {"sessions" [{"sessionId" "bridge-1" "peerDid" "did:web:peer-a.local" "agentId" "agent-a"}]}]
    [#"GET .*/api/v1/request-logs" {"entries" [{"id" "r1" "timestamp" 0 "routeKind" "federated" "routedPeerLabel" "Peer A" "providerId" "openai" "accountId" "a" "model" "gpt" "status" 200 "latencyMs" 12}]}]])
  (set! js/WebSocket (fn [_url] #js {:close (fn [])}))
  (await (s/mount-app! "/federation"))
  (let [t (s/body-text)]
    (is (str/includes? t "Brethren control surface"))
    (is (str/includes? t "Peer A"))
    (is (str/includes? t "Bridge sessions"))
    (is (str/includes? t "Account knowledge"))
    (is (str/includes? t "local-primary"))
    (is (str/includes? t "bridge-1"))
    (is (str/includes? t "federated → Peer A · gpt"))
    (is (str/includes? t "Sync pull"))
    (is (str/includes? t "Add peer"))))
