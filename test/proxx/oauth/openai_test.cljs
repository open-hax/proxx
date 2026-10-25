(ns proxx.oauth.openai-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.oauth.flow :as flow]
            [proxx.oauth.openai :as openai]))

(defn- sha256-hex [s]
  (-> (js/require "crypto") (.createHash "sha256") (.update s) (.digest "hex")))

(deftest callback-port-resolution
  (doseq [[raw expected] [[nil "1455"] ["" "1455"] ["  " "1455"] ["abc" "1455"] ["12a" "1455"] ["0" "1455"]
                          ["65536" "1455"] ["65535" "65535"] ["1" "1"] [" 8080 " "8080"] ["01455" "1455"]
                          ["-5" "1455"] ["99999999999999999999" "1455"] [5 "1455"]]]
    (is (= expected (openai/callback-port raw)) (pr-str raw))))

(deftest options-fall-back-on-blank
  (is (= {:oauth-scopes "openid profile email offline_access" :client-id openai/default-client-id
          :issuer "https://auth.openai.com" :client-secret nil}
         (openai/normalize-options {:oauth-scopes "  " :client-id "" :issuer " " :client-secret "  "})))
  (is (= "sec" (:client-secret (openai/normalize-options {:client-secret " sec "})))))

(deftest authorization-params-keep-wire-order
  (is (= ["response_type" "client_id" "redirect_uri" "scope" "code_challenge" "code_challenge_method"
          "id_token_add_organizations" "codex_cli_simplified_flow" "originator" "state"]
         (mapv first (openai/authorization-params {:redirect-uri "r" :challenge "c" :state "s"
                                                   :oauth-scopes "" :client-id "id"}))))
  (is (= "openid profile email offline_access"
         (second (nth (openai/authorization-params {:oauth-scopes " " :client-id "x"}) 3)))))

(deftest token-request-params
  (is (= ["grant_type" "code" "redirect_uri" "client_id" "client_secret" "code_verifier"]
         (mapv first (openai/code-exchange-params {:code "c" :redirect-uri "r" :client-id "i"
                                                   :client-secret "fake" :code-verifier "v"}))))
  (is (= ["grant_type" "code" "redirect_uri" "client_id" "code_verifier"]
         (mapv first (openai/code-exchange-params {:code "c" :redirect-uri "r" :client-id "i" :code-verifier "v"}))))
  (is (= [["grant_type" "refresh_token"] ["refresh_token" "r"] ["client_id" "i"]]
         (openai/refresh-params {:refresh-token "r" :client-id "i"}))))

(deftest pkce-verifier-uses-the-unreserved-alphabet
  (is (= "ABz9-._~A" (openai/pkce-verifier [0 1 51 61 62 63 64 65 66]))
      "one char per byte, index = byte mod 66 (so 66 wraps to A)")
  (is (= 43 (count (openai/pkce-verifier (range 43))))))

(deftest redirect-base-plan
  (is (= :fixed (openai/redirect-base-plan false "example.com")))
  (is (= :rewrite-loopback (openai/redirect-base-plan true " LocalHost ")))
  (is (= :rewrite-loopback (openai/redirect-base-plan true "127.0.0.1")))
  (testing "URL.hostname renders IPv6 with brackets, so the bare ::1 spelling is the only match (legacy behaviour)"
    (is (= :rewrite-loopback (openai/redirect-base-plan true "::1")))
    (is (= :keep (openai/redirect-base-plan true "[::1]"))))
  (is (= :keep (openai/redirect-base-plan true "proxx.example"))))

(def ^:private id-claims
  {"chatgpt_account_id" "acct-1" "sub" " user-1 " "email" " Mixed@Case.IO "})

(deftest identity-is-persisted-so-its-recipe-is-pinned
  (let [id (openai/account-identity sha256-hex 99 id-claims nil)
        expected-digest (subs (sha256-hex "acct-1\u0000sub:user-1") 0 12)]
    (is (= (str "acct-1-" expected-digest) (:account-id id)))
    (is (= "acct-1" (:chatgpt-account-id id)))
    (is (= "mixed@case.io" (:email id)))
    (is (= "user-1" (:subject id))))
  (testing "no subject: the lower-cased email discriminates"
    (is (= (str "a-" (subs (sha256-hex "a\u0000email:x@y.z") 0 12))
           (:account-id (openai/account-identity sha256-hex 0 {"chatgpt_account_id" "a" "email" "X@Y.Z"} nil)))))
  (testing "account but no discriminator: the bare ChatGPT account id"
    (is (= "a" (:account-id (openai/account-identity sha256-hex 0 {"chatgpt_account_id" "a"} nil)))))
  (testing "no account id at all: openai-<now>"
    (is (= "openai-1234" (:account-id (openai/account-identity sha256-hex 1234 nil nil)))))
  (testing "a blank account id stops the ?? chain and then counts as missing"
    (is (= "openai-5" (:account-id (openai/account-identity sha256-hex 5 {"chatgpt_account_id" ""} {"chatgpt_account_id" "acct"}))))))

