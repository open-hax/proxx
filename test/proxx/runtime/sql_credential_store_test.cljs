(ns proxx.runtime.sql-credential-store-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.credentials.sql :as sql]
            [proxx.runtime.db-schema :as schema]
            [proxx.runtime.sql :as sql-edge]
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

;; --- Ported from src/tests/sql-credential-store.test.ts ------------------------

(deftest select-legacy-open-ai-duplicate-ids-removes-only-legacy-openai-ids-with-current-siblings
  (let [ids-to-delete (sql-edge/legacy-openai-duplicate-ids-js
                       #js [#js {:id "chatgpt-acct-legacy_1a2b3c4d" :provider_id "openai" :chatgpt_account_id "chatgpt-acct-legacy"}
                            #js {:id "chatgpt-acct-legacy-1234abcdef56" :provider_id "openai" :chatgpt_account_id "chatgpt-acct-legacy"}
                            #js {:id "chatgpt-acct-current-abcdef123456" :provider_id "openai" :chatgpt_account_id "chatgpt-acct-current"}
                            #js {:id "chatgpt-acct-other_89abcdef" :provider_id "openai" :chatgpt_account_id "chatgpt-acct-other"}
                            #js {:id "chatgpt-acct-api_01020304" :provider_id "requesty" :chatgpt_account_id "chatgpt-acct-api"}])]
    (is (= ["chatgpt-acct-legacy_1a2b3c4d"] (vec (array-seq ids-to-delete))))))

(deftest upsert-provider-preserves-an-existing-base-url-when-no-replacement-is-provided
  (is (re-find #"base_url = COALESCE\(EXCLUDED\.base_url, providers\.base_url\)"
               (schema/sql-statement-js "UPSERT_PROVIDER"))))

(deftest ^:async sql-credential-store-load-cooldowns-normalizes-bigint-string-cooldowns
  (let [^js s (store/create-sql-credential-store-js
               #js {:unsafe (fn [query]
                              (js/Promise.resolve
                               (if (.includes query "SELECT provider_id, account_id, cooldown_until FROM account_cooldown")
                                 #js [#js {:provider_id "openai" :account_id "acct-1" :cooldown_until "1780632049684"}]
                                 #js [])))})
        cooldowns (await (.loadCooldowns s))]
    (is (= 1780632049684 (.get cooldowns "openai\u0000acct-1")))
    (is (= 1780632049684 (.getCooldown s "openai" "acct-1")))))

(deftest ^:async init-runs-schema-changing-sql-only-through-all-migrations
  ;; Ported from sql-credential-store.test.ts (staging): the store's own statements
  ;; never alter or create tables/indexes; only the declared migrations do.
  (let [calls (atom [])
        ^js s (store/create-sql-credential-store-js
               (fake-sql calls (fn [text]
                                 (cond (.includes text "SELECT 1 FROM schema_version") [#js {"?column?" 1}]
                                       (.includes text "SELECT COUNT(*)::BIGINT AS count") [#js {"count" "1"}]
                                       :else []))))]
    (await (.init s))
    (let [schema-changes (->> @calls (map second) (filter #(re-find #"(?i)\b(?:ALTER|CREATE)\s+(?:TABLE|INDEX)\b" %)))]
      (is (= (mapv #(.-sql ^js %) (array-seq (schema/all-migrations-js))) (vec schema-changes))))))
