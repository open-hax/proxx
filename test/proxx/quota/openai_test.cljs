(ns proxx.quota.openai-test
  (:require [cljs.test :refer [deftest is testing async]]
            [proxx.json :as json]
            [proxx.quota.openai :as q]
            [proxx.runtime.quota :as edge]))

(def now 1700000000000)
(defn- win [m] (q/parse-window m now))

(deftest windows-derive-missing-percentages
  (is (= {:used-percent 40 :remaining-percent 60 :resets-at nil :reset-after-seconds nil :limit-window-seconds nil}
         (win {"used_percent" 40})))
  (is (= 30 (:used-percent (win {"remainingPercent" 70}))))
  (testing "fractions below 1 are read as ratios, results are clamped"
    (is (= 50 (:used-percent (win {"used_percent" 0.5}))))
    (is (= 100 (:used-percent (win {"used_percent" 150}))))
    (is (= 0 (:used-percent (win {"used_percent" -5})))))
  (testing "unit counts fill what percentages leave open"
    (is (= [25 75] ((juxt :used-percent :remaining-percent) (win {"used" 25 "remaining" 75 "limit" 100}))))
    (is (nil? (:used-percent (win {"used" 25 "limit" 0}))) "a zero limit proves nothing"))
  (is (nil? (win {})) "no usable fact, no window")
  (is (nil? (win "x")))
  (is (= 18000 (:limit-window-seconds (win {"limit_window_seconds" 18000})))))

(deftest reset-times
  (is (= "2023-11-14T22:13:20.000Z" (:resets-at (win {"resets_at" 1700000000}))) "seconds are scaled")
  (is (= "2023-11-14T22:13:20.000Z" (:resets-at (win {"reset" 1700000000000}))) "milliseconds are kept")
  (is (= "2023-11-14T22:13:20.000Z" (:resets-at (win {"resetAt" "1700000000"}))) "numeric strings count")
  (is (= "2026-01-01T00:00:00.000Z" (:resets-at (win {"resets_at" "2026-01-01T00:00:00Z"}))))
  (let [w (win {"reset_after_seconds" 3600})]
    (is (= 3600 (:reset-after-seconds w)))
    (is (= "2023-11-14T23:13:20.000Z" (:resets-at w)) "relative resets are anchored at now-ms"))
  (is (= 3600 (:reset-after-seconds (win {"resets_at" 1700003600}))) "absolute resets give seconds remaining")
  (is (= 0 (:reset-after-seconds (win {"resets_at" 1600000000}))) "never negative"))

(deftest rate-limits-and-details
  (let [d (q/quota-details {"usage" {"rate_limit" {"allowed" false "limit_reached" true
                                                    "primary_window" {"used_percent" 100}}
                                     "weekly" {"used_percent" 10}}} now)]
    (is (= true (get-in d [:rate-limit :limit-reached])))
    (is (= 100 (get-in d [:five-hour :used-percent])))
    (is (= 10 (get-in d [:weekly :used-percent])) "legacy spellings fill what the rate limit lacks"))
  (is (= {:five-hour nil :weekly nil :rate-limit nil :code-review-rate-limit nil} (q/quota-details "x" now)))
  (is (nil? (q/parse-rate-limit {"allowed" nil} now)))
  (testing "pinned: a JSON array is a record with no properties, so it shadows the payload's own fields"
    (is (= "plus" (q/plan-type {"usage" [1 2] "plan_type" "Free"} "plus")))
    (is (= "free" (q/plan-type {"plan_type" " Free "} "plus")))))

