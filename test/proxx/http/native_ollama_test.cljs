(ns proxx.http.native-ollama-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.native-ollama :as n]))

(deftest provider-scope
  (is (= {"model" "ollama/llama3"} (n/with-provider-scope {"model" " llama3 "} ["ollama/" "ollama:"])))
  (is (= {"model" "OLLAMA/x"} (n/with-provider-scope {"model" "OLLAMA/x"} ["ollama/"])) "an existing prefix wins, case-insensitively")
  (is (= {"model" "ollama:m"} (n/with-provider-scope {"model" "m"} ["ollama:" "x/"])) "the configured ollama prefix is used")
  (is (= {"model" "ollama/m"} (n/with-provider-scope {"model" "m"} [])) "default prefix when none is configured")
  (is (= {"model" ""} (n/with-provider-scope {"model" ""} ["ollama/"])))
  (is (= {} (n/with-provider-scope {} ["ollama/"]))))

(deftest bridge-requests
  (is (= "/v1/chat/completions" (:url (n/bridge-request "/api/chat" {"model" "m"} []))))
  (is (= "/v1/embeddings" (:url (n/bridge-request "/api/embed" {"model" "m" "input" "x"} ["ollama/"]))))
  (is (= "ollama/m" (get-in (n/bridge-request "/api/embeddings" {"model" "m" "prompt" "x"} ["ollama/"]) [:payload "model"])))
  (testing "a non-object body is treated as empty"
    (is (= {"messages" [] "stream" false} (into {} (:payload (n/bridge-request "/api/chat" ["x"] [])))))))

(deftest response-translation
  (let [chat {"model" "m" "choices" [{"message" {"content" "hi"} "finish_reason" "stop"}]}
        ok {:headers {"content-type" "application/json; charset=utf-8"} :text "raw"}]
    (is (= "hi" (get-in (n/response-body "/api/chat" ok chat "T") ["message" "content"])))
    (is (= "raw" (n/response-body "/api/chat" {:headers {"content-type" "text/plain"} :text "raw"} chat "T")))
    (is (= "raw" (n/response-body "/api/chat" ok {"choices" "no"} "T")) "wrong shape passes through")
    (is (= "raw" (n/response-body "/api/chat" ok ["choices"] "T")))
    (is (= [[1 2]] (get (n/response-body "/api/embed" {:headers {} :text "raw"} {"data" [{"embedding" [1 2]}]} "T") "embeddings"))
        "no content-type header counts as JSON")))

(deftest copied-headers
  (is (= {"x-a" "1" "set-cookie" ["a" "b"]}
         (n/copyable-headers {"x-a" "1" "Content-Length" "5" "x-undef" nil "set-cookie" ["a" "b"]}))))
