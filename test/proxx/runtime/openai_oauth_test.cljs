(ns proxx.runtime.openai-oauth-test
  "The OpenAI OAuth manager (device polling cache, browser flow, storage ids),
  ported from the TypeScript openai-oauth tests. The manager under test is the
  CLJS kernel `OpenAiOAuthManager` wraps, given the same dependencies the class
  supplies (fetch, clock, callback port, randomness, refresh-error factory)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.oauth :as oauth]
            [proxx.support.keypool :refer [make-jwt]]))

(set! *warn-on-infer* false)

(defn- json-response
  ([payload] (json-response payload 200))
  ([payload status]
   (js/Response. (js/JSON.stringify (clj->js payload))
                 #js {:status status :headers #js {"content-type" "application/json"}})))

(defn- create-manager
  "Same dependency set as the `OpenAiOAuthManager` constructor; `options` is a JS object."
  [options fetch-fn now]
  (oauth/create-openai-oauth-manager-js
   options
   #js {:fetchFn fetch-fn
        :now (or now (fn [] (js/Date.now)))
        :callbackPort "1455"
        :randomBytes (fn [length] (.getRandomValues js/crypto (js/Uint8Array. length)))
        :makeRefreshError (fn [status message _details]
                            (let [e (js/Error. message)] (aset e "status" status) e))}))

(defn- same? [a b] (= (js->clj a) (js->clj b)))

(deftest ^:async device-polling-reuses-cached-authorized-result
  (let [now (atom 1000)
        device-poll-calls (atom 0)
        token-exchange-calls (atom 0)
        fetch-fn (fn ^:async f [input init]
                   (let [url (str input)]
                     (cond
                       (.endsWith url "/api/accounts/deviceauth/usercode")
                       (json-response {"device_auth_id" "device-1" "user_code" "USER-CODE" "interval" "5"})

                       (.endsWith url "/api/accounts/deviceauth/token")
                       (do (swap! device-poll-calls inc)
                           (json-response {"authorization_code" "auth-code-1" "code_verifier" "verifier-1"}))

                       (.endsWith url "/oauth/token")
                       (let [body-text (if (string? (some-> init .-body)) (.-body init) "")]
                         (swap! token-exchange-calls inc)
                         (is (re-find #"code=auth-code-1" body-text))
                         (json-response {"access_token" (make-jwt {"chatgpt_account_id" "acct-1"})
                                         "refresh_token" "refresh-1"
                                         "expires_in" 3600}))

                       :else (throw (js/Error. (str "Unexpected URL: " url))))))
        ^js manager (create-manager #js {} fetch-fn (fn [] @now))]
    (await (.startDeviceFlow manager))
    (let [first-result (await (.pollDeviceFlow manager "device-1" "USER-CODE"))
          second-result (await (.pollDeviceFlow manager "device-1" "USER-CODE"))]
      (is (= "authorized" (.-state first-result)))
      (is (same? second-result first-result))
      (is (= 1 @device-poll-calls))
      (is (= 1 @token-exchange-calls))
      (swap! now + 1000)
      (let [third (await (.pollDeviceFlow manager "device-1" "USER-CODE"))]
        (is (same? third first-result))
        (is (= 1 @device-poll-calls))
        (is (= 1 @token-exchange-calls))))))

(deftest ^:async device-polling-respects-cached-pending-interval
  (let [now (atom 5000)
        device-poll-calls (atom 0)
        fetch-fn (fn ^:async f [input _init]
                   (let [url (str input)]
                     (cond
                       (.endsWith url "/api/accounts/deviceauth/usercode")
                       (json-response {"device_auth_id" "device-2" "user_code" "USER-CODE-2" "interval" "7"})

                       (.endsWith url "/api/accounts/deviceauth/token")
                       (do (swap! device-poll-calls inc)
                           (json-response {"error" "pending"} 403))

                       :else (throw (js/Error. (str "Unexpected URL: " url))))))
        ^js manager (create-manager #js {} fetch-fn (fn [] @now))]
    (await (.startDeviceFlow manager))
    (let [first-result (await (.pollDeviceFlow manager "device-2" "USER-CODE-2"))
          second-result (await (.pollDeviceFlow manager "device-2" "USER-CODE-2"))]
      (is (= {"state" "pending"} (js->clj first-result)))
      (is (= {"state" "pending"} (js->clj second-result)))
      (is (= 1 @device-poll-calls))
      (swap! now + 7001)
      (let [third (await (.pollDeviceFlow manager "device-2" "USER-CODE-2"))]
        (is (= {"state" "pending"} (js->clj third)))
        (is (= 2 @device-poll-calls))))))

(deftest ^:async browser-completion-reuses-cached-callback-result
  (let [token-exchange-calls (atom 0)
        fetch-fn (fn ^:async f [input _init]
                   (let [url (str input)]
                     (if (.endsWith url "/oauth/token")
                       (do (swap! token-exchange-calls inc)
                           (json-response {"id_token" (make-jwt {"chatgpt_account_id" "acct-browser"})
                                           "access_token" "access-browser"
                                           "refresh_token" "refresh-browser"
                                           "expires_in" 1800}))
                       (throw (js/Error. (str "Unexpected URL: " url))))))
        ^js manager (create-manager #js {} fetch-fn nil)
        ^js started (await (.startBrowserFlow manager "http://127.0.0.1:8789"))
        first-result (await (.completeBrowserFlow manager (.-state started) "browser-code"))
        second-result (await (.completeBrowserFlow manager (.-state started) "browser-code"))]
    (is (same? second-result first-result))
    (is (= 1 @token-exchange-calls))))

(deftest ^:async browser-flow-normalizes-loopback-callback-to-localhost-auth-callback-route-on-the-codex-callback-port
  (let [^js manager (create-manager #js {} js/fetch nil)
        ^js started (await (.startBrowserFlow manager "http://127.0.0.1:8789"))]
    (is (= "http://localhost:1455/auth/callback" (.-redirectUri started)))
    (is (re-find #"redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" (.-authorizeUrl started)))
    (is (re-find #"originator=codex_cli_rs" (.-authorizeUrl started)))))

(deftest ^:async browser-flow-defaults-host-routed-inputs-back-to-localhost-callback-topology
  (let [^js manager (create-manager #js {} js/fetch nil)
        ^js started (await (.startBrowserFlow manager "https://a1.federation.test"))]
    (is (= "http://localhost:1455/auth/callback" (.-redirectUri started)))
    (is (re-find #"redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" (.-authorizeUrl started)))))

(deftest ^:async browser-flow-preserves-host-routed-federation-callback-urls-when-explicitly-enabled
  (let [^js manager (create-manager #js {:allowHostRoutedCallbacks true} js/fetch nil)
        ^js started (await (.startBrowserFlow manager "https://a1.federation.test"))]
    (is (= "https://a1.federation.test/auth/callback" (.-redirectUri started)))
    (is (re-find #"redirect_uri=https%3A%2F%2Fa1\.federation\.test%2Fauth%2Fcallback" (.-authorizeUrl started)))))

(deftest ^:async browser-flow-derives-distinct-storage-ids-for-different-identities-on-the-same-chatgpt-account
  (let [token-exchange-calls (atom 0)
        token-responses [{"id_token" (make-jwt {"chatgpt_account_id" "acct-shared" "sub" "user-a"})
                          "access_token" "access-a" "refresh_token" "refresh-a" "expires_in" 1800}
                         {"id_token" (make-jwt {"chatgpt_account_id" "acct-shared" "sub" "user-b"})
                          "access_token" "access-b" "refresh_token" "refresh-b" "expires_in" 1800}]
        fetch-fn (fn ^:async f [input _init]
                   (let [url (str input)]
                     (if (.endsWith url "/oauth/token")
                       (let [payload (get token-responses @token-exchange-calls)]
                         (swap! token-exchange-calls inc)
                         (when-not payload (throw (js/Error. "Unexpected extra token exchange")))
                         (json-response payload))
                       (throw (js/Error. (str "Unexpected URL: " url))))))
        ^js manager (create-manager #js {} fetch-fn nil)
        ^js first-start (await (.startBrowserFlow manager "http://127.0.0.1:8789"))
        ^js second-start (await (.startBrowserFlow manager "http://127.0.0.1:8789"))
        ^js first-result (await (.completeBrowserFlow manager (.-state first-start) "browser-code-1"))
        ^js second-result (await (.completeBrowserFlow manager (.-state second-start) "browser-code-2"))]
    (is (= "acct-shared" (.-chatgptAccountId first-result)))
    (is (= "acct-shared" (.-chatgptAccountId second-result)))
    (is (not= (.-accountId first-result) (.-accountId second-result)))))
