(ns proxx.runtime.sql-credential-store-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.credentials.sql :as sql]
            [proxx.runtime.sql-credential-store :as store]))

(defn- fake-sql
  "Records `.unsafe` as [text values] and runs `.begin` callbacks against a recording tx."
  [calls rows-for]
  (let [record (fn [tag] (fn [text values]
                           (swap! calls conj [tag text (some-> values vec)])
                           (js/Promise.resolve (to-array (rows-for text)))))
        sql #js {"unsafe" (record :sql)}]
    (aset sql "begin" (fn [f] (f #js {"unsafe" (record :tx)})))
    sql))

(deftest pure-statement-composition
  (is (= {"text" "S" "values" ["openai"]} (sql/openai-accounts-query "S" "")))
  (is (= {"text" "SELECT x ORDER BY id;" "values" ["openai"]} (sql/openai-accounts-query "SELECT x ORDER BY id;" nil)))
  (is (= {"text" "SELECT x AND chatgpt_account_id = $2 ORDER BY id;" "values" ["openai" "cg"]}
         (sql/openai-accounts-query "SELECT x ORDER BY id;" "cg")))
  (is (= "p:a" (sql/cooldown-key "p" "a")))
  (is (= "p\u0000a" (sql/cooldown-pair-key "p" "a")) "the maps returned to callers use NUL, the cache uses a colon")
  (is (= ["a" "p" "t" nil nil nil nil] (sql/account-insert-params {"accountId" "a" "providerId" "p" "token" "t"})))
  (is (= {"id" "p" "authType" "oauth_bearer" "baseUrl" nil} (sql/provider-by-id {"id" "p" "auth_type" " OAuth " "base_url" nil}))))

(deftest cooldown-cache-follows-persistence
  (async done
    (let [calls (atom [])
          ^js s (store/create-sql-credential-store-js (fake-sql calls (fn [_] [])))]
      (is (undefined? (.getCooldown s "p" "a")))
      (.setCooldown s "p" "a" 5)
      (is (= 5 (.getCooldown s "p" "a")))
      (-> (.clearCooldown s "p" "a")
          (.then (fn [_]
                   (is (undefined? (.getCooldown s "p" "a")))
                   (is (= [[:sql "DELETE FROM account_cooldown WHERE provider_id = $1 AND account_id = $2" ["p" "a"]]] @calls))
                   (.persistCooldown s "p" "a" 9)))
          (.then (fn [_] (is (= 9 (.getCooldown s "p" "a"))) (done)))))))

(deftest remove-account-is-one-transaction
  (async done
    (let [calls (atom [])
          ^js s (store/create-sql-credential-store-js (fake-sql calls (fn [text] (if (.includes text "RETURNING id") [#js {"id" "a"}] []))))]
      (.setCooldown s "p" "a" 5)
      (-> (.removeAccount s "p" "a")
          (.then (fn [removed?]
                   (is (true? removed?))
                   (is (= [[:tx "DELETE FROM accounts WHERE id = $1 AND provider_id = $2 RETURNING id" ["a" "p"]]
                           [:tx "DELETE FROM account_cooldown WHERE provider_id = $1 AND account_id = $2" ["p" "a"]]
                           [:tx "DELETE FROM account_health WHERE provider_id = $1 AND account_id = $2" ["p" "a"]]]
                          @calls))
                   (is (undefined? (.getCooldown s "p" "a")) "cache cleared only after the commit")
                   (done)))))))

(deftest api-keys-and-users-reject-blank-input-as-plain-errors
  (async done
    (let [calls (atom [])
          ^js s (store/create-sql-credential-store-js (fake-sql calls (fn [_] [])))]
      (-> (.createTenantApiKey s "t" "  " #js [] "pepper")
          (.then (fn [_] (is false) (done))
                 (fn [e]
                   (is (= "tenant api key label must not be empty" (.-message e)))
                   (is (nil? (ex-data e)))
                   (is (empty? @calls) "nothing was written")
                   (done)))))))
