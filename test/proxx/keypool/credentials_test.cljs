(ns proxx.keypool.credentials-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.epoch :as epoch]
            [proxx.keypool.credentials :as cr]))

(defn- sha256-hex [s]
  (-> (js/require "crypto") (.createHash "sha256") (.update s) (.digest "hex")))

(def ctx {:sha256-hex sha256-hex})

(deftest epoch-normalization
  (is (= 1700000000000 (epoch/normalize-epoch-ms 1700000000)) "seconds are scaled")
  (is (= 1700000000000 (epoch/normalize-epoch-ms 1700000000000)))
  (is (= 1700000000123 (epoch/normalize-epoch-ms 1700000000123.9)) "truncated")
  (is (= 1700000000000 (epoch/normalize-epoch-ms 1700000000.9)))
  (is (= 0 (epoch/normalize-epoch-ms 0)))
  (is (nil? (epoch/normalize-epoch-ms "1700000000")))
  (is (nil? (epoch/normalize-epoch-ms js/NaN)))
  (is (nil? (epoch/normalize-epoch-ms js/Infinity)))
  (is (nil? (epoch/normalize-epoch-ms nil))))

(deftest provider-id-and-auth-type
  (is (= "x" (cr/normalize-provider-id "  x ")))
  (is (= "default" (cr/normalize-provider-id "   ")))
  (doseq [[raw expected] [[nil :api-key] ["" :api-key] ["  API-KEY " :api-key] ["api_key" :api-key] [5 :api-key]
                          ["oauth" :oauth-bearer] ["OAuth-Bearer" :oauth-bearer] ["oauth_bearer" :oauth-bearer]]]
    (is (= expected (cr/parse-auth-type raw)) (pr-str raw)))
  (is (thrown-with-msg? js/Error #"Unsupported provider auth type: saml" (cr/parse-auth-type "saml"))))

(deftest deterministic-ids-match-the-legacy-derivation
  (is (re-matches #"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
                  (cr/deterministic-account-id sha256-hex "p" "tok")))
  (is (= (cr/deterministic-account-id sha256-hex "p" "tok") (cr/deterministic-account-id sha256-hex "p" "tok")))
  (is (not= (cr/deterministic-account-id sha256-hex "p" "tok") (cr/deterministic-account-id sha256-hex "q" "tok")))
  ;; reference derivation written independently of the implementation under test
  (is (= (let [hex (vec (subs (sha256-hex "openai\u0000sk-test") 0 32))
               v (bit-or (bit-and (js/parseInt (nth hex 16) 16) 3) 8)
               hex (-> hex (assoc 12 "5") (assoc 16 (.toString v 16)))
               s (apply str hex)]
           (str (subs s 0 8) "-" (subs s 8 12) "-" (subs s 12 16) "-" (subs s 16 20) "-" (subs s 20 32)))
         (cr/deterministic-account-id sha256-hex "openai" "sk-test"))))

(deftest account-normalization
  (let [accounts (cr/normalize-accounts
                  ctx "p" :api-key
                  ["  sk-1  "
                   "sk-1"                                           ; duplicate token
                   ""
                   {"key" "sk-2" "id" " two " "plan_type" " PRO " "chatgpt_account_id" " cg "
                    "expires_at" 1700000000 "refresh_token" " rt "}
                   {"api_key" "sk-3" "name" "three"}
                   {"token" "sk-4" "id" "   "}                      ; blank id falls back to derived identity
                   {"nokey" true}
                   42])]
    (is (= ["sk-1" "sk-2" "sk-3" "sk-4"] (mapv :token accounts)))
    (is (= (cr/deterministic-account-id sha256-hex "p" "sk-1") (:account-id (first accounts))))
    (is (= {:provider-id "p" :account-id "two" :token "sk-2" :auth-type :api-key
            :chatgpt-account-id "cg" :plan-type "pro" :expires-at 1700000000000 :refresh-token "rt"}
           (second accounts)))
    (is (= "three" (:account-id (nth accounts 2))))
    (is (= (cr/deterministic-account-id sha256-hex "p" "sk-4") (:account-id (nth accounts 3)))
        "a blank explicit id does not fall through to later id fields (persisted identity stays stable)"))
  (testing "oauth providers prefer access_token"
    (is (= "at" (:token (first (cr/normalize-accounts ctx "p" :oauth-bearer [{"api_key" "k" "access_token" "at"}])))))
    (is (= "k" (:token (first (cr/normalize-accounts ctx "p" :api-key [{"api_key" "k" "access_token" "at"}]))))))
  (is (= [] (cr/normalize-accounts ctx "p" :api-key "nope"))))

(deftest keys-documents
  (let [one #(get-in % ["p" :accounts 0 :token])]
    (is (= "k" (one (cr/parse-providers ctx ["k"] "p"))))
    (is (= "k" (one (cr/parse-providers ctx {"keys" ["k"]} " p "))))
    (is (= {} (cr/parse-providers ctx [] "p")) "an empty document yields no providers (the edge decides if that is fatal)")
    (let [parsed (cr/parse-providers ctx {"providers" {"a" {"auth" "oauth" "accounts" [{"access_token" "t"}]}
                                                      " b " ["k1" "k2"]
                                                      "empty" {"keys" []}}}
                                     "default")]
      (is (= #{"a" "b"} (set (keys parsed))))
      (is (= :oauth-bearer (get-in parsed ["a" :auth-type])))
      (is (= 2 (count (get-in parsed ["b" :accounts]))))
      (is (= 0 (get-in parsed ["b" :next-offset]))))
    (is (thrown-with-msg? js/Error #"expected an array" (cr/parse-providers ctx "str" "p")))
    (is (thrown-with-msg? js/Error #"missing top-level \"providers\"" (cr/parse-providers ctx {"other" 1} "p")))
    (is (thrown-with-msg? js/Error #"Unsupported provider auth type" (cr/parse-providers ctx {"providers" {"a" {"auth" "x" "keys" ["k"]}}} "p")))))

(deftest merging-provider-states
  (let [s1 {:auth-type :api-key :next-offset 3 :accounts [{:token "a" :account-id "1"} {:token "b" :account-id "2"}]}
        s2 {:auth-type :oauth-bearer :next-offset 0 :accounts [{:token "b" :account-id "9"} {:token "c" :account-id "3"}]}]
    (is (= {:auth-type :api-key :next-offset 3 :accounts [{:token "a" :account-id "1"} {:token "b" :account-id "2"} {:token "c" :account-id "3"}]}
           (cr/merge-provider-states s1 s2)))
    (is (= s1 (cr/merge-provider-states s1 nil)))
    (is (= s2 (cr/merge-provider-states nil s2)))))

(deftest account-store-providers
  (let [a1 {:provider-id "p" :account-id "1" :token "t" :auth-type :oauth-bearer}]
    (is (= {"p" {:auth-type :api-key :accounts [a1] :next-offset 0}
            "q" {:auth-type :oauth-bearer :accounts [a1] :next-offset 0}}
           (cr/providers-from-account-store {"p" {:auth-type :api-key} "empty" {:auth-type :api-key}}
                                            {"p" [a1] "q" [a1]}))
        "declared auth type wins, else the first account's; providers without accounts vanish")))

(deftest env-seeding-follows-the-seed-contracts
  (let [specs [{:provider-id-env-names ["ZAI_PROVIDER_ID" "ZHIPU_PROVIDER_ID"] :provider-id-fallback "zai"
                :key-env-names ["ZAI_API_KEY" "ZHIPU_API_KEY"]}
               {:provider-id-env-names ["X_PROVIDER_ID"] :provider-id-fallback "x" :key-env-names ["X_KEY"]}]
        seeded (cr/env-provider-states ctx specs {"ZAI_API_KEY" "   " "ZHIPU_API_KEY" " zk " "ZHIPU_PROVIDER_ID" " custom "})]
    (is (= #{"custom"} (set (keys seeded))) "first non-blank key; first non-blank provider-id override; unset seeds absent")
    (let [account (get-in seeded ["custom" :accounts 0])]
      (is (= "zk" (:token account)))
      (is (= :api-key (:auth-type account)))
      (is (= (cr/deterministic-account-id sha256-hex "custom" "zk") (:account-id account)))))
  (is (= {} (cr/env-provider-states ctx [] {"ANY" "x"}))))

(deftest source-precedence
  (let [st (fn [& tokens] {:auth-type :api-key :next-offset 0
                           :accounts (mapv (fn [t] {:token t :account-id t}) tokens)})
        tokens (fn [m pid] (mapv :token (get-in m [pid :accounts])))]
    (testing "later sources merge into earlier ones"
      (let [merged (cr/merge-sources {:account-store {"p" (st "s")} :file {"p" (st "f") "q" (st "fq")}
                                      :inline {"p" (st "i" "s")} :env {"p" (st "e")} :factory-oauth {"p" (st "o")}})]
        (is (= ["s" "f" "i" "e" "o"] (tokens merged "p")))
        (is (= ["fq"] (tokens merged "q")))))
    (testing "prefer-account-store skips other sources for providers the store owns, but not Factory OAuth"
      (let [merged (cr/merge-sources {:account-store {"p" (st "s")} :file {"p" (st "f") "q" (st "fq")}
                                      :env {"p" (st "e")} :factory-oauth {"p" (st "o")}
                                      :prefer-account-store? true :account-store? true})]
        (is (= ["s" "o"] (tokens merged "p")))
        (is (= ["fq"] (tokens merged "q")))))
    (testing "nothing found"
      (is (= {} (cr/merge-sources {:account-store? true})) "an empty store is acceptable")
      (is (thrown-with-msg? js/Error #"No provider accounts found in keys file or environment"
                            (cr/merge-sources {}))))))