(deftest claim-lookup-order
  (is (= "from-auth" (openai/account-id-from-claims {"https://api.openai.com/auth" {"chatgpt_account_id" "from-auth"}
                                                     "organizations" [{"id" "org"}]})))
  (is (= "org" (openai/account-id-from-claims {"organizations" [{"id" "org"} {"id" "second"}]})))
  (is (nil? (openai/account-id-from-claims {"organizations" []})))
  (is (nil? (openai/email-from-claims {"email" "  " "https://api.openai.com/profile" {"email" "p@q.r"}}))
      "a blank top-level email shadows the profile email (legacy ?? chain)")
  (is (= "p@q.r" (openai/email-from-claims {"https://api.openai.com/profile" {"email" " P@Q.r "}})))
  (is (= "plus" (openai/plan-type-from-claims {"https://api.openai.com/auth" {"chatgpt_plan_type" "plus"}}))))

(deftest intentional-divergence-non-string-claims-are-ignored
  ;; legacy: a numeric `sub` threw a TypeError, a numeric account id became the
  ;; (non-string) account id or crashed createHash.
  (is (= "openai-7" (:account-id (openai/account-identity sha256-hex 7 {"chatgpt_account_id" 5 "sub" 7} nil))))
  (is (nil? (openai/subject-from-claims {"sub" 7})))
  (is (nil? (openai/email-from-claims {"email" 1}))))

(deftest oauth-tokens-mapping
  (let [tokens {"access_token" "at" "refresh_token" "rt" "expires_in" 3600 "chatgpt_plan_type" "pro"}
        mapped (openai/oauth-tokens sha256-hex 1000 tokens nil {"chatgpt_account_id" "a"})]
    (is (= {:account-id "a" :chatgpt-account-id "a" :access-token "at" :refresh-token "rt"
            :expires-at (+ 1000 3600000) :plan-type "pro"}
           mapped)))
  (testing "optional fields are omitted, not nil"
    (is (= #{:account-id :access-token}
           (set (keys (openai/oauth-tokens sha256-hex 1 {"access_token" "at"} nil nil))))))
  (testing "plan type: response, then id token, then access token; \"\" stops the chain"
    (is (= "id" (:plan-type (openai/oauth-tokens sha256-hex 1 {"access_token" "x"} {"chatgpt_plan_type" "id"} {"chatgpt_plan_type" "ac"}))))
    (is (= "" (:plan-type (openai/oauth-tokens sha256-hex 1 {"access_token" "x" "chatgpt_plan_type" ""} {"chatgpt_plan_type" "id"} nil))))
    (is (= "ac" (:plan-type (openai/oauth-tokens sha256-hex 1 {"access_token" "x"} nil {"chatgpt_plan_type" "ac"})))))
  (testing "expires_in 0 is a real expiry"
    (is (= 1000 (:expires-at (openai/oauth-tokens sha256-hex 1000 {"access_token" "x" "expires_in" 0} nil nil)))))
  (testing "a non-numeric expires_in is ignored"
    (is (not (contains? (openai/oauth-tokens sha256-hex 1 {"access_token" "x" "expires_in" "3600"} nil nil) :expires-at)))))

(deftest expiry-arithmetic
  (is (false? (openai/token-expired? 1000 nil)))
  (is (false? (openai/token-expired? 1000 "5")))
  (is (true? (openai/token-expired? 1000 61000)) "exactly at the buffer boundary is expired")
  (is (false? (openai/token-expired? 1000 61001)))
  (is (true? (openai/token-expired? 1000 1000 0))))

(deftest device-interval
  (doseq [[raw ms] [["5" 5000] ["7" 7000] ["0" 5000] ["-3" 5000] ["abc" 5000] ["" 5000] [5 5000] [nil 5000]
                    [" 12x" 12000] ["1e3" 1000]]]
    (is (= ms (openai/device-interval-ms raw)) (pr-str raw))))

