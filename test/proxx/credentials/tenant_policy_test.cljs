(ns proxx.credentials.tenant-policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials.tenant-policy :as tp]))

(def base {"subjectDid" " did:a " "providerId" " OpenAI " "ownerSubject" " o "})

(deftest enums
  (is (= "local_upstream" (tp/normalize-kind nil)))
  (is (= "local_upstream" (tp/normalize-kind "  ")))
  (is (= "peer_proxx" (tp/normalize-kind " PEER_PROXX ")))
  (is (= "deny" (tp/normalize-share-mode nil)))
  (is (= "less_trusted" (tp/normalize-trust-tier nil)))
  (is (thrown-with-msg? ExceptionInfo #"invalid tenant provider share mode:  nope " (tp/normalize-share-mode " nope "))
      "the message quotes the original input"))

(deftest normalized-input
  (is (= {"subjectDid" "did:a" "providerId" "openai" "providerKind" "local_upstream" "ownerSubject" "o"
          "shareMode" "deny" "trustTier" "less_trusted" "allowedModels" [] "encryptedChannelRequired" false}
         (tp/normalize-input base)))
  (is (true? (get (tp/normalize-input (assoc base "shareMode" "project_credentials")) "encryptedChannelRequired"))
      "credential projection requires an encrypted channel unless stated otherwise")
  (is (false? (get (tp/normalize-input (assoc base "shareMode" "project_credentials" "encryptedChannelRequired" false)) "encryptedChannelRequired")))
  (is (= ["a" "b"] (get (tp/normalize-input (assoc base "allowedModels" ["a" " b " "a" "" 5 nil])) "allowedModels")))
  (is (= 2 (get (tp/normalize-input (assoc base "maxRequestsPerMinute" 2.7)) "maxRequestsPerMinute")))
  (is (= "n" (get (tp/normalize-input (assoc base "notes" "  n ")) "notes")))
  (is (not (contains? (tp/normalize-input (assoc base "notes" "  ")) "notes"))))

(deftest validation-keeps-its-order-and-strictness
  (is (thrown-with-msg? ExceptionInfo #"subject DID must not be empty" (tp/normalize-input (assoc base "subjectDid" " "))))
  (is (thrown-with-msg? ExceptionInfo #"invalid tenant provider share mode"
                        (tp/normalize-input (assoc base "subjectDid" " " "shareMode" "bad")))
      "share mode is validated before the subject, as before")
  (doseq [bad [0 -1 0.5 js/NaN js/Infinity "5"]]
    (is (thrown? ExceptionInfo (tp/normalize-input (assoc base "maxConcurrentRequests" bad))) (pr-str bad))))

(deftest rows-and-filters
  (let [parse (fn [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))
        r (tp/policy-record {"subject_did" "d" "allowed_models" "[\"x\",2]" "max_requests_per_minute" nil "notes" "n"} parse)]
    (is (= ["x"] (get r "allowedModels")))
    (is (not (contains? r "maxRequestsPerMinute")))
    (is (= "n" (get r "notes"))))
  (is (= [["subject_did = $1" "owner_subject = $2"] ["s" "o"]] (tp/list-filters {"subjectDid" " s " "ownerSubject" "o"})))
  (is (= [["owner_subject = $1"] ["o"]] (tp/list-filters {"subjectDid" " " "ownerSubject" "o"})))
  (is (= [[] []] (tp/list-filters {"subjectDid" 5}))))
