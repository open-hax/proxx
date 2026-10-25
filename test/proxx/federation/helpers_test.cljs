(ns proxx.federation.helpers-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.bridge-request :as req]
            [proxx.federation.helpers :as h]
            [proxx.federation.lease :as lease]))

(deftest peer-credential
  (is (= "c" (h/extract-peer-credential {"credential" " c " "bearer" "b"})))
  (is (= "b" (h/extract-peer-credential {"credential" "  " "bearer" " b "})))
  (is (nil? (h/extract-peer-credential {"credential" 5 "bearer" ""}))))

(deftest hop-count
  (is (= 0 (h/hop-count nil)))
  (is (= 3 (h/hop-count " 3 ")))
  (is (= 12 (h/hop-count "12abc")) "parseInt prefix semantics")
  (is (= 0 (h/hop-count "-1")))
  (is (= 0 (h/hop-count "abc")))
  (is (= 2 (h/hop-count ["" "2"])) "first non-empty repeated header"))

(def did "did:plc:z72i7hdynmk6r22z27h6tvur")

(deftest owner-subject
  (testing "explicit header honoured on a hop, for the legacy admin, or a bound tenant key"
    (is (= "o" (h/owner-subject {:header "o" :hop-count 1})))
    (is (= "o" (h/owner-subject {:header "o" :request-auth {"kind" "legacy_admin"}})))
    (is (= did (h/owner-subject {:header did :request-auth {"kind" "tenant_api_key" "tenantId" did}}))))
  (testing "a tenant key naming another owner is refused, never falls back"
    (is (nil? (h/owner-subject {:header "did:plc:other" :request-auth {"kind" "tenant_api_key" "tenantId" did}}))))
  (is (nil? (h/owner-subject {:header "o"})) "unauthenticated callers cannot assert an owner")
  (is (= did (h/owner-subject {:request-auth {"kind" "tenant_api_key" "subject" (str "tenant_api_key:" did)}})))
  (is (nil? (h/owner-subject {:request-auth {"kind" "tenant_api_key" "subject" "tenant_api_key:notdid"}})))
  (is (= "user" (h/owner-subject {:request-auth {"kind" "ui_session" "subject" " user "}})))
  (is (nil? (h/owner-subject {:request-auth {"kind" "ui_session" "subject" "legacy:proxy-auth-token"}})))
  (is (= "dflt" (h/owner-subject {:request-auth {"kind" "legacy_admin" "subject" "legacy:proxy-auth-token"}
                                  :default-owner-subject " dflt "})))
  (is (nil? (h/owner-subject {:request-auth {"kind" "ui_session"} :default-owner-subject "dflt"}))
      "the default owner is for the legacy admin only"))

(deftest json-reply-verdict
  (is (= {"content-type" "application/json"} (h/json-request-headers nil)))
  (is (= "Bearer t" (get (h/json-request-headers "t") "authorization")))
  (is (= "boom" (h/failure-message "boom" 500)))
  (is (= "request failed with 502" (h/failure-message 7 502))))

(deftest forwardable-headers
  (is (not (req/forwardable-header? "Content-Length" false)))
  (is (req/forwardable-header? "x-open-hax-upstream-account" false))
  (is (not (req/forwardable-header? "X-Open-Hax-Upstream-Account" true)))
  (is (req/forwardable-header? "content-type" true)))

(deftest lease-accounts
  (is (= [] (lease/parse-accounts nil "p")))
  (is (= [{"providerId" "fb" "accountId" " b " "authType" "oauth_bearer" "expiresAt" 5}]
         (lease/parse-accounts {"accounts" [nil 5 [] {"accountId" ""} {"accountId" " "}
                                            {"accountId" " b " "authType" "oauth_bearer" "expiresAt" 5 "planType" 3}]}
                               "fb"))
      "blank ids and non-objects are dropped; the id is kept untrimmed (persisted identity)"))

(deftest lease-export
  (is (nil? (lease/parse-export {"account" {"secret" ""}})))
  (is (nil? (lease/parse-export {"account" ["secret"]})))
  (is (= {"authType" "api_key" "secret" "s" "email" "e"}
         (lease/parse-export {"account" {"secret" "s" "email" "e" "subject" 1}}))))
