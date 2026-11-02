(ns proxx.runtime.factory-oauth-test
  "Factory.ai (WorkOS) OAuth manager: device flow, browser flow, token mapping
  and state pruning. Ported from the TypeScript factory-oauth tests; the manager
  is the CLJS kernel `FactoryOAuthManager` wraps, given the dependencies the
  class supplies (fetch, clock, UUID source)."
  (:require ["node:crypto" :as crypto]
            [cljs.test :refer [deftest is]]
            [proxx.runtime.oauth :as oauth]
            [proxx.support.keypool :refer [make-jwt]]))

(set! *warn-on-infer* false)

(defn- json-response
  ([payload] (json-response payload 200))
  ([payload status]
   (js/Response. (js/JSON.stringify (clj->js payload))
                 #js {:status status :headers #js {"content-type" "application/json"}})))

(defn- create-manager
  "`options` is a JS object (ttls); `fetch-fn` and `now` are the injected deps."
  [options fetch-fn now]
  (oauth/create-factory-oauth-manager-js
   options
   #js {:fetchFn (or fetch-fn js/fetch)
        :now (or now (fn [] (js/Date.now)))
        :randomUUID (fn [] (.randomUUID crypto))}))

(defn- now-s [] (js/Math.floor (/ (js/Date.now) 1000)))

(def ^:private device-response-keys
  (fn [device-code user-code]
    {"device_code" device-code
     "user_code" user-code
     "verification_uri" "https://factory.authkit.app/device"
     "verification_uri_complete" (str "https://factory.authkit.app/device?user_code=" user-code)
     "expires_in" 300
     "interval" 5}))

(defn- device-authorize? [url] (.includes url "/user_management/authorize/device"))
(defn- authenticate? [url] (.includes url "/user_management/authenticate"))

(defn- ^:async rejects-with
  "True when promise `p` rejects with an Error whose message contains `text`."
  [p text]
  (try (await p) false
       (catch :default e (boolean (and (instance? js/Error e) (.includes (.-message e) text))))))

(defn- unexpected-url [url] (throw (js/Error. (str "Unexpected URL: " url))))

;; --- Device flow -----------------------------------------------------------

(deftest ^:async device-flow-start-returns-expected-shape
  (let [^js manager (create-manager
                     #js {}
                     (fn ^:async f [input init]
                       (let [url (str input)]
                         (if (device-authorize? url)
                           (let [body-text (if (string? (some-> init .-body)) (.-body init) "")]
                             (is (re-find #"client_id=client_01HNM792M5G5G1A2THWPXKFMXB" body-text))
                             (json-response (device-response-keys "dc-test-123" "ABCD-EFGH")))
                           (unexpected-url url))))
                     nil)
        ^js result (await (.startDeviceFlow manager))]
    (is (pos? (count (.-verificationUrl result))) "verificationUrl should not be empty")
    (is (= "ABCD-EFGH" (.-userCode result)))
    (is (pos? (count (.-deviceAuthId result))) "deviceAuthId should not be empty")
    (is (= 5000 (.-intervalMs result)))))

(deftest ^:async device-flow-poll-returns-authorized-with-tokens
  (let [fake-access-token (make-jwt {"sub" "user_01TEST" "email" "test@factory.ai" "exp" (+ (now-s) 3600)})
        device-auth-calls (atom 0)
        authenticate-calls (atom 0)
        ^js manager (create-manager
                     #js {}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (cond
                           (device-authorize? url) (do (swap! device-auth-calls inc)
                                                       (json-response (device-response-keys "dc-poll-test" "POLL-CODE")))
                           (authenticate? url) (do (swap! authenticate-calls inc)
                                                   (json-response {"access_token" fake-access-token
                                                                   "refresh_token" "rt-new-refresh"
                                                                   "user" {"id" "user_01TEST" "email" "test@factory.ai"
                                                                           "first_name" "Test" "last_name" "User"}
                                                                   "organization_id" "org_01TEST"}))
                           :else (unexpected-url url))))
                     nil)
        ^js started (await (.startDeviceFlow manager))]
    (is (= 1 @device-auth-calls))
    (let [^js result (await (.pollDeviceFlow manager (.-deviceAuthId started)))]
      (is (= "authorized" (.-state result)))
      (is (= 1 @authenticate-calls))
      (when (= "authorized" (.-state result))
        (let [^js tokens (.-tokens result)]
          (is (= fake-access-token (.-accessToken tokens)))
          (is (= "rt-new-refresh" (.-refreshToken tokens)))
          (is (.startsWith (.-accountId tokens) "factory-"))
          (is (= "test@factory.ai" (.-email tokens)))
          (is (number? (.-expiresAt tokens))))))))

(deftest ^:async device-flow-poll-returns-pending-when-authorization-pending
  (let [now 1000
        ^js manager (create-manager
                     #js {}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (cond
                           (device-authorize? url) (json-response (device-response-keys "dc-pending" "PEND-CODE"))
                           (authenticate? url) (json-response {"error" "authorization_pending"} 400)
                           :else (unexpected-url url))))
                     (fn [] now))
        ^js started (await (.startDeviceFlow manager))
        result (await (.pollDeviceFlow manager (.-deviceAuthId started)))]
    (is (= {"state" "pending"} (js->clj result)))
    ;; Immediate re-poll should return pending from interval throttle
    (let [result2 (await (.pollDeviceFlow manager (.-deviceAuthId started)))]
      (is (= {"state" "pending"} (js->clj result2))))))

