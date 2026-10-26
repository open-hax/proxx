(ns proxx.mcp.seed-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.url :as url]
            [proxx.mcp.seed :as seed]))

(deftest tool-seed-follows-the-model-family
  (let [enabled (fn [model] (into {} (map (juxt :id :enabled)) (seed/tool-seed-for-model model)))]
    (is (true? (get (enabled "GPT-5") "apply_patch")))
    (is (false? (get (enabled "GPT-5") "edit")))
    (is (false? (get (enabled "gpt-oss-20b") "apply_patch")))
    (is (true? (get (enabled "gpt-4o") "write")))
    (is (true? (get (enabled "claude") "bash")))))

(deftest defapp-blocks-are-read-in-order
  (let [text "(clobber.macro/defapp \"a\" {:x (1)}) junk (clobber.macro/defapp \"b\" {:y 1}"]
    (is (= [{:name "a" :body "(clobber.macro/defapp \"a\" {:x (1)})"}
            {:name "b" :body "(clobber.macro/defapp \"b\" {:y 1}"}]
           (seed/defapp-blocks text)))
    (is (= [] (seed/defapp-blocks "(clobber.macro/defapp \"unterminated")))))

(deftest mcp-detection-and-seed-shape
  (is (= {:id "mcp-x" :script "s.js" :args ["a" "b"] :source-file "f" :running false :cwd "/c" :port 3001}
         (seed/mcp-seed "mcp-x" ":script \"s.js\" :cwd \"/c\" :args [\"a\" \"b\"] :PORT \"3001\"" "f")))
  (testing "a port of 0 counts as none, and a service-url list is not a server"
    (is (nil? (:port (seed/mcp-seed "x" ":script \"mcp.js\" :PORT \"0\"" "f"))))
    (is (nil? (seed/mcp-seed "x" ":MCP_SERVICE_URLS \"u\" :MCP_INTERNAL_SHARED_SECRET \"s\" :PORT \"1\"" "f")))
    (is (some? (seed/mcp-seed "x" ":MCP_INTERNAL_SHARED_SECRET \"s\" :PORT \"1\"" "f"))))
  (is (= ["a" "b"] (map :id (seed/dedupe-and-sort [{:id "b"} {:id "a"} {:id "b"}])))))

(deftest join-url
  (is (= "https://a.b/chat" (url/join-url "https://a.b//" "chat")))
  (is (= "https://a.b/V1/chat" (url/join-url "https://a.b/V1/" "/v1/chat")))
  (is (= "https://a.b/v1x" (url/join-url "https://a.b" "/v1x")))
  (is (= "https://a.b/v1/v1x" (url/join-url "https://a.b/v1" "/v1x"))))
