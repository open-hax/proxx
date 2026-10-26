(ns proxx.http.credentials-test
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is testing]]
            [proxx.http.credentials :as creds]
            [proxx.http.route-path :as route-path]
            [proxx.runtime.routes.credentials :as routes]))

(deftest route-path-join
  (is (= "/api/v1/x" (route-path/join "/api/v1" "/x")))
  (is (= "/api/v1/x" (route-path/join "/api/v1/" "x")))
  (is (= "/api/v1/" (route-path/join "/api/v1" ""))))

(deftest request-parsers
  (testing "api-key: credentialValue wins when it is a string, even blank"
    (is (= {:error "api_key_required"} (creds/api-key-request {"credentialValue" " " "apiKey" "k"} "up")))
    (is (= {:provider-id "up" :api-key "k" :account-id nil} (creds/api-key-request {"apiKey" " k "} "up")))
    (is (= {:provider-id "" :api-key "k" :account-id "a"} (creds/api-key-request {"providerId" "" "credentialValue" "k" "accountId" " a "} "up")))
    (is (= {:error "api_key_required"} (creds/api-key-request "str" "up"))))
  (testing "provider request reports the first missing field"
    (is (= {:error "provider_id_required"} (creds/provider-request {"baseUrl" "u"})))
    (is (= {:error "base_url_required"} (creds/provider-request {"providerId" " p "})))
    (is (= {:provider-id "p" :base-url "u" :api-key "" :account-id nil} (creds/provider-request {"providerId" " p " "baseUrl" "u "}))))
  (testing "account refs need both ids"
    (is (nil? (creds/account-ref {"providerId" "p"})))
    (is (= {:provider-id "p" :account-id "a"} (creds/account-ref {"providerId" " p " "accountId" "a"}))))
  (testing "limits clamp, fall back on junk, and read strings like parseInt"
    (is (= 40 (creds/safe-limit nil 40 200)))
    (is (= 200 (creds/safe-limit "9999" 40 200)))
    (is (= 1 (creds/safe-limit "-3" 40 200)))
    (is (= 1 (creds/safe-limit "0x10" 40 200)))
    (is (= 7 (creds/safe-limit "  7" 40 200)))
    (is (= 40 (creds/safe-limit "abc" 40 200)))
    (is (= 40 (creds/safe-limit ["5" "6"] 40 200)))))

(deftest probe-endpoint
  (is (= {:base-url "https://chatgpt.com/backend-api" :responses-path "/codex/responses"}
         (creds/openai-probe-endpoint " http://localhost:3000 " "/v1/responses")))
  (is (= {:base-url "https://api.openai.com/v1" :responses-path "/x/codex/y"}
         (creds/openai-probe-endpoint "https://api.openai.com/v1" " /x/codex/y ")))
  (is (= "http://localhostx/" (:base-url (creds/openai-probe-endpoint "http://localhostx/" ""))))
  (is (= "https://ollama.com" (creds/ollama-cloud-base-url "  ")))
  (is (= {:status 404 :body {"error" "account_not_found" "detail" "OpenAI account not found: x"}}
         (creds/probe-failure-response "OpenAI account not found: x" "OpenAI account not found:" "account_not_found" "f")))
  (is (= 500 (:status (creds/probe-failure-response "boom" "OpenAI account not found:" "account_not_found" "f")))))

(deftest base-url-inference
  (is (= "https://fwd:1" (creds/infer-base-url {"x-forwarded-host" "fwd:1" "x-forwarded-proto" "https"} "http")))
  (testing "a blank Host header hides the forwarded one, as it always has"
    (is (nil? (creds/infer-base-url {"host" "" "x-forwarded-host" "fwd"} "http"))))
  (is (= "http://h" (creds/infer-base-url {"host" "h"} "http")))
  (is (= "://h" (creds/infer-base-url {"host" "h" "x-forwarded-proto" ""} "http")))
  (is (= "https://r" (creds/redirect-base-url {"redirectBaseUrl" " https://r "} "http://h")))
  (is (= "http://h" (creds/redirect-base-url {"redirectBaseUrl" 3} "http://h"))))

(deftest callback-pages
  (is (= {:error "denied" :description nil} (creds/callback-query {"error" "denied"})))
  (is (= {:state "" :code "c"} (creds/callback-query {"state" ["a" "b"] "code" "c" "error" ""})))
  (let [page (creds/html-error "<b>x</b> & 'q'")]
    (is (str/includes? page "&lt;b&gt;x&lt;/b&gt; &amp; &#39;q&#39;"))
    (is (str/includes? page "Authorization Failed")))
  (is (str/includes? (creds/html-success "ok") "<p>ok</p>"))
  (is (= {:status 200 :headers {"content-type" "text/html"}} (dissoc (creds/html-response "x") :body))))

