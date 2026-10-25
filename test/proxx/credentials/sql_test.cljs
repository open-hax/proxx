(ns proxx.credentials.sql-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials.sql :as sql]))

(defn- hex [n] (apply str (repeat n "a")))

(deftest auth-type-rows
  (doseq [[raw expected] [["oauth" "oauth_bearer"] [" OAuth-Bearer " "oauth_bearer"] ["oauth_bearer" "oauth_bearer"]
                          ["api_key" "api_key"] ["" "api_key"] ["saml" "api_key"]]]
    (is (= expected (sql/normalize-auth-type raw)) (pr-str raw))))

(deftest credentials-from-rows
  (is (= {"providerId" "p" "accountId" "a" "token" "t" "authType" "api_key"}
         (sql/provider-credential {"id" "a" "provider_id" "p" "token" "t" "refresh_token" nil "expires_at" nil} "api_key")))
  (let [c (sql/provider-credential {"id" "a" "provider_id" "p" "token" "t" "refresh_token" "" "expires_at" 1700000000
                                    "chatgpt_account_id" "c" "plan_type" "plus"} "oauth_bearer")]
    (is (= 1700000000000 (get c "expiresAt")) "epoch seconds are scaled")
    (is (= "" (get c "refreshToken")) "an empty (non-null) refresh token is kept"))
  (is (not (contains? (sql/provider-credential {"id" "a" "provider_id" "p" "token" "t" "expires_at" "1700000000000"} "api_key") "expiresAt"))
      "bigint-as-string expiries are ignored, as before"))

(deftest legacy-openai-account-ids
  (is (true? (sql/legacy-openai-account-id? (str "acct_" (hex 8)) "acct")))
  (is (not (sql/legacy-openai-account-id? (str "acct_" (hex 7)) "acct")))
  (is (not (sql/legacy-openai-account-id? (str "acct_" (hex 8) "\n") "acct")))
  (is (not (sql/legacy-openai-account-id? "acct_AAAAAAAA" "acct")) "uppercase hex is not a legacy id")
  (is (true? (sql/current-openai-account-id? (str "a.b-" (hex 12)) "a.b")) "regex metacharacters in the id are literal")
  (is (not (sql/current-openai-account-id? (str "axb-" (hex 12)) "a.b"))))

(deftest duplicate-selection
  (let [rows [{"id" (str "c_" (hex 8)) "provider_id" "openai" "chatgpt_account_id" "c"}
              {"id" (str "c-" (hex 12)) "provider_id" "openai" "chatgpt_account_id" "c"}
              {"id" (str "d_" (hex 8)) "provider_id" "openai" "chatgpt_account_id" "d"}
              {"id" (str "e_" (hex 8)) "provider_id" "p2" "chatgpt_account_id" "e"}
              {"id" (str "e-" (hex 12)) "provider_id" "p2" "chatgpt_account_id" "e"}
              {"id" "x" "provider_id" "openai" "chatgpt_account_id" nil}]]
    (is (= [(str "c_" (hex 8))] (sql/legacy-openai-duplicate-ids rows)))))

(deftest scopes-and-roles
  (let [pj (fn [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))]
    (is (= ["a" "b"] (sql/parse-scopes ["a" 1 "b"] pj)))
    (is (= ["x"] (sql/parse-scopes "[\"x\",2]" pj)))
    (is (= [] (sql/parse-scopes "not json" pj)))
    (is (= [] (sql/parse-scopes "{\"a\":1}" pj)))
    (is (= [] (sql/parse-scopes nil pj))))
  (is (= "admin" (sql/normalize-membership-role " Admin ")))
  (is (= "viewer" (sql/normalize-membership-role "root"))))

(deftest ui-session-choice
  (let [m [{"tenantId" "t1" "role" "member"} {"tenantId" "default" "role" "admin"}]
        user {"id" "u" "subject" "s"}]
    (is (= "t1" (get (sql/resolve-ui-session user m "t1" "default") "activeTenantId")))
    (is (= "default" (get (sql/resolve-ui-session user m "zzz" "default") "activeTenantId")) "unknown tenant -> default")
    (is (= "t1" (get (sql/resolve-ui-session user [(first m)] nil "default") "activeTenantId")) "no default -> first")
    (is (nil? (sql/resolve-ui-session user [] nil "default")))))

(deftest bootstrap
  (is (= {:role "owner" :create? true} (sql/bootstrap-role [] "default" {"count" "0"})))
  (is (= {:role "owner" :create? true} (sql/bootstrap-role [] "default" nil)))
  (is (= {:role "admin" :create? true} (sql/bootstrap-role [] "default" {"count" 3})))
  (is (= {:role "admin" :create? true} (sql/bootstrap-role [] "default" {"count" "x"})))
  (is (= {:role "viewer" :create? false} (sql/bootstrap-role [{"tenantId" "default" "role" "viewer"}] "default" nil))))

(deftest user-upsert-and-api-keys
  (is (= ["u" "github" "sub" "l" nil nil nil]
         (sql/user-upsert-params (constantly "u") {"provider" " GitHub " "subject" " Sub " "login" " l " "email" "" "name" nil})))
  (let [called (atom 0)]
    (is (thrown-with-msg? ExceptionInfo #"subject must not be empty"
                          (sql/user-upsert-params #(swap! called inc) {"provider" "g" "subject" "  "})))
    (is (zero? @called) "no uuid is drawn for an invalid subject"))
  (is (= ["proxy:use"] (sql/api-key-scopes [])))
  (is (= ["b"] (sql/api-key-scopes ["" " " "b" 1])))
  (is (thrown-with-msg? ExceptionInfo #"label must not be empty" (sql/normalized-label "  "))))

(deftest cooldown-rows
  (is (= [["p" "a" 5] ["p" "b" 1780632049684] ["p" "c" 12]]
         (sql/cooldown-entries [{"provider_id" "p" "account_id" "a" "cooldown_until" 5}
                                {"provider_id" "p" "account_id" "b" "cooldown_until" "1780632049684"}
                                {"provider_id" "p" "account_id" "x" "cooldown_until" "abc"}
                                {"provider_id" "p" "account_id" "c" "cooldown_until" "12x"}]))))
