(ns proxx.runtime.quota-monitor-test
  "src/tests/quota-monitor.test.ts: the quota monitor edge against a stubbed global fetch."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.quota-monitor :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")

(defn- credential-store [accounts]
  #js {:listProviders
       (fn []
         (js/Promise.resolve
          #js [#js {:id "openai" :authType "oauth_bearer" :accountCount (count accounts)
                    :accounts (to-array
                               (map (fn [{:keys [id token]}]
                                      #js {:id id :authType "oauth_bearer" :displayName id
                                           :secretPreview (str (subs token 0 3) "***") :secret token})
                                    accounts))}]))
       :upsertApiKeyAccount (fn [] (js/Promise.resolve js/undefined))
       :upsertOAuthAccount (fn [] (js/Promise.resolve js/undefined))
       :removeAccount (fn [] (js/Promise.resolve false))})

(def logger #js {:info (fn []) :warn (fn []) :error (fn [])})

(defn- json-response [payload]
  (js/Response. (js/JSON.stringify (clj->js payload))
                #js {:status 200 :headers #js {"content-type" "application/json"}}))

(defn- authorization [init] (.get (js/Headers. (.-headers ^js init)) "authorization"))

(defn- with-fetch
  "Install `f` as globalThis.fetch for the duration of the promise returned by `body`."
  [f body]
  (let [original (.-fetch js/globalThis)]
    (aset js/globalThis "fetch" f)
    (-> (js/Promise.resolve) (.then body)
        (.finally (fn [] (aset js/globalThis "fetch" original))))))

(deftest ^:async openai-limit-reached-accounts-are-exhausted-and-get-quota-reset-cooldowns
  (let [exhausted (atom [])
        cooldowns (atom [])
        health #js {:recordQuotaExhausted (fn [_ account-id] (swap! exhausted conj account-id))
                    :resetQuotaExhausted (fn [])}]
    (await
     (with-fetch
       (fn [_ init]
         (is (= "Bearer token-a" (authorization init)))
         (js/Promise.resolve
          (json-response {:usage {:rate_limit {:allowed false :limit_reached true
                                               :primary_window {:remaining_percent 72 :limit_window_seconds 18000
                                                                :reset_after_seconds 7200}}}})))
       (fn ^:async run []
         (let [^js monitor (edge/create-quota-monitor-js
                            manifest (credential-store [{:id "acct-a" :token "token-a"}]) logger
                            #js {:providerId "openai"} health
                            #js {:setAccountCooldownUntil (fn [provider-id account-id until]
                                                            (swap! cooldowns conj {:provider-id provider-id :account-id account-id :until until}))
                                 :clearAccountCooldown (fn [])})]
           (await (.checkQuotas monitor))
           (is (true? (.isAccountExhausted monitor "acct-a")))
           (is (= ["acct-a"] @exhausted))
           (is (= 1 (count @cooldowns)))
           (is (= "openai" (:provider-id (first @cooldowns))))
           (is (= "acct-a" (:account-id (first @cooldowns))))
           (is (> (:until (first @cooldowns)) (+ (js/Date.now) 7100000)))
           (is (>= (or (.getCooldownMs monitor "acct-a") 0) 7100000))))))))

(deftest ^:async clears-quota-cooldowns-when-a-later-scan-observes-a-reset
  (let [resets (atom [])
        cleared (atom [])
        fetch-count (atom 0)
        health #js {:recordQuotaExhausted (fn []) :resetQuotaExhausted (fn [_ account-id] (swap! resets conj account-id))}]
    (await
     (with-fetch
       (fn []
         (swap! fetch-count inc)
         (js/Promise.resolve
          (json-response
           (if (= 1 @fetch-count)
             {:usage {:rate_limit {:allowed false :limit_reached true
                                   :primary_window {:remaining_percent 65 :reset_after_seconds 3600}}}}
             {:usage {:rate_limit {:allowed true :limit_reached false
                                   :primary_window {:remaining_percent 100 :reset_after_seconds 0}}}}))))
       (fn ^:async run []
         (let [^js monitor (edge/create-quota-monitor-js
                            manifest (credential-store [{:id "acct-a" :token "token-a"}]) logger
                            #js {:providerId "openai"} health
                            #js {:setAccountCooldownUntil (fn [])
                                 :clearAccountCooldown (fn [provider-id account-id] (swap! cleared conj (str provider-id ":" account-id)))})]
           (await (.checkQuotas monitor))
           (is (true? (.isAccountExhausted monitor "acct-a")))
           (await (.checkQuotas monitor))
           (is (false? (.isAccountExhausted monitor "acct-a")))
           (is (= ["acct-a"] @resets))
           (is (= ["openai:acct-a"] @cleared))))))))

