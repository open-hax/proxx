(ns proxx.runtime.token-refresh-handlers-test
  "Refresh handlers built by the CLJS kernel the TypeScript factories delegate to
  (proxx.runtime.token-refresh); ported from the TypeScript token-refresh-handlers
  tests."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.factory-auth :as fa]
            [proxx.runtime.token-refresh :as tr]))

(set! *warn-on-infer* false)

;; The hooks `token-refresh-handlers.ts` hands the kernel; only the ones a test
;; reaches are real, the others fail loudly if the code under test touches them.
(def ^:private hooks
  #js {:factoryCredentialNeedsRefresh fa/factory-credential-needs-refresh-js
       :isTerminalOpenAiRefreshError (fn [_] (throw (js/Error. "unexpected hook: isTerminalOpenAiRefreshError")))
       :refreshFactoryOAuthToken (fn [_] (throw (js/Error. "unexpected hook: refreshFactoryOAuthToken")))
       :parseJwtExpiry fa/parse-jwt-expiry-js
       :persistFactoryAuthV2 (fn [_ _] (throw (js/Error. "unexpected hook: persistFactoryAuthV2")))
       :toErrorMessage (fn [e] (str e))})

(defn- create-credential [overrides]
  (let [o #js {:providerId "openai" :accountId "acct-1" :token "token-1" :authType "oauth_bearer" :refreshToken "refresh-1"}]
    (doseq [[k v] overrides]
      (if (nil? v) (js-delete o (name k)) (aset o (name k) v)))
    o))

(defn- create-logger []
  (let [info-entries (atom []) warn-entries (atom [])]
    {:info-entries info-entries
     :warn-entries warn-entries
     :logger #js {:info (fn [obj msg] (swap! info-entries conj {:obj obj :msg msg}))
                  :warn (fn [obj msg] (swap! warn-entries conj {:obj obj :msg msg}))}}))

(defn- creds->clj [cs] (mapv js->clj cs))

(deftest ^:async create-ensure-fresh-accounts-refreshes-expired-provider-accounts-and-proactively-refreshes-factory-accounts
  (let [expired-factory (create-credential {:providerId "factory" :accountId "expired-factory"})
        proactive-factory (create-credential {:providerId "factory" :accountId "proactive-factory" :expiresAt (+ (js/Date.now) 60000)})
        skipped-factory (create-credential {:providerId "factory" :accountId "skipped-factory" :expiresAt (+ (js/Date.now) (* 10 60000))})
        refresh-batch-calls (atom [])
        refresh-calls (atom [])
        ensure-fresh-accounts
        (tr/create-ensure-fresh-accounts-js
         #js {:keyPool #js {:getExpiredAccountsWithRefreshTokens
                            (fn [provider-id] (if (= provider-id "factory") #js [expired-factory] #js []))
                            :getAllAccounts
                            (fn [provider-id]
                              (js/Promise.resolve (if (= provider-id "factory") #js [proactive-factory skipped-factory] #js [])))}
              :tokenRefreshManager #js {:refreshBatch (fn [credentials]
                                                        (swap! refresh-batch-calls conj (vec (array-seq credentials)))
                                                        (js/Promise.resolve (.map credentials identity)))
                                        :refresh (fn [credential]
                                                   (swap! refresh-calls conj credential)
                                                   (js/Promise.resolve credential))}
              :shouldRefreshFactoryAccount (fn [credential] (= (.-accountId credential) (.-accountId proactive-factory)))}
         hooks)]
    (await (ensure-fresh-accounts "factory"))
    (is (= [[(js->clj expired-factory)]] (mapv creds->clj @refresh-batch-calls)))
    (is (= [(js->clj proactive-factory)] (creds->clj @refresh-calls)))))

(deftest ^:async create-ensure-fresh-accounts-skips-factory-proactive-refresh-for-non-factory-providers
  (let [expired-openai (create-credential {:providerId "openai" :accountId "expired-openai"})
        refresh-calls (atom [])
        ensure-fresh-accounts
        (tr/create-ensure-fresh-accounts-js
         #js {:keyPool #js {:getExpiredAccountsWithRefreshTokens
                            (fn [provider-id] (if (= provider-id "openai") #js [expired-openai] #js []))
                            :getAllAccounts
                            (fn [] (js/Promise.reject (js/Error. "getAllAccounts should not be called for non-factory providers")))}
              :tokenRefreshManager #js {:refreshBatch (fn [credentials]
                                                        (swap! refresh-calls into (array-seq credentials))
                                                        (js/Promise.resolve (.map credentials identity)))
                                        :refresh (fn [] (js/Promise.reject (js/Error. "refresh should not be called for non-factory providers")))}}
         hooks)]
    (await (ensure-fresh-accounts "openai"))
    (is (= [(js->clj expired-openai)] (creds->clj @refresh-calls)))))

(defn- key-pool-stub []
  #js {:updateAccountCredential (fn [])
       :markRateLimited (fn [])
       :getExpiredAccountsWithRefreshTokens (fn [] #js [])
       :getAllAccounts (fn [] (js/Promise.resolve #js []))})

(deftest ^:async create-open-ai-refresh-handler-returns-null-when-no-refresh-token-exists
  (let [{:keys [info-entries warn-entries logger]} (create-logger)
        handler (tr/create-openai-refresh-handler-js
                 #js {:keyPool (key-pool-stub)
                      :runtimeCredentialStore #js {:upsertOAuthAccount
                                                   (fn [] (js/Promise.reject (js/Error. "upsertOAuthAccount should not be called without refresh token")))}
                      :oauthManager #js {:refreshToken
                                         (fn [] (js/Promise.reject (js/Error. "refreshToken should not be called without refresh token")))}
                      :log logger}
                 hooks)
        result (await (handler (create-credential {:refreshToken nil})))]
    (is (nil? result))
    (is (= 0 (count @info-entries)))
    (is (= 0 (count @warn-entries)))))

(deftest ^:async create-factory-refresh-handler-returns-null-when-no-refresh-token-exists
  (let [{:keys [info-entries warn-entries logger]} (create-logger)
        handler (tr/create-factory-refresh-handler-js
                 #js {:keyPool (key-pool-stub)
                      :runtimeCredentialStore #js {:upsertOAuthAccount
                                                   (fn [] (js/Promise.reject (js/Error. "upsertOAuthAccount should not be called without refresh token")))}
                      :log logger}
                 hooks)
        result (await (handler (create-credential {:providerId "factory" :refreshToken nil})))]
    (is (nil? result))
    (is (= 0 (count @info-entries)))
    (is (= 0 (count @warn-entries)))))
