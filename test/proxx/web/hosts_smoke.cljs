(ns proxx.web.hosts-smoke
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(deftest ^:async hosts-page-renders
  (s/stub-fetch! [[#"GET .*/api/v1/settings" {"fastMode" false}]
                  [#"GET .*/api/v1/hosts/overview" {"generatedAt" "2026-04-03T00:00:00Z" "selfTargetId" "host-a"
                    "hosts" [{"id" "host-a" "label" "Host A" "source" "local" "fetchedAt" "x" "reachable" true
                              "baseUrl" "http://host-a.local" "errors" []
                              "containers" [{"id" "c1" "name" "proxx" "image" "proxx:latest" "state" "running" "status" "Up" "ports" ["8789/tcp"]}]
                              "routes" [{"host" "proxx.local" "matchPaths" ["/api"] "upstreams" ["http://127.0.0.1:8789"]}]
                              "summary" {"containerCount" 1 "runningCount" 1 "healthyCount" 1 "routeCount" 1}}]}]])
  (await (s/mount-app! "/hosts"))
  (await (s/wait-text "proxx:latest"))
  (let [t (s/body-text)]
    (is (str/includes? t "Promethean ussy host dashboard"))
    (is (str/includes? t "Host A"))
    (is (str/includes? t "proxx:latest"))
    (is (str/includes? t "This console"))
    (is (str/includes? t "Live"))
    (is (str/includes? t "proxx.local"))
    (is (str/includes? t "8789/tcp"))
    (is (str/includes? t "1/1 reachable hosts") "hero stat value+label")))