(deftest ^:async refresh-account-quota-fetches-only-the-targeted-account
  (let [observed (atom [])]
    (await
     (with-fetch
       (fn [_ init]
         (when-let [auth (authorization init)] (swap! observed conj auth))
         (js/Promise.resolve
          (json-response {:usage {:rate_limit {:allowed false :limit_reached true
                                               :primary_window {:reset_after_seconds 5400}}}})))
       (fn ^:async run []
         (let [^js monitor (edge/create-quota-monitor-js
                            manifest (credential-store [{:id "acct-a" :token "token-a"} {:id "acct-b" :token "token-b"}])
                            logger #js {:providerId "openai"} js/undefined js/undefined)
               ^js record (await (.refreshAccountQuota monitor "acct-b"))]
           (is (= "acct-b" (.-accountId record)))
           (is (= ["Bearer token-b"] @observed))
           (is (>= (or (.getCooldownMs monitor "acct-b") 0) 5300000))
           (is (undefined? (.getQuotaStatus monitor "acct-a")))))))))

(deftest ^:async get-cooldown-ms-is-undefined-for-non-exhausted-account-with-reset-windows
  ;; Regression (429): OpenAI quota snapshots always carry reset timestamps even when the account
  ;; is healthy. A transient 429 must not produce a multi-day cooldown from those windows.
  (await
   (with-fetch
     (fn []
       (js/Promise.resolve
        (json-response {:usage {:rate_limit {:allowed true :limit_reached false
                                             :primary_window {:used_percent 34 :reset_after_seconds 168463}}}})))
     (fn ^:async run []
       (let [^js monitor (edge/create-quota-monitor-js
                          manifest (credential-store [{:id "healthy-acct" :token "token-healthy"}])
                          logger #js {:providerId "openai"} js/undefined js/undefined)
             ^js record (await (.refreshAccountQuota monitor "healthy-acct"))]
         (is (false? (.-isExhausted record)) "account should not be exhausted")
         (is (undefined? (.getCooldownMs monitor "healthy-acct"))
             "getCooldownMs should return undefined for non-exhausted account with reset windows")
         (let [raw (.getCooldownMsFromQuota monitor "healthy-acct")]
           (is (and (some? raw) (> raw 86400000))
               "getCooldownMsFromQuota returns the raw reset window (>1 day) regardless of exhaustion")))))))

(deftest ^:async get-cooldown-ms-returns-reset-window-only-when-account-is-actually-exhausted
  (await
   (with-fetch
     (fn []
       (js/Promise.resolve
        (json-response {:usage {:rate_limit {:allowed false :limit_reached true
                                             :primary_window {:used_percent 100 :reset_after_seconds 5400}}}})))
     (fn ^:async run []
       (let [^js monitor (edge/create-quota-monitor-js
                          manifest (credential-store [{:id "exhausted-acct" :token "token-exhausted"}])
                          logger #js {:providerId "openai"} js/undefined js/undefined)]
         (await (.refreshAccountQuota monitor "exhausted-acct"))
         (let [cd (.getCooldownMs monitor "exhausted-acct")]
           (is (some? cd) "getCooldownMs should return a value for exhausted account")
           (is (>= cd 5300000) "cooldown should reflect the reset window (~5400s)")))))))