(deftest ^:async device-flow-poll-returns-failed-on-expired-token
  (let [^js manager (create-manager
                     #js {}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (cond
                           (device-authorize? url) (json-response (device-response-keys "dc-expired" "EXPI-CODE"))
                           (authenticate? url) (json-response {"error" "expired_token"} 400)
                           :else (unexpected-url url))))
                     nil)
        ^js started (await (.startDeviceFlow manager))
        ^js result (await (.pollDeviceFlow manager (.-deviceAuthId started)))]
    (is (= "failed" (.-state result)))
    (when (= "failed" (.-state result))
      (is (re-find #"expired_token" (.-reason result))))))

(deftest ^:async device-flow-poll-returns-failed-for-unknown-device-auth-id
  (let [^js manager (create-manager #js {} nil nil)
        ^js result (await (.pollDeviceFlow manager "nonexistent-id"))]
    (is (= "failed" (.-state result)))
    (when (= "failed" (.-state result))
      (is (re-find #"Unknown or expired" (.-reason result))))))

(deftest ^:async device-flow-start-throws-on-http-error
  (let [^js manager (create-manager #js {} (fn [& _] (js/Promise.resolve (js/Response. "Service Unavailable" #js {:status 503}))) nil)]
    (is (true? (await (rejects-with (.startDeviceFlow manager) "503"))))))

(deftest ^:async device-polling-reuses-cached-authorized-result
  (let [now 1000
        authenticate-calls (atom 0)
        fake-access-token (make-jwt {"sub" "user_cache" "exp" (+ (now-s) 3600)})
        ^js manager (create-manager
                     #js {}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (cond
                           (device-authorize? url) (json-response (device-response-keys "dc-cache" "CACHE-CODE"))
                           (authenticate? url) (do (swap! authenticate-calls inc)
                                                   (json-response {"access_token" fake-access-token
                                                                   "refresh_token" "rt-cache"
                                                                   "user" {"id" "user_cache" "email" "cache@factory.ai"}}))
                           :else (unexpected-url url))))
                     (fn [] now))
        ^js started (await (.startDeviceFlow manager))
        first-result (await (.pollDeviceFlow manager (.-deviceAuthId started)))
        second-result (await (.pollDeviceFlow manager (.-deviceAuthId started)))]
    (is (= "authorized" (.-state first-result)))
    (is (= (js->clj first-result) (js->clj second-result)))
    (is (= 1 @authenticate-calls))))

;; --- Browser flow ----------------------------------------------------------

(def ^:private callback "http://127.0.0.1:8789/auth/factory/callback")

(deftest browser-flow-start-returns-authorize-url-and-state
  (let [^js manager (create-manager #js {} nil nil)
        ^js result (.startBrowserFlow manager callback)]
    (is (pos? (count (.-authorizeUrl result))) "authorizeUrl should not be empty")
    (is (pos? (count (.-state result))) "state should not be empty")
    (is (re-find #"client_id=client_01HNM792M5G5G1A2THWPXKFMXB" (.-authorizeUrl result)))
    (is (re-find #"response_type=code" (.-authorizeUrl result)))
    (is (re-find #"redirect_uri=" (.-authorizeUrl result)))
    (is (re-find #"state=" (.-authorizeUrl result)))))

(deftest ^:async browser-flow-callback-processes-tokens-correctly
  (let [fake-access-token (make-jwt {"sub" "user_01BROWSER" "email" "browser@factory.ai" "exp" (+ (now-s) 3600)})
        token-exchange-calls (atom 0)
        ^js manager (create-manager
                     #js {}
                     (fn ^:async f [input init]
                       (let [url (str input)]
                         (if (authenticate? url)
                           (let [body-text (if (string? (some-> init .-body)) (.-body init) "")]
                             (swap! token-exchange-calls inc)
                             (is (re-find #"grant_type=authorization_code" body-text))
                             (is (re-find #"client_id=client_01HNM792M5G5G1A2THWPXKFMXB" body-text))
                             (is (re-find #"code=test-auth-code" body-text))
                             (json-response {"access_token" fake-access-token
                                             "refresh_token" "rt-browser-refresh"
                                             "user" {"id" "user_01BROWSER" "email" "browser@factory.ai"
                                                     "first_name" "Browser" "last_name" "User"}}))
                           (unexpected-url url))))
                     nil)
        ^js started (.startBrowserFlow manager callback)
        ^js tokens (await (.completeBrowserFlow manager (.-state started) "test-auth-code"))]
    (is (= 1 @token-exchange-calls))
    (is (= fake-access-token (.-accessToken tokens)))
    (is (= "rt-browser-refresh" (.-refreshToken tokens)))
    (is (.startsWith (.-accountId tokens) "factory-"))
    (is (= "browser@factory.ai" (.-email tokens)))
    (is (number? (.-expiresAt tokens)))))

(deftest ^:async browser-flow-complete-browser-flow-reuses-cached-result
  (let [token-exchange-calls (atom 0)
        fake-access-token (make-jwt {"sub" "user_cached" "exp" (+ (now-s) 3600)})
        ^js manager (create-manager
                     #js {}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (if (authenticate? url)
                           (do (swap! token-exchange-calls inc)
                               (json-response {"access_token" fake-access-token
                                               "refresh_token" "rt-cached"
                                               "user" {"id" "user_cached" "email" "cached@factory.ai"}}))
                           (unexpected-url url))))
                     nil)
        ^js started (.startBrowserFlow manager callback)
        first-result (await (.completeBrowserFlow manager (.-state started) "code-cached"))
        second-result (await (.completeBrowserFlow manager (.-state started) "code-cached"))]
    (is (= (js->clj first-result) (js->clj second-result)))
    (is (= 1 @token-exchange-calls))))

(deftest ^:async browser-flow-complete-browser-flow-throws-on-unknown-state
  (let [^js manager (create-manager #js {} nil nil)]
    (is (true? (await (rejects-with (.completeBrowserFlow manager "nonexistent-state" "some-code") "Unknown or expired"))))))

(deftest ^:async browser-flow-complete-browser-flow-throws-on-token-exchange-failure
  (let [^js manager (create-manager #js {} (fn [& _] (js/Promise.resolve (js/Response. "Unauthorized" #js {:status 401}))) nil)
        ^js started (.startBrowserFlow manager callback)]
    (is (true? (await (rejects-with (.completeBrowserFlow manager (.-state started) "bad-code") "401"))))))

;; --- Token extraction ------------------------------------------------------

(defn- browser-tokens
  "Complete a browser flow whose token exchange answers `payload`; returns the tokens."
  [payload code]
  (let [^js manager (create-manager
                     #js {}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (if (authenticate? url) (json-response payload) (unexpected-url url))))
                     nil)
        ^js started (.startBrowserFlow manager callback)]
    (.completeBrowserFlow manager (.-state started) code)))

(deftest ^:async tokens-without-user-id-generate-a-factory-prefixed-account-id
  (let [^js tokens (await (browser-tokens {"access_token" (make-jwt {"sub" "anon" "exp" (+ (now-s) 3600)})
                                           "refresh_token" "rt-anon"}
                                          "anon-code"))]
    (is (.startsWith (.-accountId tokens) "factory-") (str "Expected factory- prefix, got " (.-accountId tokens)))
    (is (undefined? (.-email tokens)))))

(deftest ^:async tokens-with-user-id-derive-deterministic-account-id
  (let [^js tokens (await (browser-tokens {"access_token" (make-jwt {"sub" "user_01DET" "exp" (+ (now-s) 3600)})
                                           "refresh_token" "rt-det"
                                           "user" {"id" "user_01DET" "email" "det@factory.ai"}}
                                          "det-code"))]
    (is (= "factory-user_01DET" (.-accountId tokens)))))

(deftest ^:async access-token-without-exp-claim-sets-expires-at-to-undefined
  (let [^js tokens (await (browser-tokens {"access_token" (make-jwt {"sub" "no-exp"})
                                           "refresh_token" "rt-no-exp"
                                           "user" {"id" "user_no_exp" "email" "noexp@factory.ai"}}
                                          "noexp-code"))]
    (is (undefined? (.-expiresAt tokens)))))

;; --- State pruning ---------------------------------------------------------

(deftest ^:async device-flow-state-is-pruned-after-ttl
  (let [now (atom 1000)
        ^js manager (create-manager
                     #js {:deviceStateTtlMs 1000}
                     (fn ^:async f [input _init]
                       (let [url (str input)]
                         (if (device-authorize? url)
                           (json-response (device-response-keys "dc-prune" "PRUNE-CODE"))
                           (unexpected-url url))))
                     (fn [] @now))
        ^js started (await (.startDeviceFlow manager))]
    ;; Advance past TTL
    (reset! now 3000)
    ;; After pruning, the device flow state should be gone
    (let [^js result (await (.pollDeviceFlow manager (.-deviceAuthId started)))]
      (is (= "failed" (.-state result)))
      (when (= "failed" (.-state result))
        (is (re-find #"Unknown or expired" (.-reason result)))))))

(deftest ^:async browser-pending-state-is-pruned-after-ttl
  (let [now (atom 1000)
        ^js manager (create-manager #js {:browserStateTtlMs 1000} nil (fn [] @now))
        ^js started (.startBrowserFlow manager callback)]
    ;; Advance past TTL
    (reset! now 3000)
    ;; Trigger pruning by starting another browser flow
    (.startBrowserFlow manager callback)
    ;; Original state should be pruned
    (is (true? (await (rejects-with (.completeBrowserFlow manager (.-state started) "pruned-code") "Unknown or expired"))))))
