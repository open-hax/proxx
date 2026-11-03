(ns proxx.web.events-smoke
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(deftest ^:async events-list-and-detail
  (s/stub-fetch! [[#"GET .*/api/v1/settings" {"fastMode" false}]
                  [#"GET .*/api/v1/events/tags" {"tags" {"label:train" 3} "since" "2026-04-01T00:00:00Z"}]
                  [#"GET .*/api/v1/events/ev-1" {"event" {"id" "ev-1" "ts" "2026-04-03T00:00:00Z" "kind" "error" "entryId" "en-1"
                                                          "tags" ["label:train"] "meta" {"a" 1} "payload" {"hello" "world"}}}]
                  [#"GET .*/api/v1/events\?" {"events" [{"id" "ev-1" "ts" "2026-04-03T00:00:00Z" "kind" "error" "entryId" "en-1"
                                                         "providerId" "openai" "model" "gpt-x" "status" 500 "tags" ["label:train"] "meta" {} "payload" nil}]
                                              "count" 1 "totalCount" 1}]])
  (await (s/mount-app! "/events"))
  (await (s/wait-text "Tag counts"))
  (let [t (s/body-text)]
    (is (str/includes? t "openai/-"))
    (is (str/includes? t "gpt-x"))
    (is (str/includes? t "Tag counts"))
    (is (str/includes? t "offset 0 · limit 50 · total 1"))
    (is (str/includes? t "Select an event to inspect its payload.")))
  (.click (.querySelector js/document ".events-row"))
  (await (s/wait-text "en-1"))
  (let [t (s/body-text)]
    (is (str/includes? t "en-1"))
    (is (str/includes? t "\"hello\": \"world\""))))
