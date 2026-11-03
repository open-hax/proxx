(ns proxx.dashboard.host-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.dashboard.host :as h]
            [proxx.runtime.host-dashboard :as hd]
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

;; ---- src/tests/host-dashboard.test.ts: the JS-facing entry points the TypeScript module delegates to ----

(deftest ts-parse-caddy-routes-extracts-hosts-path-matchers-and-upstreams
  (let [routes (js->clj (hd/parse-caddy-routes-js "
ussy.promethean.rest {
  @api path /v1* /api* /auth* /health
  reverse_proxy @api host.docker.internal:8789
  reverse_proxy host.docker.internal:5174
}

battlebussy.ussy.promethean.rest {
  @backend path /api* /ws*
  reverse_proxy @backend battlebussy-backend:8080
  reverse_proxy battlebussy-site:3000
}
"))]
    (is (= 4 (count routes)))
    (is (= {"host" "battlebussy.ussy.promethean.rest" "matcher" "@backend" "matchPaths" ["/api*" "/ws*"]
            "upstreams" ["battlebussy-backend:8080"]}
           (first (filter #(and (= "battlebussy.ussy.promethean.rest" (get % "host")) (= "@backend" (get % "matcher"))) routes))))
    (is (= {"host" "ussy.promethean.rest" "matcher" nil "matchPaths" [] "upstreams" ["host.docker.internal:5174"]}
           (first (filter #(and (= "ussy.promethean.rest" (get % "host"))
                                (some #{"host.docker.internal:5174"} (get % "upstreams")))
                          routes))))))

(deftest ts-parse-caddy-routes-ignores-block-form-reverse-proxy-directives
  (is (= [] (js->clj (hd/parse-caddy-routes-js "
ussy.promethean.rest {
  @api path /api*
  reverse_proxy @api {
    to host.docker.internal:8789
  }
}
")))))

(deftest ts-load-targets-returns-empty-array-when-unconfigured
  ;; empty when unconfigured to avoid implicit outbound traffic to external hosts
  (is (= 0 (.-length (hd/load-host-dashboard-targets-from-env-js #js {})))))

(deftest ts-load-targets-accepts-configured-json-targets
  (let [targets (hd/load-host-dashboard-targets-from-env-js
                 #js {"HOST_DASHBOARD_TARGETS_JSON"
                      (js/JSON.stringify
                       #js [#js {"id" "prod" "label" "Prod" "baseUrl" "https://ussy.promethean.rest" "authTokenEnv" "HOST_TOKEN_PROD"}
                            #js {"id" "stage" "label" "Stage" "baseUrl" "https://ussy3.promethean.rest" "notes" "staging"}])})]
    (is (= [{"id" "prod" "label" "Prod" "baseUrl" "https://ussy.promethean.rest" "publicHost" nil "authToken" nil
             "authTokenEnv" "HOST_TOKEN_PROD" "notes" nil}
            {"id" "stage" "label" "Stage" "baseUrl" "https://ussy3.promethean.rest" "publicHost" nil "authToken" nil
             "authTokenEnv" nil "notes" "staging"}]
           (js->clj targets)))))

(deftest ts-resolve-token-prefers-target-env-token-and-does-not-fall-back-to-proxy-token
  (is (= "stage-secret"
         (hd/resolve-host-dashboard-target-token-js #js {"id" "stage" "label" "Stage" "authTokenEnv" "HOST_TOKEN_STAGE"}
                                                    #js {"HOST_TOKEN_STAGE" "stage-secret" "PROXY_AUTH_TOKEN" "proxy-secret"})))
  (is (undefined? (hd/resolve-host-dashboard-target-token-js #js {"id" "stage" "label" "Stage"}
                                                             #js {"PROXY_AUTH_TOKEN" "proxy-secret"}))))

(deftest ts-resolve-token-prioritizes-inline-auth-token-over-env-values
  (is (= "inline-secret"
         (hd/resolve-host-dashboard-target-token-js
          #js {"id" "stage" "label" "Stage" "authToken" "inline-secret" "authTokenEnv" "HOST_TOKEN_STAGE"}
          #js {"HOST_TOKEN_STAGE" "env-secret" "PROXY_AUTH_TOKEN" "proxy-secret"}))))

(deftest ts-infer-self-target-id-matches-request-host-to-configured-target
  (is (= "ussy3"
         (hd/infer-self-host-dashboard-target-id-js
          #js {"targets" #js [#js {"id" "ussy" "label" "Prod" "baseUrl" "https://ussy.promethean.rest"}
                              #js {"id" "ussy3" "label" "Stage" "baseUrl" "https://ussy3.promethean.rest"}]
               "requestBaseUrl" "https://ussy3.promethean.rest"}))))

(deftest ts-infer-self-target-id-returns-undefined-when-no-target-matches
  (is (undefined? (hd/infer-self-host-dashboard-target-id-js
                   #js {"targets" #js [#js {"id" "ussy" "label" "Prod" "baseUrl" "https://ussy.promethean.rest"}]
                        "requestBaseUrl" "https://unknown.promethean.rest"}))))
