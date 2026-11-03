(ns proxx.web.api-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.api :as api]))

(deftest query-strings
  (is (= "" (api/query-string [])))
  (is (= "" (api/query-string [["a" nil] ["b" ""] ["c" false]])))
  (is (= "?a=1&b=x+y" (api/query-string [["a" 1] ["skip" nil] ["b" "x y"]])))
  (is (= "?q=a%26b%3Dc" (api/query-string [["q" "a&b=c"]]))))

(deftest api-base-url
  (is (= "https://x.test" (api/base-url {:explicit " https://x.test/// "})))
  (is (= "http://h:8789" (api/base-url {:protocol "http:" :hostname "h" :port "5174"})))
  (is (= "" (api/base-url {:protocol "http:" :hostname "h" :port "8789"})))
  (is (= "" (api/base-url {:protocol "https:" :hostname "h" :port ""})))
  (is (= "https://abs.test/x" (api/absolute-url "http://b" "https://abs.test/x")))
  (is (= "http://b/api" (api/absolute-url "http://b" "/api"))))

(deftest headers
  (is (= {} (api/request-headers "  " false)))
  (is (= {"authorization" "Bearer t"} (api/request-headers "t" false)))
  (is (= {"authorization" "Bearer t" "content-type" "application/json"} (api/request-headers "t" true)))
  (is (= {"content-type" "application/json"} (api/request-headers nil true))))

(deftest responses
  (is (= {:ok {"a" 1}} (api/interpret-response {:status 200 :text "{\"a\":1}"})))
  (is (= {:ok {}} (api/interpret-response {:status 204 :text ""})))
  (is (= {:error "boom"} (api/interpret-response {:status 400 :text "{\"error\":{\"message\":\"boom\"}}"})))
  (is (= {:error "why"} (api/interpret-response {:status 500 :text "{\"detail\":\"why\"}"})))
  (is (= {:error "Request failed: 502"} (api/interpret-response {:status 502 :text "<html>"})))
  (is (= {:error "Request failed: 404"} (api/interpret-response {:status 404 :text "{\"error\":{}}"})))
  (is (:error (api/interpret-response {:status 200 :text "<html>"})) "malformed success body is an error"))

(deftest keywordizing-keeps-provider-subtrees
  (let [out (api/keywordize {"id" "e1" "meta" {"Some Key" {"x" 1}} "payload" {"a" [{"b" 2}]}
                             "tags" {"label:x" 3} "keyPoolStatuses" {"ollama-cloud" {"totalAccounts" 2}}
                             "rows" [{"requestCount" 1}]})]
    (is (= "e1" (:id out)))
    (is (= {"Some Key" {"x" 1}} (:meta out)) "opaque")
    (is (= {"a" [{"b" 2}]} (:payload out)))
    (is (= {"label:x" 3} (:tags out)) "string keys kept")
    (is (= 2 (get-in out [:keyPoolStatuses "ollama-cloud" :totalAccounts])) "id keys kept, values keywordized")
    (is (= [{:requestCount 1}] (:rows out)))))

(deftest request-descriptions
  (testing "paths, methods and bodies are data"
    (is (= {:method :get :path "/api/v1/sessions"} (dissoc (api/list-sessions) :decode)))
    (is (= {:method :post :path "/api/v1/sessions" :body {}} (dissoc (api/create-session nil) :decode)))
    (is (= {:title "New chat"} (:body (api/create-session "New chat"))))
    (is (= "/api/v1/tools?model=gpt%205%2Fx" (:path (api/list-tool-seeds "gpt 5/x"))))
    (is (= "/api/v1/dashboard/overview?sort=cost&window=weekly" (:path (api/get-usage-overview " cost " "weekly"))))
    (is (= "/api/v1/dashboard/overview" (:path (api/get-usage-overview nil "  "))))
    (is (= "/api/v1/credentials?reveal=1" (:path (api/list-credentials true))))
    (is (= "/api/v1/credentials" (:path (api/list-credentials false))))
    (is (= {:providerId "p" :apiKey "k"} (:body (api/add-api-key-credential "p" "k" "  "))))
    (is (= {:providerId "p" :apiKey "k" :accountId "a"} (:body (api/add-api-key-credential "p" "k" " a "))))
    (is (= :delete (:method (api/remove-credential "p" "a"))))
    (is (= "/api/v1/credentials/openai/prompt-cache-audit?limit=5" (:path (api/get-openai-prompt-cache-audit 5.7))))
    (is (= "/api/v1/federation/peers?ownerSubject=did%3Aweb%3Ax" (:path (api/list-federation-peers " did:web:x "))))
    (is (= "/api/v1/federation/peers" (:path (api/list-federation-peers ""))))
    (is (= "/api/v1/events/a%2Fb/tag" (:path (api/add-event-tag "a/b" "t"))))))

(deftest events-query
  (is (= "/api/v1/events?kind=error&provider_id=openai&limit=50&offset=0&include_count=true"
         (:path (api/list-events {:kind "error" :providerId "openai" :limit 50 :offset 0
                                  :includePayload false :includeCount true}))))
  (is (= "/api/v1/events?status=0&status_gte=400&include_payload=true"
         (:path (api/list-events {:status 0 :statusGte 400 :includePayload true})))))

(deftest model-normalization
  (is (= ["a" "b"] (api/normalize-models {"data" [{"id" " b "} {"id" "a"} {"id" "a"} {"id" ""} {} "x" nil]})))
  (is (= [] (api/normalize-models {"data" "nope"})))
  (is (= [] (api/normalize-models {}))))

(deftest decoders
  (is (= [{:id "s"}] ((:decode (api/list-sessions)) {"sessions" [{"id" "s"}]})))
  (is (= "k" ((:decode (api/get-session-prompt-cache-key "s")) {"promptCacheKey" "k"}))))
