(ns proxx.runtime.account-health-test
  "src/tests/account-health-store.test.ts: the account health edge (the TypeScript AccountHealthStore
  is a shell over `create-account-health-store-js`) with a database that returns no rows."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.account-health :as edge]))

(deftest new-accounts-start-with-a-full-health-score-and-sort-ahead-of-degraded-accounts
  (let [sql #js {:unsafe (fn [] (js/Promise.resolve #js []))}
        ^js store (edge/create-account-health-store-js sql 5000 "SELECT 1")
        degraded #js {:providerId "openai" :accountId "acct-degraded" :token "tok-degraded" :authType "oauth_bearer"}
        fresh #js {:providerId "openai" :accountId "acct-fresh" :token "tok-fresh" :authType "oauth_bearer"}]
    (.recordFailure store degraded 429 "rate_limit")
    (is (= 1 (.getHealthScore store "openai" "acct-fresh")))
    (is (< (.getHealthScore store "openai" "acct-degraded") 1))
    (is (= ["acct-fresh" "acct-degraded"]
           (mapv #(.-accountId ^js %) (array-seq (.sortCredentialsByHealth store #js [degraded fresh])))))))
