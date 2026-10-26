(ns proxx.web.credentials-smoke
  "Credentials flow from web/test/e2e/tools.smoke.ts against the real views."
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private now "2026-04-03T00:00:00.000Z")

(defn- set-input! [el v]
  (let [setter (.-set (js/Object.getOwnPropertyDescriptor js/window.HTMLInputElement.prototype "value"))]
    (.call setter el v)
    (.dispatchEvent el (js/window.Event. "input" #js {:bubbles true}))))

(defn- button [text]
  (some #(when (= text (str/trim (.-textContent %))) %) (array-seq (.querySelectorAll js/document "button"))))

(deftest ^:async credentials-manager
  (s/stub-fetch!
   [[#"GET .*/api/v1/settings" {"fastMode" false}]
    [#"GET .*/api/v1/credentials/accounts/disabled" {"disabledAccounts" []}]
    [#"GET .*/api/v1/credentials/openai/quota" {"generatedAt" now "accounts" []}]
    [#"GET .*/api/v1/credentials/openai/prompt-cache-audit" {"generatedAt" now "scannedEntryCount" 0 "distinctHashCount" 0 "crossAccountHashCount" 0
                                                             "crossSuccessfulAccountHashCount" 0 "rows" []}]
    [#"GET .*/api/v1/credentials" {"providers" [{"id" "openai" "authType" "oauth_bearer" "accountCount" 1
                                                  "accounts" [{"id" "acct-1" "authType" "oauth_bearer" "displayName" "Primary OpenAI"
                                                               "email" "alice@example.com" "secretPreview" "tok-***" "refreshTokenPreview" "refresh-***" "planType" "pro"}]}]
                                   "keyPoolStatuses" {"openai" {"providerId" "openai" "authType" "oauth_bearer" "totalAccounts" 1 "availableAccounts" 1 "cooldownAccounts" 0 "nextReadyInMs" 0}}
                                   "requestLogSummary" {}}]
    [#"GET .*/api/v1/request-logs" {"entries" [{"id" "req-1" "timestamp" 0 "routeKind" "local" "providerId" "openai" "accountId" "acct-1" "authType" "oauth_bearer"
                                                "model" "gpt-5.3-codex" "upstreamMode" "responses" "upstreamPath" "/v1/responses" "status" 200 "latencyMs" 420 "serviceTierSource" "none"}]}]])
  (await (s/mount-app! "/credentials"))
  (await (s/wait-text "Primary OpenAI"))
  (let [t (s/body-text)]
    (is (str/includes? t "Credentials Manager"))
    (is (str/includes? t "Showing 1 of 1 account(s)"))
    (is (str/includes? t "Refresh Codex quotas"))
    (is (str/includes? t "Request Logs"))
    (is (str/includes? t "openai/acct-1")))
  (let [search (.querySelector js/document "input[placeholder='Search accounts, emails, plans, workspace IDs']")]
    (set-input! search "alice@example.com")
    (await (s/wait-text "Showing 1 of 1 account(s)"))
    (set-input! search "no-match-value")
    (await (s/wait-text "Showing 0 of 1 account(s)"))
    (set-input! search "")
    (await (s/wait-text "Showing 1 of 1 account(s)")))
  (.click (button "Refresh Codex quotas"))
  (await (s/wait-text "Codex quotas updated"))
  (is (str/includes? (s/body-text) "Codex quotas updated")))
