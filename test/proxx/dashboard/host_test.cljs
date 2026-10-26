(ns proxx.dashboard.host-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.dashboard.host :as h]
            [proxx.json :as json]))

(deftest caddy-routes
  (let [routes (h/parse-caddy-routes "
ussy.promethean.rest {
  @api path /v1* /api*
  reverse_proxy @api host:8789
  reverse_proxy host:5174
}
a.test, b.test __PUBLIC_HOST__ {
  reverse_proxy x:1 x:1 y:2 # trailing comment
}
")]
    (is (= [{"host" "a.test" "matcher" nil "matchPaths" [] "upstreams" ["x:1" "y:2"]}
            {"host" "b.test" "matcher" nil "matchPaths" [] "upstreams" ["x:1" "y:2"]}
            {"host" "ussy.promethean.rest" "matcher" nil "matchPaths" [] "upstreams" ["host:5174"]}
            {"host" "ussy.promethean.rest" "matcher" "@api" "matchPaths" ["/v1*" "/api*"] "upstreams" ["host:8789"]}]
           routes)
        "sorted by host then upstreams; placeholder hosts dropped; upstreams de-duplicated"))
  (testing "block-form reverse_proxy is ignored and its braces are not counted"
    (is (= [] (h/parse-caddy-routes "s.test {\n reverse_proxy @a {\n  to u:1\n }\n}\n"))))
  (is (= [] (h/parse-caddy-routes "")))
  (is (= ["/r/Caddyfile" "/r/deploy/Caddyfile" "/r/deploy/Caddyfile.template"]
         (h/caddy-candidate-paths ["/r " "" "/r"]))
      "distinct trimmed roots, three candidates each"))

(deftest targets
  (is (= [] (h/parse-targets nil)))
  (is (= [] (h/parse-targets "  ")) "unconfigured means no implicit outbound probes")
  (is (= [{"id" "p" "label" "P" "baseUrl" "https://x.test" "publicHost" nil "authToken" nil "authTokenEnv" "T" "notes" nil}]
         (h/parse-targets (json/write [{"id" " p " "label" "P" "baseUrl" " https://x.test// " "authTokenEnv" "T"} {"id" ""} 5]))))
  (is (thrown-with-msg? js/Error #"must be a JSON array" (h/parse-targets "{}")))
  (is (thrown-with-msg? js/Error #"did not contain any valid targets" (h/parse-targets "[{}]")))
  (let [env {"T" " tok " "E" "  "}]
    (is (= "own" (h/resolve-token {"authToken" "own" "authTokenEnv" "T"} env)))
    (is (= "tok" (h/resolve-token {"authTokenEnv" "T"} env)))
    (is (nil? (h/resolve-token {"authTokenEnv" "E"} env)) "no fallback to any proxy-wide token")
    (is (nil? (h/resolve-token {"authTokenEnv" "MISSING"} env)))))

(deftest self-inference
  (let [targets [{"id" "a" "baseUrl" "https://A.test/x" "publicHost" nil}
                 {"id" "b" "baseUrl" nil "publicHost" "https://b.test:8080"}]]
    (is (= "a" (h/infer-self-id targets {:request-host "a.test"})))
    (is (= "b" (h/infer-self-id targets {:request-base-url "http://B.test:8080/"})))
    (is (= "b" (h/infer-self-id targets {:explicit-self-id " b " :request-host "a.test"})) "explicit id wins when it names a target")
    (is (= "a" (h/infer-self-id targets {:explicit-self-id "zzz" :request-host "a.test"})))
    (is (nil? (h/infer-self-id targets {})) "empty hosts never match")))

(deftest tolerated-malformed-input
  (testing "intentional divergence from the TypeScript: a Docker payload that is not an array is a named error, not `rows.map is not a function`"
    (is (thrown-with-msg? js/Error #"unexpected payload" (h/container-summaries {}))))
  (testing "intentional divergence: rows and port entries that are not objects are summarized, not fatal"
    (is (= [{"id" "unknown" "name" "unknown" "image" "unknown" "state" "unknown" "status" "unknown" "ports" ["tcp"]}]
           (h/container-summaries [{"Ports" [nil]}]))))
  (testing "intentional divergence: a remote container without a string status is simply not healthy"
    (is (= {"containerCount" 2 "runningCount" 1 "healthyCount" 1 "routeCount" 0}
           (h/summarize [{"state" "running" "status" "Up (Healthy)"} {"state" "exited"}] []))))
  (testing "intentional divergence: a JSON null /self body is treated as empty, not as a TypeError message"
    (is (= ["request failed with 500"]
           (get (h/remote-snapshot {"id" "r" "label" "R"} "https://r.test" false 500 nil "t") "errors")))))

(deftest snapshots
  (let [t {"id" "r" "label" "R" "baseUrl" "https://r.test" "publicHost" "r.test" "notes" "n"}]
    (is (= ["denied"] (get (h/remote-snapshot t "https://r.test" false 401 {"error" "denied"} "t") "errors")))
    (let [s (h/remote-snapshot t "https://r.test" true 200 {"label" "  " "reachable" false "errors" ["e" 5] "containers" [{"state" "running" "status" "x"} 5]} "now")]
      (is (= ["R" "now" false ["e"] 1] [(get s "label") (get s "fetchedAt") (get s "reachable") (get s "errors") (get-in s ["summary" "containerCount"])])))
    (is (false? (get (h/local-snapshot t "t" ["docker socket not configured"] [] []) "reachable")))
    (is (true? (get (h/local-snapshot t "t" ["docker socket not configured"] [] [{"host" "h"}]) "reachable"))
        "an error is forgiven when something else was learned")))
