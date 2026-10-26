(ns proxx.auth.refresh-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.auth.refresh :as r]
            [proxx.runtime.token-refresh :as edge]))

(def cfg {:max-consecutive-failures 3})

(deftest account-keys
  (is (= "p\u0000a" (r/account-key {"providerId" "p" "accountId" "a"})))
  (is (= "undefined\u0000undefined" (r/account-key {})) "absent ids render as JavaScript renders them"))

(deftest backoff
  (is (= [30000 60000 120000 240000 480000 600000 600000] (map r/backoff-ms [1 2 3 4 5 6 7])))
  (let [rec (r/record-failure nil 1000)]
    (is (= {:consecutive-failures 1 :last-failure-at 1000 :backoff-until 31000} rec))
    (is (= 2 (:consecutive-failures (r/record-failure rec 2000)))))
  (testing "an account is backed off only after the failure limit, until the backoff expires"
    (let [rec (fn [n until] {:consecutive-failures n :backoff-until until})]
      (is (false? (r/backed-off? (rec 2 9999) 0 cfg)))
      (is (true? (r/backed-off? (rec 3 9999) 0 cfg)))
      (is (false? (r/backed-off? (rec 3 100) 100 cfg)) "backoffUntil is exclusive")
      (is (false? (r/backed-off? nil 0 cfg))))))

(deftest batching
  (is (= [[1 2] [3 4] [5]] (map vec (r/batches [1 2 3 4 5] 2))))
  (testing "intentional divergence: a non-positive concurrency limit is 1; the TypeScript loop never advanced"
    (is (= [[1] [2]] (map vec (r/batches [1 2] 0))))))

(deftest credentials-after-refresh
  (let [old {"providerId" "openai" "accountId" "a" "token" "t" "authType" "oauth_bearer"
             "chatgptAccountId" "ws" "refreshToken" "rt" "expiresAt" 5 "planType" "plus"}]
    (is (= {"providerId" "openai" "accountId" "a9" "token" "new" "authType" "oauth_bearer"
            "chatgptAccountId" "ws" "planType" nil "refreshToken" "rt" "expiresAt" nil}
           (r/openai-refreshed-credential old {"accountId" "a9" "accessToken" "new"}))
        "workspace and refresh token carry over; plan and expiry come only from the response")
    (is (= "ws2" (get (r/openai-refreshed-credential old {"accountId" "a" "accessToken" "n" "chatgptAccountId" "ws2"}) "chatgptAccountId")))
    (is (= (assoc old "refreshToken" nil) (r/disabled-credential old)))
    (is (true? (r/rate-limit-disabled? old 5)))
    (is (false? (r/rate-limit-disabled? old 4)))
    (is (false? (r/rate-limit-disabled? (dissoc old "expiresAt") 4)))
    (is (= {"providerId" "factory" "accountId" "a" "token" "n" "authType" "oauth_bearer" "refreshToken" "r" "expiresAt" 99}
           (r/factory-refreshed-credential old {"accessToken" "n" "refreshToken" "r"} 99))
        "expiry falls back to the JWT exp")
    (is (= 0 (get (r/factory-refreshed-credential old {"accessToken" "n" "refreshToken" "r" "expiresAt" 0} 99) "expiresAt"))
        "an explicit expiry of 0 is not nullish")))

(deftest ^:async manager-coalesces-and-backs-off
  (let [calls (atom 0)
        logs (atom [])
        outcome (atom :fail)
        logger #js {:info (fn [& _]) :warn (fn [^js o m] (swap! logs conj [(.-accountId o) m]))}
        m (edge/create-token-refresh-manager-js
           (fn [c] (swap! calls inc)
             (js/Promise. (fn [res rej] (js/setTimeout #(if (= :ok @outcome) (res c) (rej (js/Error. "bad"))) 1))))
           logger #js {:maxConsecutiveFailures 2})
        cred #js {:providerId "p" :accountId "a" :token "t"}]
    (let [[a b] (await (js/Promise.all #js [(.refresh m cred) (.refresh m cred)]))]
      (is (nil? a))
      (is (nil? b))
      (is (= 1 @calls) "concurrent refreshes of one account share a call"))
    (await (.refresh m cred))
    (is (= 2 @calls))
    (is (true? (.isAccountBackedOff m cred)) "two failures reach the limit")
    (is (nil? (await (.refresh m cred))))
    (is (= 2 @calls) "a backed-off account is not refreshed")
    (is (= 2 (.-consecutiveFailures ^js (.getFailureRecord m cred))))
    (.clearFailures m cred)
    (reset! outcome :ok)
    (is (some? (await (.refresh m cred))))
    (is (= 0 (.-pendingCount ^js m)))
    (is (= [["a" "token refresh failed"] ["a" "token refresh failed"]] @logs))
    (await (.stopAndWait m))
    (is (nil? (await (.refresh m cred))) "a stopped manager refreshes nothing")))