(deftest device-poll-failure-classification
  (is (= [:pending] (openai/device-poll-failure-plan 403)))
  (is (= [:pending] (openai/device-poll-failure-plan 404)))
  (is (= [:failed "OpenAI device authorization poll failed with status 500"] (openai/device-poll-failure-plan 500))))

(deftest refresh-error-facts-and-terminal-classification
  (let [facts (openai/refresh-error-facts 401 "{}" {"error" {"message" "  Bad  " "code" "x" "type" "t"}})]
    (is (= {:status 401 :message "OpenAI token refresh failed with status 401: Bad" :response-body "{}" :code "x" :type "t"}
           facts)))
  (testing "a string error (RFC 6749 style) carries no message"
    (is (= "OpenAI token refresh failed with status 400"
           (:message (openai/refresh-error-facts 400 "{\"error\":\"invalid_grant\"}" {"error" "invalid_grant"})))))
  (testing "intentional divergence: a non-string message is ignored (legacy: TypeError escaped the refresh)"
    (is (= "OpenAI token refresh failed with status 500"
           (:message (openai/refresh-error-facts 500 "" {"error" {"message" 5}})))))
  (is (true? (openai/terminal-refresh-error? {:status 500 :code "refresh_token_reused" :message "m"}))
      "reuse is terminal at any status")
  (is (true? (openai/terminal-refresh-error? {:status 400 :message "OpenAI token refresh failed" :response-body "{\"error\":\"INVALID_GRANT\"}"})))
  (is (true? (openai/terminal-refresh-error? {:status 401 :message "Please try signing in again."})))
  (is (false? (openai/terminal-refresh-error? {:status 500 :message "invalid_grant"})))
  (is (false? (openai/terminal-refresh-error? {:status 429 :message "slow down"}))))

(deftest flow-prune-and-plans
  (let [ttls {:browser-state-ttl-ms 1000 :browser-completion-ttl-ms 1000 :device-state-ttl-ms 1000}
        flows (-> flow/empty-flows
                  (flow/add-browser-pending "old" {:created-at 0})
                  (flow/add-browser-pending "fresh" {:created-at 1500})
                  (flow/add-device-flow "d-old" (flow/new-device-flow 0 5000 {}))
                  (flow/add-device-flow "d-busy" (flow/new-device-flow 0 5000 {})))
        pruned (flow/prune flows 2000 ttls #{"d-busy"})]
    (is (= #{"fresh"} (set (keys (:browser-pending pruned)))))
    (is (= #{"d-busy"} (set (keys (:devices pruned)))) "a poll in flight keeps its flow"))
  (let [flows (-> flow/empty-flows
                  (flow/add-browser-pending "s" {:redirect-uri "r"})
                  (flow/record-browser-completion "done" :tokens 100 50))]
    (is (= [:cached :tokens] (flow/browser-completion-plan flows "done" 149 false)))
    (is (= [:unknown] (flow/browser-completion-plan flows "done" 150 false)) "expiry is exclusive")
    (is (= [:in-flight] (flow/browser-completion-plan flows "s" 0 true)))
    (is (= [:exchange {:redirect-uri "r"}] (flow/browser-completion-plan flows "s" 0 false)))
    (is (= [:unknown] (flow/browser-completion-plan (flow/take-browser-pending flows "s") "s" 0 false))))
  (let [flow (assoc (flow/new-device-flow 0 5000 {}) :next-poll-at 100 :cached-result :r :cached-expires-at 50)]
    (is (= [:cached :r] (flow/device-poll-plan flow 49 false)))
    (is (= [:in-flight] (flow/device-poll-plan flow 50 true)))
    (is (= [:pending] (flow/device-poll-plan flow 99 false)))
    (is (= [:poll] (flow/device-poll-plan flow 100 false)))))

(deftest flow-device-transitions
  (let [flows (flow/add-device-flow flow/empty-flows "d" (flow/new-device-flow 0 5000 {:user-code "u"}))]
    (is (= 6000 (get-in (flow/defer-next-poll flows "d" 1000) [:devices "d" :next-poll-at])))
    (let [slowed (flow/slow-down flows "d" 1000)]
      (is (= 6000 (get-in slowed [:devices "d" :interval-ms])))
      (is (= 7000 (get-in slowed [:devices "d" :next-poll-at]))))
    (is (= flows (flow/defer-next-poll flows "ghost" 1)) "an unknown (dropped) flow is left alone")
    (is (= 1100 (get-in (flow/cache-device-result flows "d" :res 100 1000) [:devices "d" :cached-expires-at])))
    (is (empty? (:devices (flow/drop-device flows "d"))))))