(deftest reauth-outcomes
  (let [target (creds/openai-reauth-target {"id" "old" "email" "A@x.io"})]
    (is (= {} (creds/openai-reauth-outcome nil {"accountId" "n"} true)))
    (is (= {} (creds/openai-reauth-outcome target {"accountId" "old"} true)))
    (is (= {} (creds/openai-reauth-outcome target {"accountId" "n" "email" "a@x.io"} false)))
    (is (= {:replace? true} (creds/openai-reauth-outcome target {"accountId" "n" "email" "a@x.io"} true)))
    (is (= {:retained? true} (creds/openai-reauth-outcome target {"accountId" "n" "email" "b@x.io"} true))))
  (is (= "Reauthenticated OpenAI account e and replaced old." (creds/openai-success-message {"email" "e"} "old" false)))
  (is (= "Saved Factory.ai OAuth account (f@x)." (creds/factory-success-message {"email" "f@x"})))
  (is (= "Saved Factory.ai OAuth account." (creds/factory-success-message {"email" ""}))))

(deftest visible-providers-merge-key-pool-accounts
  (let [stored [{"id" "openai" "authType" "oauth_bearer"
                 "accounts" [{"id" "b" "authType" "oauth_bearer" "displayName" "" "email" "B@x" "secret" "s"
                              "chatgptAccountId" creds/js-null}
                             {"id" "a" "authType" "api_key" "displayName" "zed"}]}]
        pool [["openai" [{:account-id "b" :auth-type "oauth_bearer" :chatgpt-account-id "ws" :plan-type "plus"}
                         {:account-id "c" :auth-type "oauth_bearer"}]]
              ["empty" []]
              ["zz" [{:account-id "z1" :auth-type "api_key"}]]]
        out (creds/visible-providers stored pool)]
    (is (= ["openai" "zz"] (map #(get % "id") out)))
    (let [accounts (get (first out) "accounts")
          by-id (into {} (map (juxt #(get % "id") identity)) accounts)]
      (is (= ["b" "c" "a"] (map #(get % "id") accounts)) "sorted by lower-cased email, else displayName, else id")
      (is (= 3 (get (first out) "accountCount")))
      (testing "a null field is replaced by the key pool's value; the stored secret survives"
        (is (= "ws" (get (by-id "b") "chatgptAccountId")))
        (is (= "s" (get (by-id "b") "secret")))
        (is (= "ws" (get (by-id "b") "displayName")) "incoming displayName wins when truthy"))
      (is (= "runtime-only" (get (by-id "c") "secretPreview"))))
    (is (= ["b" "c"] (map #(get % "id") (creds/visible-openai-accounts out "openai"))))
    (is (= [] (creds/visible-openai-accounts out "nope")))))

(defn- iso [ms] (when ms (str "t" ms)))

(defn- entry [m] (merge {:provider-id "openai" :account-id "a" :status 200 :timestamp 1000 :prompt-tokens 5000 :cached-prompt-tokens 0} m))

(deftest prompt-cache-audit-groups-and-watches
  (let [watch (for [i (range 4)] (entry {:prompt-cache-key-hash "w" :shape-fingerprint "fp" :timestamp (+ 1000 i) :model (str "m" i)}))
        cross [(entry {:prompt-cache-key-hash "x" :account-id "a"})
               (entry {:prompt-cache-key-hash "x" :account-id "b" :status 500 :timestamp 2000 :model "late"})
               (entry {:prompt-cache-key-hash " " })
               (entry {:prompt-cache-key-hash "o" :provider-id "other"})]
        audit (creds/prompt-cache-audit (concat watch cross) 1 "openai" 9999 iso)
        all (creds/prompt-cache-audit (concat watch cross) 10 "openai" 9999 iso)]
    (is (= {"generatedAt" "t9999" "scannedEntryCount" 8 "distinctHashCount" 2
            "crossAccountHashCount" 1 "crossSuccessfulAccountHashCount" 0}
           (select-keys audit ["generatedAt" "scannedEntryCount" "distinctHashCount" "crossAccountHashCount" "crossSuccessfulAccountHashCount"])))
    (is (= 1 (count (get audit "rows"))))
    (testing "equal successful accounts: more accounts first"
      (is (= ["x" "w"] (map #(get % "promptCacheKeyHash") (get all "rows")))))
    (let [x (first (get all "rows"))]
      (is (= "late" (get x "latestModel")))
      (is (= ["a" "b"] (get x "accountIds")))
      (is (= {"failedRequestCount" 1 "successfulRequestCount" 1 "firstSeenAt" "t1000" "lastSeenAt" "t2000"}
             (select-keys x ["failedRequestCount" "successfulRequestCount" "firstSeenAt" "lastSeenAt"]))))
    (testing "a hash used by one account, one shape, 4+ successes and 10k+ tokens is watched"
      (is (= ["w"] (map #(get % "promptCacheKeyHash") (get all "watchRows")))))))

;; --- routes through a real in-process Fastify --------------------------------

(defn- fake-deps [calls]
  (let [rec (fn [& xs] (swap! calls conj (vec xs)))]
    #js {:config #js {:openaiProviderId "openai" :upstreamProviderId "up"}
         :keyPool #js {:warmup (fn [] (rec :warmup) (js/Promise.reject (js/Error. "ignored")))
                       :disableAccount (fn [p a] (rec :disable p a))
                       :enableAccount (fn [p a] (rec :enable p a))
                       :getDisabledAccounts (fn [] #js [#js {:providerId "p"}])}
         :credentialStore #js {:upsertApiKeyAccount (fn [p a k] (rec :upsert p a (count k)) (js/Promise.resolve nil))
                               :removeAccount (fn [p a] (js/Promise.resolve (= a "known")))}
         :pendingOpenAiBrowserReauthTargets (js/Map.)
         :openAiOAuthManager #js {}
         :log #js {:info (fn [o msg] (rec :log (js->clj o) msg))}}))

(defn- ^:async call [app opts]
  (let [res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res) :json (try (js->clj (.json res)) (catch :default _ nil)) :text (.-payload res)
     :type (aget (.-headers res) "content-type")}))

(deftest ^:async credential-routes
  (let [calls (atom [])
        app ((js/require "fastify"))]
    (routes/register-credential-routes-js app (fake-deps calls) "/api/v1" true)
    (testing "account management validates, persists and survives a failing warmup"
      (is (= {:status 400 :json {"error" "api_key_required"}}
             (select-keys (await (call app {:method "POST" :url "/api/v1/credentials/api-key" :payload #js {}})) [:status :json])))
      (let [res (await (call app {:method "POST" :url "/api/v1/credentials/api-key" :payload #js {:accountId "acc" :apiKey " k "}}))]
        (is (= 201 (:status res)))
        (is (= {"ok" true "providerId" "up" "accountId" "acc"} (:json res))))
      (is (some #{[:upsert "up" "acc" 1]} @calls))
      (is (some #{[:warmup]} @calls)))
    (testing "removing and disabling accounts"
      (is (= 404 (:status (await (call app {:method "DELETE" :url "/api/v1/credentials/account" :payload #js {:providerId "p" :accountId "x"}})))))
      (is (= 200 (:status (await (call app {:method "DELETE" :url "/api/v1/credentials/account" :payload #js {:providerId "p" :accountId "known"}})))))
      (is (= 400 (:status (await (call app {:method "POST" :url "/api/v1/credentials/account/disable" :payload #js {:providerId "p"}})))))
      (is (= {"ok" true "providerId" "p" "accountId" "a" "disabled" true}
             (:json (await (call app {:method "POST" :url "/api/v1/credentials/account/disable" :payload #js {:providerId "p" :accountId "a"}})))))
      (is (= {"disabledAccounts" [{"providerId" "p"}]}
             (:json (await (call app {:method "GET" :url "/api/v1/credentials/accounts/disabled"}))))))
    (testing "the sql-backed provider routes report a missing store"
      (is (= {:status 500 :json {"error" "sql_credential_store_not_available"}}
             (select-keys (await (call app {:method "GET" :url "/api/v1/credentials/provider/x"})) [:status :json])))
      (is (= {:status 501 :json {"error" "oauth_refresh_not_supported"}}
             (select-keys (await (call app {:method "POST" :url "/api/v1/credentials/openai/oauth/refresh" :payload #js {}})) [:status :json]))))
    (testing "OAuth callback pages are 200 text/html, escaped, on both the prefixed and shared paths"
      (doseq [url ["/api/v1/credentials/openai/oauth/browser/callback" "/auth/callback"]]
        (let [res (await (call app {:method "GET" :url (str url "?error=denied&error_description=%3Cb%3E")}))]
          (is (= 200 (:status res)))
          (is (= "text/html" (:type res)))
          (is (str/includes? (:text res) "&lt;b&gt;"))))
      (is (str/includes? (:text (await (call app {:method "GET" :url "/auth/factory/callback"}))) "Missing OAuth callback state or code.")))
    (await (.close app))))

(deftest ^:async shared-callbacks-are-optional
  (let [app ((js/require "fastify"))]
    (routes/register-credential-routes-js app (fake-deps (atom [])) "/api/v1" false)
    (is (= 404 (:status (await (call app {:method "GET" :url "/auth/callback"})))))
    (is (= 200 (:status (await (call app {:method "GET" :url "/api/v1/credentials/openai/oauth/browser/callback"})))))
    (await (.close app))))