(deftest error-bodies
  (is (= "HTTP 502" (q/error-message 502 "  ")))
  (is (= "code: msg" (q/error-message 400 (json/write {"detail" {"code" "code" "message" "msg"}}))))
  (is (= "boom" (q/error-message 400 (json/write {"error" {"message" " boom "}}))))
  (is (= "plain" (q/error-message 500 "plain")))
  (is (= (str (apply str (repeat 157 "x")) "...") (q/error-message 500 (apply str (repeat 300 "x")))))
  (is (= "bad_ws" (q/error-code (json/write {"detail" {"code" "Bad_WS"}}))))
  (is (= "c" (q/error-code (json/write {"error" {"code" "C"}}))))
  (is (nil? (q/error-code "not json")))
  (is (true? (q/retry-without-workspace? "invalid_workspace" "ws")))
  (is (false? (q/retry-without-workspace? "invalid_workspace" "  ")) "nothing to drop without a workspace id")
  (is (false? (q/retry-without-workspace? "token_expired" "ws"))))

(deftest tokens-and-accounts
  (let [claims {"email" " Me@X " "sub" " s " "https://api.openai.com/auth" {"chatgpt_account_id" "ws" "chatgpt_plan_type" " Pro "}}]
    (is (= {:email "me@x" :subject "s" :chatgpt-account-id "ws" :plan-type "pro"} (q/oauth-metadata claims)))
    (is (= {} (q/oauth-metadata nil))))
  (is (= {:access-token "a" :refresh-token "r" :expires-at (+ now 5000)}
         (q/refreshed-tokens {"access_token" " a " "refresh_token" " r " "expires_in" 5} now)))
  (is (nil? (q/refreshed-tokens {"access_token" "a"} now)))
  (testing "refresh is due inside the buffer, only for OAuth accounts that expire"
    (is (true? (q/needs-refresh? {:auth-type "oauth_bearer" :expires-at (+ now 60000)} now 60000)))
    (is (false? (q/needs-refresh? {:auth-type "oauth_bearer" :expires-at (+ now 60001)} now 60000)))
    (is (false? (q/needs-refresh? {:auth-type "api_key" :expires-at 0} now 60000)))
    (is (false? (q/needs-refresh? {:auth-type "oauth_bearer"} now 60000))))
  (is (= ["b" "a" "c"] (map :id (q/oauth-accounts [{:id "a" :auth-type "oauth_bearer" :email "Zed"}
                                                   {:id "b" :auth-type "oauth_bearer" :display-name "alpha"}
                                                   {:id "x" :auth-type "api_key" :email "a"}
                                                   {:id "c" :auth-type "oauth_bearer" :id-only 1 :email "zz"}]
                                                  nil)))
      "OAuth accounts only, ordered by lower-cased email/name/id"))

(deftest probe-verdicts
  (is (= "hello" (q/completion-text {"choices" [{"message" {"content" " hello "}}]})))
  (is (= "" (q/completion-text {"choices" []})))
  (let [{:keys [matches? message]} (q/probe-outcome "Hello" "hello")]
    (is matches?)
    (is (= "Live — replied with \"Hello\"." message)))
  (is (= "Live — request completed without assistant text." (:message (q/probe-outcome "" "hello")))))

(def manifest "resources/policies/runtime/00-manifest.edn")

(deftest ^:async edge-reads-usage-through-the-injected-fetch
  (let [calls (atom [])
        fetch-fn (fn [url init]
                   (swap! calls conj [url (.-method init) (aget (.-headers init) "authorization")])
                   (js/Promise.resolve (js/Response. (js/JSON.stringify #js {:usage #js {:rate_limit #js {:allowed false :limit_reached true}}})
                                                     #js {:status 200})))
        store #js {:listProviders (fn [] (js/Promise.resolve
                                          #js [#js {:id "openai"
                                                    :accounts #js [#js {:id "a" :authType "oauth_bearer" :displayName "A" :secret "tok"}]}]))}
        result (await (edge/fetch-openai-quota-snapshots-js manifest store #js {:providerId "openai" :fetchFn fetch-fn}))
        snap (aget (.-accounts result) 0)]
    (is (= [["https://chatgpt.com/backend-api/wham/usage" "GET" "Bearer tok"]] @calls))
    (is (= "ok" (.-status snap)))
    (is (true? (.-limitReached (.-rateLimit snap))))
    (is (not (contains? (js->clj snap) "email")) "absent optional facts stay absent")))
