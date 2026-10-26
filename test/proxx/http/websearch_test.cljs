(ns proxx.http.websearch-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.websearch :as ws]))

(deftest request-validation
  (is (= 400 (get-in (ws/parse-request nil) [:error :status])))
  (is (= {"error" "invalid_body"} (get-in (ws/parse-request ["x"]) [:error :body])))
  (is (= {"error" "query_required"} (get-in (ws/parse-request {"query" "  "}) [:error :body])))
  (let [facts (ws/parse-request {"query" " cats " "numResults" 99 "searchContextSize" " HIGH "
                                 "allowedDomains" ["a.com" " b.com " "" 5] "model" " m "})]
    (is (= {:query "cats" :num-results 20 :context-size "high" :allowed-domains ["a.com" "b.com"] :requested-model "m"}
           facts)))
  (is (= 8 (:num-results (ws/parse-request {"query" "q" "numResults" "5"}))) "non-numbers use the default")
  (is (= 1 (:num-results (ws/parse-request {"query" "q" "numResults" -4}))))
  (is (= 50 (count (:allowed-domains (ws/parse-request {"query" "q" "allowedDomains" (mapv #(str "d" % ".com") (range 60))}))))))

(deftest models-and-attempts
  (is (= ["m" "gpt-5.4-mini"] (ws/candidate-models "m" nil)))
  (is (= ["gpt-5.4-mini"] (ws/candidate-models "gpt-5.4-mini" "")))
  (is (= ["fb"] (ws/candidate-models "" " fb ")))
  (is (= [["a" true] ["a" false] ["b" true] ["b" false]] (ws/attempt-order ["a" "b"]))))

(deftest payload
  (let [facts {:query "q" :num-results 3 :context-size "low" :allowed-domains ["x.org"]}
        in-tool (ws/responses-payload facts "m" true)
        in-prompt (ws/responses-payload facts "m" false)]
    (is (= ["model" "instructions" "input" "tools" "tool_choice" "store" "stream"] (keys in-tool)))
    (is (= ["x.org"] (get-in in-tool ["tools" 0 "allowed_domains"])))
    (is (nil? (get-in in-prompt ["tools" 0 "allowed_domains"])))
    (is (re-find #"Restrict sources to these domains when possible:\n- x.org"
                 (get-in in-prompt ["input" 0 "content" 0 "text"])))
    (is (not (re-find #"Restrict" (get-in in-tool ["input" 0 "content" 0 "text"])))))
  (is (= {"content-type" "application/json"} (into {} (ws/request-headers ""))))
  (is (= "Bearer t" (get (ws/request-headers "t") "authorization"))))

(deftest verdicts
  (let [ok {"output" [{"type" "message" "role" "assistant"
                       "content" [{"type" "output_text" "text" "hi [A](https://a.example)"}]}]
            "id" "r1"}]
    (is (= :answer (:kind (ws/attempt-verdict {:status 200 :parsed ok :text "…"} "m" 5))))
    (is (= ["output" "sources" "responseId" "model" "backend"]
           (keys (:response (ws/attempt-verdict {:status 200 :parsed ok} "m" 5)))))
    (is (= {:kind :failed :last-error "boom"} (ws/attempt-verdict {:status 500 :parsed nil :text "boom"} "m" 5)))
    (is (= {:kind :failed :last-error {"e" 1}} (ws/attempt-verdict {:status 429 :parsed {"e" 1} :text "x"} "m" 5)))
    (is (= :empty (:kind (ws/attempt-verdict {:status 200 :parsed {"output" []}} "m" 5))))))

(deftest exa
  (is (= {:output "x [L](https://l.example)" :sources [{"url" "https://l.example" "title" "L"}]}
         (ws/exa-parse-event-stream
          (str "event: m\ndata: {\"result\":{\"content\":[{\"text\":\"x [L](https://l.example)\"}]}}\n")
          #(js->clj (js/JSON.parse %)))))
  (is (= "No search results found. Please try a different query." (:output (ws/exa-parse-event-stream "" js->clj))))
  (testing "an MCP error aborts"
    (is (thrown-with-msg? ExceptionInfo #"Exa MCP error: mcp down"
                          (ws/exa-parse-event-stream "data: {\"error\":{\"message\":\"mcp down\"}}" #(js->clj (js/JSON.parse %))))))
  (testing "null data reproduces the original TypeError message"
    (is (thrown-with-msg? ExceptionInfo #"Cannot read properties of null \(reading 'error'\)"
                          (ws/exa-parse-event-stream "data: null" #(js->clj (js/JSON.parse %)))))))

(deftest failure-body
  (is (= {:status 502 :body {"error" "websearch_failed" "details" "x"}} (ws/failure-response "x")))
  (is (= {"error" "websearch_failed"} (:body (ws/failure-response nil)))))
