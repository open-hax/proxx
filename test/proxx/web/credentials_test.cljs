(ns proxx.web.credentials-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.pages.credentials :as p]
            [proxx.web.update :as u]))

(def now (js/Date.parse "2026-04-03T00:00:00Z"))

(defn- boot [& [stored]]
  (u/init-db {:stored (or stored {}) :token "t" :path "/credentials" :api-origin "http://api.test"}))
(defn- entered [& [stored]] (first (u/handle (boot stored) [:route/changed "/credentials"])))
(defn- slice [db] (get-in db [:pages :credentials]))
(defn- step [db event] (u/handle (assoc db :now-ms now) event))
(defn- paths [fx*] (mapcat #(case (first %) :http [(:path (second %))] :http-all (map :path (second %)) nil) fx*))
(defn- http1 [fx*] (second (first (filter #(= :http (first %)) fx*))))

(def payload
  {:providers [{:id "openai" :authType "oauth_bearer" :accountCount 1
                :accounts [{:id "a" :displayName "Alice" :email "alice@example.com" :authType "oauth_bearer" :secretPreview "tok" :planType "pro"}]}]
   :keyPoolStatuses {"openai" {:providerId "openai" :totalAccounts 1 :availableAccounts 1 :cooldownAccounts 0}}
   :requestLogSummary {"openai" {:count 3 :lastTimestamp 0}}})

(deftest enter-loads-credentials-disabled-and-logs
  (let [[_ fx*] (u/handle (boot) [:route/changed "/credentials"])]
    (is (= ["/api/v1/credentials" "/api/v1/credentials/accounts/disabled" "/api/v1/request-logs?limit=250"] (paths fx*))))
  (let [[_ fx*] (u/handle (boot {p/ls-reveal "yes" p/ls-log-provider "openai"}) [:route/changed "/credentials"])]
    (is (= ["/api/v1/credentials?reveal=1" "/api/v1/credentials/accounts/disabled" "/api/v1/request-logs?providerId=openai&limit=250"] (paths fx*))
        "legacy string booleans are honoured; filters apply")))

(deftest first-credentials-load-requests-quota-once
  (let [db (entered)
        [db1 fx1] (step db [:credentials/loaded payload])]
    (is (= ["/api/v1/credentials/openai/quota" "/api/v1/credentials/openai/prompt-cache-audit?limit=40"] (paths fx1)))
    (is (true? (:quota-loading? (slice db1))))
    (let [[_ fx2] (step db1 [:credentials/loaded payload])]
      (is (empty? fx2) "only the first non-empty load fetches quota"))
    (let [[_ fx3] (step db [:credentials/loaded {:providers [] :keyPoolStatuses {} :requestLogSummary {}}])]
      (is (empty? fx3)))))

(deftest preferences-and-filters
  (let [db (entered)
        [db1 fx1] (step db [:credentials/set-reveal true])]
    (is (true? (p/reveal? db1)))
    (is (= [[:storage/write p/ls-reveal true]] (filter #(= :storage/write (first %)) fx1)))
    (is (= ["/api/v1/credentials?reveal=1" "/api/v1/credentials/accounts/disabled"] (paths fx1))))
  (let [[db1 _] (step (entered) [:credentials/set-grouping "bogus"])]
    (is (= "provider" (p/grouping db1))))
  (let [[db1 fx1] (step (entered) [:credentials/set-log-account "a1"])]
    (is (= "a1" (p/log-account db1)))
    (is (= ["/api/v1/request-logs?accountId=a1&limit=250"] (paths fx1))))
  (let [[db1 _] (step (entered) [:credentials/toggle-reauth-only])]
    (is (true? (:reauth-only? (slice db1)))))
  (is (= true (p/validate-boolean "ON")))
  (is (= false (p/validate-boolean "0")))
  (is (nil? (p/validate-boolean "maybe")))
  (is (nil? (p/validate-boolean 3))))

(deftest api-key-form
  (let [db (entered)
        [db1 fx1] (step db [:credentials/submit-api-key])]
    (is (= "API key value is required" (:error (slice db1))))
    (is (empty? fx1)))
  (let [db (reduce (fn [d [k v]] (first (step d [:credentials/api-key-field k v])))
                   (entered) {:provider " openai " :account " acct " :value " sk-1 "})
        [db1 fx1] (step db [:credentials/submit-api-key])]
    (is (= {:method :post :path "/api/v1/credentials/api-key" :body {:providerId "openai" :apiKey "sk-1" :accountId "acct"}}
           (dissoc (http1 fx1) :decode)))
    (let [[db2 fx2] (step db1 [:credentials/api-key-saved {}])]
      (is (= "API key saved." (:status (slice db2))))
      (is (= "" (get-in (slice db2) [:api-key :value])))
      (is (= "" (get-in (slice db2) [:api-key :account])))
      (is (= ["/api/v1/credentials" "/api/v1/credentials/openai/quota"] (paths fx2)))))
  (let [[db1] (step (entered) [:credentials/api-key-shortcut "factory"])]
    (is (= {:provider "factory" :account "" :value ""} (:api-key (slice db1))))))

(deftest browser-oauth
  (let [[db fx*] (step (entered) [:credentials/start-browser {:kind :openai :account-id "a" :label "alice@example.com"}])]
    (is (= {:redirectBaseUrl "http://api.test" :accountId "a"} (:body (http1 fx*))))
    (let [[_ fx2] (step db [:credentials/browser-started {:kind :openai :label "L"} {:authorizeUrl "https://auth"}])]
      (is (= [:window/open-watch :oauth-watch "https://auth" [:credentials/oauth-opened {:kind :openai :label "L"}]
              [:credentials/oauth-blocked] [:credentials/oauth-closed {:kind :openai :label "L"}]]
             (first fx2)))))
  (let [[_ fx*] (step (entered) [:credentials/start-browser {:kind :openai}])]
    (is (= {:redirectBaseUrl "http://api.test"} (:body (http1 fx*))) "no account id for a fresh sign-in"))
  (let [[_ fx*] (step (entered) [:credentials/start-browser {:kind :factory}])]
    (is (= "/api/v1/credentials/factory/oauth/browser/start" (:path (http1 fx*)))))
  (is (= "OpenAI reauth tab opened for L. Sign into that same account to replace the old credential."
         (:status (slice (first (step (entered) [:credentials/oauth-opened {:kind :openai :label "L"}]))))))
  (is (= "Browser OAuth tab opened. Finish sign-in to save credentials."
         (:status (slice (first (step (entered) [:credentials/oauth-opened {:kind :openai}]))))))
  (is (= "Factory.ai OAuth tab opened. Finish sign-in to save credentials."
         (:status (slice (first (step (entered) [:credentials/oauth-opened {:kind :factory}]))))))
  (is (= "Browser blocked the new tab. Allow popups and try again."
         (:error (slice (first (step (entered) [:credentials/oauth-blocked]))))))
  (let [[db fx*] (step (entered) [:credentials/oauth-closed {:kind :openai :label "L"}])]
    (is (= "OpenAI reauth finished for L. Credentials refreshed." (:status (slice db))))
    (is (= ["/api/v1/credentials" "/api/v1/credentials/openai/quota"] (paths fx*))))
  (let [[db fx*] (step (entered) [:credentials/oauth-closed {:kind :factory}])]
    (is (= "Factory.ai browser OAuth flow finished. Credentials refreshed." (:status (slice db))))
    (is (= ["/api/v1/credentials"] (paths fx*)) "factory does not refresh quota")))

(deftest device-flow
  (let [[db fx*] (step (entered) [:credentials/start-device :openai])]
    (is (= "/api/v1/credentials/openai/oauth/device/start" (:path (http1 fx*))))
    (let [info {:verificationUrl "https://v" :userCode "ABCD" :deviceAuthId "d1" :intervalMs 5000}
          [db2 fx2] (step db [:credentials/device-started :openai info])]
      (is (= "Device auth started. Enter code ABCD; polling continues automatically." (:status (slice db2))))
      (is (= [[:interval/start :credentials-device 8000 [:credentials/poll-device]]] fx2))
      (is (= [[:interval/start :credentials-device 3000 [:credentials/poll-device]]]
             (second (step db [:credentials/device-started :openai (assoc info :intervalMs 0)]))) "minimum 3s")
      (testing "poll"
        (let [[db3 fx3] (step db2 [:credentials/poll-device])]
          (is (true? (:device-polling? (slice db3))))
          (is (= {:deviceAuthId "d1" :userCode "ABCD"} (:body (http1 fx3))))
          (is (= [db3 []] (step db3 [:credentials/poll-device])) "no overlap")
          (is (= "Authorization is still pending." (:status (slice (first (step db3 [:credentials/device-polled {:state "pending"}]))))))
          (let [d (first (step db3 [:credentials/device-polled {:state "failed"}]))]
            (is (= "OAuth device poll failed" (:error (slice d))))
            (is (false? (:device-polling? (slice d)))))
          (is (= "why" (:error (slice (first (step db3 [:credentials/device-polled {:state "failed" :reason "why"}]))))))
          (let [[d fx4] (step db3 [:credentials/device-polled {:state "authorized"}])]
            (is (nil? (:device-auth (slice d))))
            (is (= "OpenAI OAuth account saved from device flow." (:status (slice d))))
            (is (= [:interval/stop :credentials-device] (first fx4)))
            (is (= ["/api/v1/credentials" "/api/v1/credentials/openai/quota"] (paths fx4))))
          (is (false? (:device-polling? (slice (first (step db3 [:credentials/device-poll-failed "net"])))))))))
    (is (= [db []] (step db [:credentials/poll-device])) "nothing to poll without a device auth"))
  (let [[db fx*] (step (entered) [:credentials/start-device :factory])
        [db2 _] (step db [:credentials/device-started :factory {:verificationUrl "u" :userCode "C" :deviceAuthId "f1" :intervalMs 1000}])
        [_ fx3] (step db2 [:credentials/poll-device])]
    (is (= "/api/v1/credentials/factory/oauth/device/start" (:path (http1 fx*))))
    (is (= "Factory.ai device auth started. Enter code C; polling continues automatically." (:status (slice db2))))
    (is (= "/api/v1/credentials/factory/oauth/device/poll" (:path (http1 fx3))))
    (is (= {:deviceAuthId "f1"} (:body (http1 fx3))))))

(deftest account-actions
  (let [db (entered)]
    (testing "remove asks first"
      (let [[_ fx*] (step db [:credentials/remove "openai" "a" "Alice"])]
        (is (= [[:confirm "Remove credential \"Alice\" (openai/a)?" [:credentials/remove-confirmed "openai" "a" "Alice"]]] fx*))
        (let [[db1 fx1] (step db [:credentials/remove-confirmed "openai" "a" "Alice"])]
          (is (= {:method :delete :path "/api/v1/credentials/account" :body {:providerId "openai" :accountId "a"}} (dissoc (http1 fx1) :decode)))
          (let [[db2 fx2] (step db1 [:credentials/removed "Alice"])]
            (is (= "Removed credential Alice." (:status (slice db2))))
            (is (= ["/api/v1/credentials" "/api/v1/credentials/openai/quota"] (paths fx2)))))))
    (testing "disable and enable keep a local set"
      (let [[db1 fx1] (step db [:credentials/disable "openai" "a" "Alice"])]
        (is (= "/api/v1/credentials/account/disable" (:path (http1 fx1))))
        (let [[db2] (step db1 [:credentials/disabled "Alice" "openai" "a" {}])]
          (is (= #{"openai:a"} (:disabled (slice db2))))
          (is (= "Disabled account Alice." (:status (slice db2))))
          (let [[db3 fx3] (step db2 [:credentials/enable "openai" "a" "Alice"])]
            (is (= "/api/v1/credentials/account/enable" (:path (http1 fx3))))
            (let [[db4] (step db3 [:credentials/enabled "Alice" "openai" "a" {}])]
              (is (= #{} (:disabled (slice db4))))
              (is (= "Enabled account Alice." (:status (slice db4)))))))))
    (testing "disabled list from the server"
      (is (= #{"openai:a" "x:b"} (:disabled (slice (first (step db [:credentials/disabled-loaded {:disabledAccounts [{:providerId "openai" :accountId "a"} {:providerId "x" :accountId "b"}]}])))))))
    (testing "copy feedback resets"
      (let [[_ fx*] (step db [:credentials/copy "val" "k"])]
        (is (= [:clipboard/write "val" [:credentials/copied "k"] [:credentials/error]] (first fx*))))
      (let [[db1 fx1] (step db [:credentials/copied "k"])]
        (is (= [[:dispatch-later 1200 [:credentials/clear-copied "k"]]] fx1))
        (is (= "k" (:copied (slice (first (step db1 [:credentials/clear-copied "other"]))))))
        (is (nil? (:copied (slice (first (step db1 [:credentials/clear-copied "k"]))))))))))

(deftest probes
  (let [db (entered)
        [db1 fx1] (step db [:credentials/probe "openai" "a"])]
    (is (true? (get-in (slice db1) [:probe-loading "openai:a"])))
    (is (= "/api/v1/credentials/openai/probe" (:path (http1 fx1))))
    (let [[db2 fx2] (step db1 [:credentials/probed "openai:a" "openai" {:ok true :message "fine"}])]
      (is (false? (get-in (slice db2) [:probe-loading "openai:a"])))
      (is (= {:ok true :message "fine"} (get-in (slice db2) [:probe-results "openai:a"])))
      (is (= ["/api/v1/credentials/openai/quota" "/api/v1/credentials/openai/prompt-cache-audit?limit=40"] (paths fx2))))
    (let [[db2 fx2] (step db1 [:credentials/probed "openai:a" "ollama-cloud" {:ok true}])]
      (is (empty? fx2) "only openai refreshes quota"))
    (let [[db2] (step db1 [:credentials/probe-failed "openai:a" "openai" "a" "boom"])
          r (get-in (slice db2) [:probe-results "openai:a"])]
      (is (= {:providerId "openai" :accountId "a" :displayName "openai/a" :testedAt "2026-04-03T00:00:00.000Z" :model "gpt-5.2"
              :expectedText "hello" :status "error" :ok false :matchesExpectedOutput false :message "boom"}
             r))))
  (is (= "/api/v1/credentials/ollama-cloud/probe" (:path (http1 (second (step (entered) [:credentials/probe "ollama-cloud" "k"])))))))

(deftest view-model
  (let [db (-> (entered)
               (assoc-in [:pages :credentials :providers] (:providers payload))
               (assoc-in [:pages :credentials :key-pool] (:keyPoolStatuses payload))
               (assoc-in [:pages :credentials :log-summary] (:requestLogSummary payload))
               (assoc-in [:pages :credentials :logs] [{:id "r1" :providerId "openai" :accountId "a" :status 200 :latencyMs 420 :model "gpt" :upstreamMode "responses"
                                                       :routeKind "local" :serviceTierSource "none" :timestamp now :totalTokens 12 :error "oops"}]))
        vm (p/view-model db now)]
    (is (= "Showing 1 of 1 account(s)" (:showing vm)))
    (is (= "Codex quotas not loaded yet" (:quota-line vm)))
    (is (= "No accounts currently require reauth · OpenAI identities 1/1 · No possible duplicate identities detected" (:diag-line vm)))
    (is (= "Show reauth required (0)" (:reauth-button vm)))
    (is (true? (:reauth-disabled? vm)))
    (is (nil? (:pool vm)))
    (is (nil? (:audit vm)))
    (let [[s] (:sections vm)
          [t] (:accounts s)]
      (is (= "openai" (:title s)))
      (is (= "1 account(s) connected" (:description s)))
      (is (= "Alice" (:display-name t)))
      (is (= "alice@example.com" (:subtitle t)) "email differs from the name so it is shown")
      (is (= [{:label "Pro" :variant "info"} {:label "OAuth" :variant "default"}] (:chips t)))
      (is (true? (:can-reauth? t)))
      (is (true? (:can-probe? t)))
      (is (true? (:show-quota? t)))
      (is (= "Not loaded" (get-in t [:quota :updated])))
      (is (= "token tok" (:token-chip t)))
      (is (= ["Internal ID" "Provider" "Email" "Access token"] (mapv :label (remove nil? (:details t)))))
      (is (= "Copy" (get-in (first (:details t)) [:copy :text]))))
    (is (= [{:id "openai" :recent "Recent logs: 3" :last (str "Last request: " (proxx.web.format/format-datetime 0))
             :pool ["Accounts ready: 1/1" "Cooldown accounts: 0"]}]
           (:provider-health vm)))
    (is (= [{:id "r1" :title "openai/a" :status-line "200 · 420ms" :error "oops"
             :detail (str "gpt · responses · standard · local · " (proxx.web.format/format-datetime now) " · 12 tok")}]
           (:logs vm)))
    (is (= ["a"] (:account-ids vm))))
  (testing "quota + audit + reauth surfaces"
    (let [db (-> (entered)
                 (assoc-in [:pages :credentials :providers] (:providers payload))
                 (assoc-in [:pages :credentials :quota]
                           {:generatedAt "2026-04-03T00:00:00Z"
                            :accounts [{:providerId "openai" :accountId "a" :status "error" :error "Refresh token expired" :fetchedAt "2026-04-03T00:00:00Z"}]})
                 (assoc-in [:pages :credentials :audit]
                           {:crossSuccessfulAccountHashCount 1 :crossAccountHashCount 2 :distinctHashCount 3 :scannedEntryCount 4
                            :rows [{:promptCacheKeyHash "abcdefghijklmnopqrstuvwxyz" :providerId "openai" :latestModel "m" :requestCount 5
                                    :successfulAccountCount 2 :failedAccountCount 0 :successfulAccountIds ["a" "b"] :failedAccountIds []
                                    :successfulRequestCount 4 :failedRequestCount 1 :cacheHitCount 1 :shapeFingerprintCount 1
                                    :cachedPromptTokens 50 :promptTokens 100 :lastSeenAt nil :firstSeenAt nil}]
                            :watchRows []}))
          vm (p/view-model db now)
          [t] (:accounts (first (:sections vm)))
          [row] (get-in vm [:audit :rows])]
      (is (= 1 (:reauth-count vm)))
      (is (= "Show reauth required (1)" (:reauth-button vm)))
      (is (false? (:reauth-disabled? vm)))
      (is (= "Reauth now" (:reauth-label t)))
      (is (= {:label "Reauth required" :variant "error"} (first (:chips t))))
      (is (= :error (get-in t [:quota :state])))
      (is (= "Refresh token expired" (get-in t [:quota :error])))
      (is (= "1 multi-success-account hash(es) · 2 cross-account hash(es) · 3 distinct hash(es) · scanned 4 recent OpenAI OAuth request(s)"
             (get-in vm [:audit :summary])))
      (is (= "abcdefghij…stuvwxyz" (:hash-short row)))
      (is (= "50%" (:cache-pct row)))
      (is (= "Never" (:last-seen row)))
      (is (= "2 successful accounts" (:ok-long row)))
      (is (= "0 failed accounts" (:fail-long row)))
      (is (= "None" (:fail-ids row)))
      (is (= "4 success · 1 failed · 1 hit · 1 shape" (:counts row)))
      (is (= 1 (count (get-in vm [:audit :watch]))) "falls back to rows when no watch rows")
      (is (= "warning" (:ok-badge row))))))
