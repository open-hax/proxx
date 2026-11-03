(ns proxx.web.credentials-domain-test
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is testing]]
            [proxx.web.credentials :as c]))

(def now (js/Date.parse "2026-04-03T00:00:00Z"))

(deftest text-helpers
  (is (= "abcdefgh…uvwxyz" (c/compact-middle "abcdefghijklmnopqrstuvwxyz")))
  (is (= "short" (c/compact-middle "short")))
  (is (= "abcd…wxyz" (c/compact-middle "abcdefghijklmnopqrstuvwxyz" 4 4)))
  (is (= "Pro Plus" (c/title-case-plan "pro-plus")))
  (is (= "A B C" (c/title-case-plan "a_b  c")))
  (is (nil? (c/title-case-plan nil)))
  (is (nil? (c/title-case-plan "")))
  (is (= "example.com" (c/email-domain "A@Example.com")))
  (is (nil? (c/email-domain "a@")))
  (is (nil? (c/email-domain "nodomain")))
  (is (nil? (c/email-domain nil)))
  (is (= "gemma4:31b" (c/probe-model-for-provider "ollama-cloud")))
  (is (= "gpt-5.2" (c/probe-model-for-provider "openai")))
  (is (= "fast mode" (c/format-service-tier {:serviceTier "x" :serviceTierSource "fast_mode"})))
  (is (= "standard" (c/format-service-tier {})))
  (is (= "federated → p" (c/format-route-label {:routeKind "federated" :routedPeerId "p"}))))

(deftest windows-and-resets
  (is (= "5h window" (c/format-quota-window-label {:limitWindowSeconds 18000} "x")))
  (is (= "7d window" (c/format-quota-window-label {:limitWindowSeconds 604800} "x")))
  (is (= "2m window" (c/format-quota-window-label {:limitWindowSeconds 120} "x")))
  (is (= "61s window" (c/format-quota-window-label {:limitWindowSeconds 61} "x")))
  (is (= "fb" (c/format-quota-window-label {:limitWindowSeconds 0} "fb")))
  (is (= "fb" (c/format-quota-window-label nil "fb")))
  (is (nil? (c/format-reset-summary nil now)))
  (is (nil? (c/format-reset-summary {} now)))
  (is (= "resets in 5m" (c/format-reset-summary {:resetAfterSeconds 330} now)))
  (is (= "resets in 2h 1m" (c/format-reset-summary {:resetAfterSeconds 7260} now)))
  (is (= "resets in 0m" (c/format-reset-summary {:resetAfterSeconds -5} now)))
  (is (= "resets in 3d" (c/format-reset-summary {:resetAfterSeconds (* 3 86400)} now)))
  (is (= "resets in 1h 0m" (c/format-reset-summary {:resetsAt "2026-04-03T01:00:00Z"} now)) "from resetsAt and the clock")
  (is (= "Allowed" (c/format-rate-limit-status {:allowed true})))
  (is (= "Blocked" (c/format-rate-limit-status {:allowed false})))
  (is (= "Blocked" (c/format-rate-limit-status {:limitReached true})))
  (is (= "Unknown" (c/format-rate-limit-status {})))
  (is (= "Unknown" (c/format-rate-limit-status nil)))
  (is (= "No data" (c/format-aggregate-percent nil)))
  (is (= "42%" (c/format-aggregate-percent 41.6)))
  (is (= "4.5%" (c/format-aggregate-percent 4.5)))
  (is (= ["credentials-quota-fill-neutral" "credentials-quota-fill-danger" "credentials-quota-fill-warn" "credentials-quota-fill-warn" "credentials-quota-fill-good"]
         (map c/quota-tone-class [nil 5 10 40 41]))))

