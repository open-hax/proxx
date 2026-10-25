(ns proxx.credentials.store-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.credentials.store :as store]))

(def ctx {:derive-metadata (fn [t] (if (= t "jwt") {:email "d@x.y" :plan-type "plus"} {}))})

(defn- norm [raw & [provider-keys]]
  (store/normalize-credentials (assoc ctx :provider-keys provider-keys) raw "openai"))

(deftest masking
  (is (= "ab***yz" (store/mask-secret "abcdwxyz")))
  (is (= "a***a" (store/mask-secret "a")))
  (is (= "abcd...wxyz" (store/mask-secret "abcdefghwxyz")))
  (is (= "***" (store/mask-secret ""))))

(deftest document-shapes
  (is (= ["k1"] (map :token (get-in (norm ["k1" "k1" " " nil]) [:providers "openai" :accounts])))
      "bare array: default provider, deduplicated by token, blanks dropped")
  (is (= ["openai-1" "openai-2"] (map :id (get-in (norm {"keys" ["a" "b"]}) [:providers "openai" :accounts]))))
  (is (= store/empty-state (norm {"providers" 4})))
  (is (= store/empty-state (norm nil)))
  (let [state (norm {"providers" {"p" {"auth" "OAuth" "accounts" [{"id" " i " "access_token" "t" "refresh_token" "" "expires_at" 1700000000}]}}})
        account (first (get-in state [:providers "p" :accounts]))]
    (is (= :oauth-bearer (get-in state [:providers "p" :auth-type])))
    (is (= {:id "i" :token "t" :auth-type :oauth-bearer :refresh-token "" :expires-at 1700000000000} account)
        "an empty refresh token is kept; epoch seconds are scaled")))

(deftest derived-metadata-only-fills-gaps
  (let [account (first (get-in (norm {"providers" {"p" {"auth" "oauth" "accounts" [{"access_token" "jwt" "email" ""}]}}})
                               [:providers "p" :accounts]))]
    (is (= "" (:email account)) "a blank string stops the ?? chain, as in the legacy store")
    (is (= "plus" (:plan-type account)))))

(deftest unknown-auth-falls-back-to-api-key
  (doseq [raw [nil "" "saml" 5 "API-KEY"]]
    (is (= :api-key (store/normalize-auth-type raw)) (pr-str raw))))

(deftest provider-order-follows-javascript-object-keys
  (is (= ["2" "10" "b" "a"] (store/ordered-provider-ids ["b" "10" "a" "2"])))
  (let [state (norm {"providers" {"b" {"accounts" ["x"]} "10" {"accounts" ["y"]}}} ["10" "b"])]
    (is (= ["10" "b"] (map :id (store/providers-in-order state))))))

(deftest persisted-shape-is-pinned
  (let [state (-> store/empty-state
                  (store/upsert-api-key-account "d" "p" "a1" "k1")
                  (store/upsert-oauth-account "d" "o" "a2" "t" {:refresh-token "r" :expires-at 5 :email "e" :plan-type "pro"}))]
    (is (= {"providers" {"p" {"auth" "api_key" "accounts" [{"id" "a1" "api_key" "k1"}]}
                         "o" {"auth" "oauth_bearer" "accounts" [{"id" "a2" "access_token" "t" "refresh_token" "r"
                                                                 "expires_at" 5 "email" "e" "plan_type" "pro"}]}}}
           (store/persisted-json state)))
    (is (= ["id" "access_token" "refresh_token" "expires_at" "email" "plan_type"]
           (keys (first (get-in (store/persisted-json state) ["providers" "o" "accounts"])))) "key order is the file order")))

(deftest upsert-replaces-by-id-or-token-and-retypes-the-provider
  (let [s0 (store/upsert-api-key-account store/empty-state "d" "p" "a" "k")
        s1 (store/upsert-api-key-account s0 "d" "p" "b" "k")
        s2 (store/upsert-oauth-account s1 "d" "p" "c" "t" {})]
    (is (= ["b"] (map :id (get-in s1 [:providers "p" :accounts]))) "same token replaces the earlier account")
    (is (= :oauth-bearer (get-in s2 [:providers "p" :auth-type])))
    (is (= ["d"] (:order (store/upsert-api-key-account store/empty-state "d" "  " "a" "k"))) "blank provider id uses the default")))

(deftest removal
  (let [s (-> store/empty-state
              (store/upsert-api-key-account "d" "p" "a" "k1")
              (store/upsert-api-key-account "d" "p" "b" "k2"))]
    (is (= [false s] (store/remove-account s "d" "p" "zzz")))
    (is (= [false s] (store/remove-account s "d" "nope" "a")))
    (let [[ok s1] (store/remove-account s "d" "p" "a")] (is ok) (is (= ["b"] (map :id (get-in s1 [:providers "p" :accounts])))))
    (let [[_ s1] (store/remove-account s "d" "p" "a") [_ s2] (store/remove-account s1 "d" "p" "b")]
      (is (= store/empty-state s2) "an emptied provider is dropped"))))

(deftest views
  (let [s (store/upsert-oauth-account store/empty-state "d" "p" "id" "abcdefghijkl" {:refresh-token "" :email "e@x"})
        [view] (store/provider-views s false)
        [acct] (:accounts view)
        [rev] (:accounts (first (store/provider-views s true)))]
    (is (= "e@x" (:display-name acct)))
    (is (nil? (:secret acct)))
    (is (not (contains? acct :refresh-token-preview)) "an empty refresh token has no preview")
    (is (= "abcdefghijkl" (:secret rev)))
    (is (= "" (:refresh-token rev)) "revealed, the empty token is still reported")))
