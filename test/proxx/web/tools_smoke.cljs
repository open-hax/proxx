(ns proxx.web.tools-smoke
  "Port of web/test/ToolsPage.smoke.test.tsx plus the e2e Tools assertions."
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private routes
  [[#"GET .*/api/v1/settings" {"fastMode" false}]
   [#"GET .*/api/v1/tools\?model=" {"tools" [{"id" "apply_patch" "description" "Patch files safely" "enabled" true}
                                              {"id" "bash" "description" "Run shell commands" "enabled" false}]}]
   [#"GET .*/api/v1/mcp-servers" {"servers" [{"id" "social-publisher" "script" "node ./server.js"
                                              "cwd" "/workspace/x" "args" [] "port" 8799
                                              "sourceFile" "ecosystem.container.config.cjs" "running" false}]}]])

(deftest ^:async tools-page-renders-both-managers
  (s/stub-fetch! routes)
  (await (s/mount-app! "/tools"))
  (let [t (s/body-text)]
    (is (str/includes? t "Tool Manager"))
    (is (str/includes? t "MCP Manager"))
    (is (str/includes? t "Refresh"))
    (is (str/includes? t "apply_patch"))
    (is (str/includes? t "Patch files safely"))
    (is (str/includes? t "disabled"))
    (is (str/includes? t "social-publisher"))
    (is (str/includes? t "cwd: /workspace/x"))
    (is (str/includes? t "port: 8799"))
    (is (str/includes? t "seeded")))
  (is (= "gpt-5.3-codex" (.-value (.querySelector js/document ".tools-model-form input")))
      "default model is shown")
  (is (some #(str/ends-with? (:url %) "/api/v1/tools?model=gpt-5.3-codex") @s/calls)))