(deftest blocked-and-critical
  (is (c/explicitly-blocked? {:rateLimit {:allowed false}}))
  (is (c/explicitly-blocked? {:rateLimit {:limitReached true}}))
  (is (not (c/explicitly-blocked? {:rateLimit {:allowed true}})))
  (is (not (c/explicitly-blocked? {})))
  (is (c/critically-low? {:rateLimit {:allowed true :primaryWindow {:remainingPercent 3}}}))
  (is (c/critically-low? {:fiveHour {:remainingPercent 5}}) "falls back to the five-hour window")
  (is (not (c/critically-low? {:rateLimit {:allowed false :primaryWindow {:remainingPercent 3}}})))
  (is (not (c/critically-low? {:rateLimit {:primaryWindow {:remainingPercent 0}}})))
  (is (not (c/critically-low? {:rateLimit {:primaryWindow {:remainingPercent 6}}}))))

(defn- q [id m] (merge {:providerId "openai" :accountId id :status "ok" :fetchedAt "2026-04-03T00:00:00Z"} m))

(deftest quota-pool
  (is (nil? (c/openai-quota-pool [] now)))
  (is (nil? (c/openai-quota-pool [{:providerId "other" :status "ok"}] now)))
  (let [pool (c/openai-quota-pool
              [(q "a" {:rateLimit {:allowed true :primaryWindow {:remainingPercent 80 :resetAfterSeconds 500 :limitWindowSeconds 18000}}
                       :codeReviewRateLimit {:allowed true :primaryWindow {:remainingPercent 60}}})
               (q "b" {:rateLimit {:allowed false :primaryWindow {:remainingPercent 0 :resetAfterSeconds 100}}
                       :codeReviewRateLimit {:allowed false :primaryWindow {:remainingPercent 20}}})
               (q "c" {:rateLimit {:allowed true :primaryWindow {:remainingPercent 4 :resetAfterSeconds 900}}})
               (q "d" {:status "error"})
               {:providerId "x" :accountId "z" :status "ok"}]
              now)]
    (is (= 4 (:totalAccounts pool)))
    (is (= 3 (:okAccounts pool)))
    (is (= 1 (:errorAccounts pool)))
    (is (= 28 (:generalCombinedRemainingPercent pool)) "(80+0+4)/3")
    (is (= 40 (:codeReviewCombinedRemainingPercent pool)))
    (is (= 2 (:generalAvailableCount pool)))
    (is (= 1 (:generalBlockedCount pool)))
    (is (= 1 (:generalCriticalCount pool)))
    (is (= 2 (:codeReviewAvailableCount pool)) "an account with no code-review bucket is not blocked")
    (is (= 1 (:codeReviewBlockedCount pool)))
    (is (= 100 (:resetAfterSeconds (:nextResetWindow pool))) "soonest reset")
    (is (= "5h window" (:windowLabel pool)))
    (is (= "Primary window" (:codeReviewWindowLabel pool))))
  (is (= "success" (c/pool-badge-variant 51)))
  (is (= "warning" (c/pool-badge-variant 50)))
  (is (= "error" (c/pool-badge-variant 20)))
  (is (= "error" (c/pool-badge-variant nil))))

(deftest quota-views
  (is (= {:label "5h window" :percent-label "30% left" :width "30%" :tone "credentials-quota-fill-warn" :reset "resets in 1m"}
         (c/quota-row-view "5h window" {:remainingPercent 30 :resetAfterSeconds 60} now)))
  (is (= {:label "x" :percent-label "No data" :width "0%" :tone "credentials-quota-fill-neutral" :reset nil}
         (c/quota-row-view "x" {} now)))
  (is (= "100%" (:width (c/quota-row-view "x" {:remainingPercent 250} now))))
  (is (nil? (c/quota-group-view "t" nil nil nil now)))
  (let [g (c/quota-group-view "General rate limit" {:allowed true :primaryWindow {:remainingPercent 3 :limitWindowSeconds 18000}} nil {:remainingPercent 50 :limitWindowSeconds 604800} now)]
    (is (= "warning" (:badge g)))
    (is (= "Critical" (:badge-text g)))
    (is (= ["5h window" "7d window"] (mapv :label (:rows g)))))
  (let [g (c/quota-group-view "g" {:allowed true :primaryWindow {:remainingPercent 90}} nil nil now)]
    (is (= ["success" "Allowed"] ((juxt :badge :badge-text) g))))
  (let [g (c/quota-group-view "g" {:allowed false} nil nil now)]
    (is (= ["error" "Blocked"] ((juxt :badge :badge-text) g)))
    (is (true? (:empty? g)))
    (is (empty? (:rows g))))
  (let [g (c/quota-group-view "g" nil {:remainingPercent 10} nil now)]
    (is (= ["default" "Unknown"] ((juxt :badge :badge-text) g)) "fallback windows without a rate limit")))

