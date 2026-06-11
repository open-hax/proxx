(ns proxx.credentials-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials :as credentials]))

(deftest parses-provider-credentials-with-malli-validation
  (let [[status result] (credentials/parse-json-credentials
                         {:providers {:xiaomi {:accounts [{:id "acct-allow"
                                                            :api-key "mimo-token-a"}
                                                           {:id "acct-block"
                                                            :api-key ""}]}}}
                         "xiaomi")]
    (is (= :ok status))
    (is (= [{:provider-id "xiaomi"
             :auth-type "api_key"
             :accounts [{:id "acct-allow"
                         :provider-id "xiaomi"
                         :account-id "acct-allow"
                         :auth-type "api_key"
                         :secret "mimo-token-a"}]}]
           (:providers result)))))

(deftest omits-providers-with-zero-valid-credentials
  (let [[status result] (credentials/parse-json-credentials
                         {:providers {:xiaomi {:accounts [{:id "bad-empty" :api-key ""}
                                                           {:id "bad-missing-token"}]}}}
                         "xiaomi")]
    (is (= :ok status))
    (is (= [] (:providers result)))))

(deftest parses-top-level-keys-with-default-provider
  (let [[status result] (credentials/parse-json-credentials
                         {:keys [{:name "primary" :key "seed-token"}]}
                         "openai")]
    (is (= :ok status))
    (is (= "openai" (get-in result [:providers 0 :provider-id])))
    (is (= "primary" (get-in result [:providers 0 :accounts 0 :account-id])))))

(deftest rejects-invalid-seed-shapes
  (let [[status errors] (credentials/parse-json-credentials
                         {:providers {:xiaomi {:accounts "not-a-vector"}}}
                         "xiaomi")]
    (is (= :error status))
    (is (some? errors))))

(deftest js-wrapper-returns-camel-case-output
  (let [result (js->clj (credentials/parse-json-credentials-js
                         #js {:providers #js {:xiaomi #js {:accounts #js [#js {:id "acct" :apiKey "token"}]}}}
                         "xiaomi")
                        :keywordize-keys true)]
    (is (= "ok" (:status result)))
    (is (= "xiaomi" (get-in result [:providers 0 :providerId])))
    (is (= "acct" (get-in result [:providers 0 :accounts 0 :accountId])))
    (is (= "token" (get-in result [:providers 0 :accounts 0 :token])))))
