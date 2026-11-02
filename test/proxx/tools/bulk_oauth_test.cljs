(ns proxx.tools.bulk-oauth-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.tools.bulk-oauth :as bo]))

(deftest csv
  (is (= ["a" "b,c" "d\"e" ""] (bo/parse-csv-line "a,\"b,c\",\"d\"\"e\","))
      "commas inside quotes, doubled quotes, a trailing empty field")
  (is (= [{:url "https://openai.com" :username "u@x" :password "p,w"}]
         (bo/parse-csv "url,username,password\r\n\r\n\"https://openai.com\",u@x,\"p,w\"\r\nshort,row\r\n")))
  (is (= [] (bo/parse-csv "header only")))
  (is (= [] (bo/parse-csv ""))))

(deftest planning
  (let [rows [{:url "https://auth.openai.com" :username "A@x" :password "1"}
              {:url "https://google.com" :username "g" :password "2"}
              {:url "chatgpt.com" :username "a@X" :password "3"}
              {:url "chatgpt.com" :username "b" :password "4"}]]
    (is (= ["1" "4"] (map :password (bo/plan rows 0 9999))) "first row per username, case-insensitively")
    (is (= ["3"] (map :password (bo/plan rows 1 1))) "the window applies to OpenAI rows before deduplication")
    (is (= [] (bo/plan rows 5 9999)))
    (is (= {:user "me@gmail.com" :pass "pw"}
           (bo/gmail-credentials [{:url "https://accounts.google.com" :username "Me" :password "pw"}] "ME")))
    (is (nil? (bo/gmail-credentials [{:url "x.com" :username "me" :password "pw"}] "me")))
    (is (thrown? js/Error (bo/gmail-credentials [] "  ")))))

(deftest page-verdicts
  (is (= {:message "OpenAI login page timed out: Oops, an error occurred later" :retryable? true}
         (bo/retryable-page-error "Oops, an error occurred\n   later")))
  (is (true? (:retryable? (bo/retryable-page-error "Authentication Error: unknown_error"))))
  (is (nil? (bo/retryable-page-error "Authentication Error")) "needs unknown_error to be transient")
  (is (= "Wrong password" (bo/post-password-failure "Incorrect email address or password")))
  (is (= "Account locked" (bo/post-password-failure "Your account has been locked")))
  (is (nil? (bo/post-password-failure "ACCOUNT HAS BEEN LOCKED")) "matching is case-sensitive")
  (is (= "Account locked" (bo/post-password-failure "account has been locked")))
  (is (nil? (bo/post-password-failure "fine")))
  (is (= "Verification failed: expired" (bo/waiting-failure "expired")))
  (is (= 100 (count (subs (bo/waiting-failure (apply str "invalid code" (repeat 200 "z"))) (count "Verification failed: ")))))
  (is (= "Account deleted or deactivated" (bo/waiting-failure "You do not have an account")))
  (is (= "OpenAI error page: Oops, an error occurred"
         (bo/waiting-failure (str "Oops, an error occurred" (apply str (repeat 300 " ")) "tail")))
      "excerpt: cut to 200 characters first, then whitespace-collapsed")
  (is (= "OpenAI authentication error: Authentication Error x"
         (bo/waiting-failure "Authentication Error     x")))
  (is (true? (bo/callback-landed? "http://localhost:1455/auth/callback?code=1" 1455)))
  (is (true? (bo/callback-landed? "chrome-error://chromewebdata/" 1455)))
  (is (false? (bo/callback-landed? "http://localhost:3000/" 1455)))
  (is (true? (bo/email-verification-required? "https://x/email-verification" "")))
  (is (true? (bo/email-verification-required? "https://x" "Check your inbox")))
  (is (true? (bo/just-a-moment? "Just a moment...")))
  (is (false? (bo/just-a-moment? "Checking your browser")) "mid-flow polling only waits on \"Just a moment\"")
  (is (true? (bo/cloudflare-title? "Checking your browser"))))

(deftest verification-code
  (is (= "123456" (bo/verification-code "To: Me@X.com\nSubject: Your ChatGPT code is 123456" "me@x.com")))
  (is (= "654321" (bo/verification-code "to me@x.com ... verification code: 654321" "me@x.com")) "loose fallback")
  (is (= "111111" (bo/verification-code "me@x.com Your ChatGPT code is 111111; your code 222222" "me@x.com")) "the subject form wins")
  (is (nil? (bo/verification-code "Your ChatGPT code is 123456" "someone@else.com")) "must be addressed to the recipient")
  (is (nil? (bo/verification-code "me@x.com code is 12345" "me@x.com")) "six digits exactly"))

(deftest config
  (let [c (bo/config {"PROXY_AUTH_TOKEN" "t" "HEADLESS" "true" "OAUTH_CALLBACK_MODE" "capture"
                      "OPENAI_OAUTH_CALLBACK_PORT" "0" "GMAIL_APP_EMAIL" " me@gmail.com "} "/w")]
    (is (= "http://localhost:8789" (:proxy-base c)))
    (is (= 1455 (:callback-port c)) "a non-positive port is the default")
    (is (= :capture (:callback-mode c)))
    (is (true? (:headless? c)))
    (is (= "/w/../../passwords.csv" (:csv-path c)))
    (is (= {:host "imap.gmail.com" :port 993 :gmail-account "me@gmail.com" :user "me@gmail.com" :pass ""}
           (:imap c)))
    (is (= [4000 0 9999 3] ((juxt :delay-ms :start-index :max-accounts :max-login-attempts) c))))
  (testing "INTENTIONAL DIVERGENCE: a blank or non-numeric number is the default (TS: Number(\"\") = 0, Number(\"x\") = NaN)"
    (let [c (bo/config {"DELAY_MS" "" "START_INDEX" "x" "MAX_ACCOUNTS" " "} "/w")]
      (is (= [4000 0 9999] ((juxt :delay-ms :start-index :max-accounts) c)))))
  (is (= :proxy (:callback-mode (bo/config {"OAUTH_CALLBACK_MODE" "other"} "/w")))))

(deftest retries-and-report
  (testing "INTENTIONAL DIVERGENCE: only transient failures are retried (TS retried every failure and could report one account twice)"
    (is (true? (bo/retry? {:retryable? true} 1 3)))
    (is (false? (bo/retry? {:retryable? true} 3 3)) "no attempts left")
    (is (false? (bo/retry? {:retryable? false} 1 3)) "wrong password is not retried")
    (is (false? (bo/retry? {} 1 3))))
  (is (= {:email "a" :status "ok"} (bo/result-entry "a" :ok)))
  (is (= (str "error: " (apply str (repeat 120 "x"))) (:status (bo/result-entry "a" (apply str (repeat 200 "x"))))))
  (is (= {:ok 1 :failed 1 :total 2 :failures [{:email "b" :status "error: no"}]}
         (bo/summary [{:email "a" :status "ok"} {:email "b" :status "error: no"}]))))
