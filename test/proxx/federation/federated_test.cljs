(ns proxx.federation.federated-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.federation.federated :as f]))

(deftest import-decisions
  (is (= :vanished (f/settled-before-import nil)))
  (is (= :already-imported (f/settled-before-import {"availabilityState" "imported"})))
  (is (nil? (f/settled-before-import {"availabilityState" "available"})))
  (is (f/importable? {"id" "p"} "cred"))
  (is (not (f/importable? nil "cred")))
  (is (not (f/importable? {"id" "p"} nil))))

(deftest stored-credentials
  (is (= {:store :oauth
          :args ["openai" "a1" "sec" "ref" 123 "cg" "e@x" "sub" "plus"]}
         (f/credential-write {"authType" "oauth_bearer" "providerId" "openai" "accountId" "a1" "secret" "sec"
                              "refreshToken" "ref" "expiresAt" 123 "chatgptAccountId" "cg" "email" "e@x"
                              "subject" "sub" "planType" "plus"})))
  (is (= {:store :api-key :args ["zai" "a2" "k"]}
         (f/credential-write {"authType" "api_key" "providerId" "zai" "accountId" "a2" "secret" "k" "refreshToken" "ignored"}))
      "anything but oauth_bearer is stored as an API key"))

(deftest peer-replies-reach-the-client
  (is (= :text (f/reply-mode false "text/event-stream")))
  (is (= :stream (f/reply-mode true "Text/Event-Stream; charset=utf-8")))
  (is (= :buffer (f/reply-mode true "application/json")))
  (is (= [["content-type" "application/json"]
          ["x-open-hax-federation-owner-subject" "o"] ["x-open-hax-federation-routed-peer" "p1"]
          ["x-open-hax-federation-routed-provider" "openai"] ["x-open-hax-federation-routed-account" "a1"]
          ["x-open-hax-federation-imported" "true"]]
         (f/reply-header-pairs [["content-type" "application/json"] ["set-cookie" "s=1"]
                                ["X-Open-Hax-Federation-Hop" "9"]]
                               "o" "p1" {"providerId" "openai" "accountId" "a1"} true))
      "cookies and federation control headers from a peer are never copied; routing headers follow"))
