(ns proxx.credentials.federation-sql-test
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.credentials.federation-sql :as f]))

(defn- json [x] (js/JSON.stringify (clj->js x)))
(def ^:private cred {:value "k" :owner-subject "owner" :kind "admin_key"})
(defn- url [s] (str/replace (str (js/URL. s)) #"/+$" ""))

(deftest ddl-statements-are-the-persisted-contract
  (is (= 7 (count f/ddl)))
  (is (str/starts-with? (first f/ddl) "\nCREATE TABLE IF NOT EXISTS federation_peers ("))
  (is (= 10 (dec (count f/upsert-projected-account-strings))) "ten holes in the projected-account upsert"))

(deftest peer-upsert-merges-with-existing
  (let [existing {"controlBaseUrl" "https://old" "status" "paused" "auth" {"kept" 1} "capabilities" {"c" 2}}
        input {"label" " L " "baseUrl" "https://a.example/"}]
    (is (= ["id" "owner" nil "L" "https://a.example" "https://old" "admin_key" "{\"kept\":1}" "paused" "{\"c\":2}"]
           (f/peer-upsert-params input cred "id" existing json url))
        "left-out fields keep the existing value")
    (is (= ["id" "owner" "did:x" "L" "https://a.example" nil "admin_key" "{\"credential\":\"k\"}" "active" "{}"]
           (f/peer-upsert-params (assoc input "peerDid" " DID:X " "controlBaseUrl" "" "status" "  ") cred "id" nil json url))
        "a present-but-blank control URL clears it; blank status is active; auth defaults to the credential")
    (is (thrown-with-msg? js/Error #"label must not be empty"
                          (f/peer-upsert-params (assoc input "label" " ") cred "id" nil json url)))))

(deftest ids
  (is (= "p1" (f/peer-id {"id" " p1 "})))
  (is (nil? (f/peer-id {"id" "  "})))
  (is (nil? (f/peer-id {}))))

(deftest diff-events
  (is (= ["o" "t" "k" "op" "{}"] (f/diff-event-params {"ownerSubject" " o " "entityType" "t" "entityKey" "k" "op" "op"} json)))
  (is (thrown-with-msg? js/Error #"must not be empty" (f/diff-event-params {"ownerSubject" "o" "entityType" " " "entityKey" "k" "op" "op"} json)))
  (is (= ["o" 0 200] (f/list-diff-events-params {"ownerSubject" "o" "afterSeq" -3})))
  (is (= ["o" 2 500] (f/list-diff-events-params {"ownerSubject" "o" "afterSeq" 2.7 "limit" 9999})))
  (is (= ["o" 0 200] (f/list-diff-events-params {"ownerSubject" "o" "afterSeq" "x" "limit" 0}))))

(deftest projected-accounts
  (is (= ["p" "openai" "a"] (f/projected-account-key {"sourcePeerId" " p " "providerId" "OpenAI" "accountId" "a "})))
  (is (= "p|openai|a" (f/import-lock-key {"sourcePeerId" "p" "providerId" "OpenAI" "accountId" "a"})))
  (let [existing {"accountSubject" "s" "email" "e@x" "availabilityState" "imported" "metadata" {"m" 1}}
        base {"sourcePeerId" "p" "ownerSubject" "o" "providerId" "P" "accountId" "a"}]
    (is (= ["p" "o" "p" "a" "s" nil "e@x" nil "imported" {:json {"m" 1}}]
           (f/projected-account-upsert-values base existing (fn [x] {:json x}))) "undefined keeps existing")
    (is (= ["p" "o" "p" "a" nil "c" "x@y" "plus" "descriptor" {:json {}}]
           (f/projected-account-upsert-values (assoc base "accountSubject" "" "chatgptAccountId" "c" "email" " X@Y " "planType" "PLUS") nil (fn [x] {:json x})))
        "present-but-blank clears; email and plan are lower-cased")))

(deftest sync-state
  (is (= ["p" nil nil false false nil false] (f/sync-state-params {"peerId" " p "})))
  (is (= ["p" 3 nil true false nil true] (f/sync-state-params {"peerId" "p" "lastPulledSeq" 3 "lastPullAt" true "lastPushAt" "yes" "lastError" nil}))
      "lastError: null is written, absent is not; only `true` sets a timestamp")
  (is (= {"text" f/list-peers-text "values" []} (f/list-peers-statement "")))
  (is (= {"text" f/list-projected-owner-text "values" ["o"]} (f/projected-accounts-statement " o ")))
  (is (= {"text" f/list-projected-all-text "values" []} (f/projected-accounts-statement "  "))))