(defn- acct [id m] (merge {:id id :displayName id :authType "oauth_bearer" :secretPreview (str "tok-" id)} m))
(defn- provider [id auth accounts] {:id id :authType auth :accountCount (count accounts) :accounts accounts})

(def providers
  [(provider "openai" "oauth_bearer"
             [(acct "b" {:email "Bob@Example.com" :planType "pro" :subject "sub-b"})
              (acct "a" {:email "alice@example.com" :planType "plus" :refreshTokenPreview "r"})
              (acct "c" {:displayName "Carol" :expiresAt (- now 1000)})])
   (provider "vivgrid" "api_key" [(acct "k1" {:authType "api_key" :email "k@other.org"})])])

(deftest flat-search-and-identity
  (let [flat (c/flat-accounts providers)]
    (is (= ["openai:a" "openai:b" "openai:c" "vivgrid:k1"] (mapv c/account-key flat)) "sorted by provider then label")
    (is (str/includes? (c/account-search-blob (first flat)) "alice@example.com"))
    (is (str/includes? (c/account-search-blob (first flat)) "example.com"))
    (is (str/includes? (c/account-search-blob (first flat)) "oauth"))
    (is (str/includes? (c/account-search-blob (first flat)) "plus"))
    (is (= "openai:subject:sub-b" (c/human-identity-key (second flat))))
    (is (= "openai:email:alice@example.com" (c/human-identity-key (first flat))))
    (is (nil? (c/human-identity-key (nth flat 2))))
    (is (= "Bob@Example.com" (c/human-identity-label (second flat))))
    (is (= "sub-b" (c/human-identity-label {:account {:subject "sub-b"}})))
    (is (nil? (c/human-identity-label {:account {}})))))

(deftest reauth-and-duplicates
  (is (true? (c/error-suggests-reauth? "The provided authentication token is expired")))
  (is (true? (c/error-suggests-reauth? " Refresh_Token_Reused ")))
  (is (false? (c/error-suggests-reauth? "timeout")))
  (is (false? (c/error-suggests-reauth? nil)))
  (is (true? (c/has-refresh-token? {:refreshToken "r"})))
  (is (false? (c/has-refresh-token? {:refreshTokenPreview "  "})))
  (let [flat (c/flat-accounts providers)
        diag (c/account-diagnostics flat {"openai:a" {:error "please try signing in again"}} now)]
    (is (= {:needsReauth true :duplicateCount 0} (get-in diag [:byAccount "openai:a"])))
    (is (= {:needsReauth false :duplicateCount 0} (get-in diag [:byAccount "openai:b"])))
    (is (true? (get-in diag [:byAccount "openai:c" :needsReauth])) "expired without a refresh token")
    (is (= 2 (:reauthRequiredCount diag)))
    (is (= 3 (:openAiOauthCount diag)))
    (is (= 2 (:humanIdentifiedOpenAiOauthCount diag)))
    (is (= "No possible duplicate identities detected" (c/duplicate-summary (:duplicateGroups diag)))))
  (let [dupes [(provider "openai" "oauth_bearer" [(acct "x" {:email "same@a.com"}) (acct "y" {:email "SAME@a.com"}) (acct "z" {:subject "s"}) (acct "w" {:subject "s"})
                                                  (acct "u" {:email "u@a.com"}) (acct "v" {:email "u@a.com"}) (acct "t" {:email "t@a.com"}) (acct "r" {:email "t@a.com"})])]
        diag (c/account-diagnostics (c/flat-accounts dupes) {} now)]
    (is (= 4 (count (:duplicateGroups diag))))
    (is (= 2 (get-in diag [:byAccount "openai:x" :duplicateCount])))
    (is (str/ends-with? (c/duplicate-summary (:duplicateGroups diag)) "…") "more than three groups are elided")
    (is (= "Possible duplicates: s…ub (2)" (c/duplicate-summary [{:label "s…ub" :keys [1 2]}])))))

