(ns proxx.http.sessions-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.http.sessions :as sessions]))

(deftest message-input
  (is (= 400 (get-in (sessions/message-input {"content" "  "}) [:response :status])))
  (is (= 400 (get-in (sessions/message-input {"content" 5}) [:response :status])))
  (is (= 400 (get-in (sessions/message-input nil) [:response :status])))
  (is (= {:role "user" :content "hi"} (sessions/message-input {"content" "hi" "role" "bogus" "reasoningContent" 5})))
  (is (= {:role "tool" :content "hi" :reasoning-content "r"}
         (sessions/message-input {"content" "hi" "role" "tool" "reasoningContent" "r"}))))

(deftest search-request
  (is (= {:query "q" :limit 8} (sessions/search-request {"query" " q "})))
  (is (= {:query "" :limit 8} (sessions/search-request {"query" 5})))
  (is (= 50 (:limit (sessions/search-request {"query" "q" "limit" 1e9}))))
  (is (= 1 (:limit (sessions/search-request {"query" "q" "limit" -4}))))
  (is (= 8 (:limit (sessions/search-request {"query" "q" "limit" "abc"}))))
  (is (= 9 (:limit (sessions/search-request {"query" "q" "limit" "9"})))))
