(ns proxx.strategy.candidates-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.strategy.candidates :as c]))

(deftest forced-credentials
  (is (= {:provider-id "openai" :account-id "a 1"}
         (c/forced-selection "legacy_admin" {"x-open-hax-forced-provider" " OpenAI " "x-open-hax-forced-account-id" " a 1 "})))
  (is (= {} (c/forced-selection "tenant_api_key" {"x-open-hax-forced-provider" "openai"})) "only the legacy admin may force")
  (is (= {} (c/forced-selection "legacy_admin" {"x-open-hax-forced-provider" "  " "x-open-hax-forced-account-id" 5})))
  (is (= {:provider-id "p"} (c/forced-selection "legacy_admin" {"X-OPEN-HAX-FORCED-PROVIDER" "p"}))))

(deftest synthetic-account
  (is (= {"providerId" "x" "accountId" "x-no-auth" "token" "" "authType" "api_key" "planType" "free"} (c/no-auth-account "x"))))

(deftest affinity-records
  (is (nil? (c/affinities nil)))
  (is (= {:preferred {:provider-id "a" :account-id "1"} :provisional nil}
         (c/affinities {"providerId" "a" "accountId" "1"})))
  (is (= {:provider-id "b" :account-id "2"}
         (:provisional (c/affinities {"providerId" "a" "accountId" "1" "provisionalProviderId" "b" "provisionalAccountId" "2"}))))
  (is (nil? (:provisional (c/affinities {"providerId" "a" "accountId" "1" "provisionalProviderId" "b"})))))