(deftest ordering-and-grouping
  (let [flat (c/flat-accounts providers)
        quota {"openai:a" (q "a" {:rateLimit {:allowed true :primaryWindow {:remainingPercent 10}}})
               "openai:b" (q "b" {:rateLimit {:allowed true :primaryWindow {:remainingPercent 70}}})}]
    (is (= ["openai:b" "openai:a" "openai:c"] (mapv c/account-key (c/sort-account-entries (subvec flat 0 3) quota now)))
        "quota-bearing first, most remaining first, then label")
    (is (= ["openai:a" "openai:b" "openai:c"] (mapv c/account-key (c/sort-account-entries (subvec flat 0 3) {} now))))
    (testing "ties: allowed rank then soonest reset"
      (let [quota {"openai:a" (q "a" {:rateLimit {:allowed false :primaryWindow {:remainingPercent 50 :resetAfterSeconds 10}}})
                   "openai:b" (q "b" {:rateLimit {:allowed true :primaryWindow {:remainingPercent 50 :resetAfterSeconds 99}}})}]
        (is (= ["openai:b" "openai:a"] (mapv c/account-key (c/sort-account-entries (subvec flat 0 2) quota now))))))
    (let [diag (c/account-diagnostics flat {} now)]
      (is (= 2 (count (c/filter-accounts flat "example" false diag))))
      (is (= 4 (count (c/filter-accounts flat "  " false diag))))
      (is (= ["openai:c"] (mapv c/account-key (c/filter-accounts flat "" true diag)))))
    (let [secs (c/grouped-sections "provider" providers flat {} now)]
      (is (= ["openai" "vivgrid"] (mapv :key secs)))
      (is (= "3 account(s) connected" (:description (first secs))))
      (is (= "OAuth" (:badge (first secs))))
      (is (= "3 shown" (:badge-muted (first secs)))))
    (let [secs (c/grouped-sections "provider" providers (subvec flat 0 1) {} now)]
      (is (= ["openai"] (mapv :key secs)))
      (is (= "1 of 3 account(s) shown" (:description (first secs)))))
    (let [secs (c/grouped-sections "plan" providers flat {} now)]
      (is (= ["Plus" "Pro" "No plan"] (mapv :title secs)) "no-plan group last")
      (is (= "Plan" (:badge (first secs))))
      (is (= "2 account(s) · Plan grouping" (:description (last secs)))))
    (let [secs (c/grouped-sections "domain" providers flat {} now)]
      (is (= ["example.com" "other.org" "No email domain"] (mapv :title secs))))
    (is (= [{:providerId "openai" :keyPool {:x 1} :logs nil} {:providerId "ollama" :keyPool nil :logs {:count 2}} {:providerId "vivgrid" :keyPool nil :logs nil}]
           (sort-by #(case (:providerId %) "openai" 0 "ollama" 1 2)
                    (c/provider-health [{:id "openai"} {:id "vivgrid"}] {"openai" {:x 1}} {"ollama" {:count 2}}))))
    (is (= ["ollama" "openai" "vivgrid"] (mapv :providerId (c/provider-health [{:id "openai"} {:id "vivgrid"}] {"openai" {}} {"ollama" {}}))))))

(deftest watch-rows
  (is (nil? (c/cache-watch-rows nil)))
  (is (= [{:promptTokens 100 :cachedPromptTokens 25 :cacheRate 25}] (c/cache-watch-rows {:rows [{:promptTokens 100 :cachedPromptTokens 25}] :watchRows []})))
  (is (= [{:promptTokens 0 :cachedPromptTokens 0 :cacheRate 0}] (c/cache-watch-rows {:rows [] :watchRows [{:promptTokens 0 :cachedPromptTokens 0}]}))))
