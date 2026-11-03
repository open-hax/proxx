(ns proxx.runtime.account-health-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.account-health :as health]))

(set! *warn-on-infer* false)

(defn- credential [account-id]
  #js {:providerId "openai" :accountId account-id :token (str "tok-" account-id) :authType "oauth_bearer"})

(deftest new-accounts-start-with-a-full-health-score-and-sort-ahead-of-degraded-accounts
  (let [sql #js {:unsafe (fn [] (js/Promise.resolve #js []))}
        ^js store (health/create-account-health-store-js sql 5000 "SELECT 1")
        degraded (credential "acct-degraded")
        fresh (credential "acct-fresh")]
    (.recordFailure store degraded 429 "rate_limit")
    (is (= 1 (.getHealthScore store "openai" "acct-fresh")))
    (is (< (.getHealthScore store "openai" "acct-degraded") 1))
    (is (= ["acct-fresh" "acct-degraded"]
           (mapv #(.-accountId %) (array-seq (.sortCredentialsByHealth store #js [degraded fresh])))))))
