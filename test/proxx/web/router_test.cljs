(ns proxx.web.router-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.web.router :as r]))

(deftest matching
  (is (= :dashboard (r/match-page "/")))
  (is (= :dashboard (r/match-page "/nope")))
  (is (= :tools (r/match-page "/tools")))
  (is (= :tools (r/match-page "/tools/")))
  (is (= :chat (r/match-page "/chat/session?x=1")))
  (is (= :federation (r/match-page "/federation#x")))
  (is (= :dashboard (r/match-page "/chatty"))))

(deftest nav-links
  (let [dash (first r/routes) chat (second r/routes)]
    (is (r/link-active? "/" dash))
    (is (not (r/link-active? "/chat" dash)) "dashboard is end-only")
    (is (r/link-active? "/chat/x" chat))
    (is (not (r/link-active? "/chatty" chat)))
    (is (= "nav-link nav-link-active" (r/nav-class true)))
    (is (= "nav-link" (r/nav-class false)))))

(deftest nine-routes-in-order
  (is (= ["Dashboard" "Chat" "Analytics" "Events" "Hosts" "Images" "Credentials" "Federation" "Tools + MCP"]
         (mapv :label r/routes))))
