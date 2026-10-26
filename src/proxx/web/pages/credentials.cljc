(ns proxx.web.pages.credentials
  "Credentials Manager page: state machine (loading, quota, OAuth flows, probes,
  account actions) and the view-model over `proxx.web.credentials`."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.credentials :as cred]
            [proxx.web.format :as fmt]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(def ls-reveal "open-hax-proxy.ui.credentials.revealSecrets")
(def ls-grouping "open-hax-proxy.ui.credentials.grouping")
(def ls-search "open-hax-proxy.ui.credentials.accountSearch")
(def ls-log-provider "open-hax-proxy.ui.credentials.logProvider")
(def ls-log-account "open-hax-proxy.ui.credentials.logAccount")

(def log-limit 250)
(def copy-reset-ms 1200)
(def oauth-watch-ms 750)
(def api-key-providers
  [["vivgrid" "Vivgrid"] ["openai" "OpenAI"] ["ollama-cloud" "Ollama Cloud"] ["ollama" "Ollama (local)"]
   ["ollama-stealth" "Ollama Stealth"] ["ollama-big-ussy" "Ollama Big Ussy"] ["requesty" "Requesty"]
   ["zen" "Zen/ZenMux"] ["openrouter" "OpenRouter"] ["gemini" "Gemini"] ["zai" "Z.ai (GLM)"]
   ["xiaomi" "Xiaomi MiMo"] ["mistral" "Mistral"] ["factory" "Factory"] ["ob1" "OB1"]])

(defn validate-boolean
  "Booleans, and the string forms older versions stored."
  [v]
  (cond
    (boolean? v) v
    (string? v) (case (str/lower-case (str/trim v))
                  ("true" "1" "yes" "on") true
                  ("false" "0" "no" "off") false
                  nil)
    :else nil))

(defn validate-grouping [v] (#{"provider" "plan" "domain"} v))

(defn reveal? [db] (st/stored db ls-reveal false validate-boolean))
(defn grouping [db] (st/stored db ls-grouping "provider" validate-grouping))
(defn search [db] (st/stored db ls-search "" storage/validate-string))
(defn log-provider [db] (st/stored db ls-log-provider "" storage/validate-string))
(defn log-account [db] (st/stored db ls-log-account "" storage/validate-string))

(defn init []
  {:providers [] :key-pool {} :log-summary {} :logs []
   :api-key {:provider "vivgrid" :account "" :value ""}
   :device-auth nil :device-polling? false :reauth-only? false
   :quota nil :quota-loading? false :quota-error nil :audit nil :quota-requested? false
   :probe-results {} :probe-loading {} :disabled #{} :copied nil :status nil :error nil})

(defn- slice [db] (st/page-slice db :credentials))
(defn- put [db & kvs] (apply st/update-page db :credentials assoc kvs))
(defn- ok [db] [db []])

;; ---------------------------------------------------------------------------
;; Effect builders

(defn- creds-fx [db] (fx/http (api/list-credentials (reveal? db)) [:credentials/loaded] [:credentials/error]))
(defn- disabled-fx [] (fx/http (api/get-disabled-accounts) [:credentials/disabled-loaded] [:credentials/error]))
(defn- logs-fx [db]
  (fx/http (api/list-request-logs {:providerId (not-empty (log-provider db)) :accountId (not-empty (log-account db)) :limit log-limit})
           [:credentials/logs-loaded] [:credentials/error]))
(defn- audit-fx [] (fx/http (api/get-openai-prompt-cache-audit 40) [:credentials/audit-loaded] [:credentials/error]))
(defn- quota-fx [] (fx/http (api/get-openai-credential-quota nil) [:credentials/quota-loaded] [:credentials/quota-failed]))

(defn- refresh-quota
  "Marks quota as loading and returns `[db' [fx]]`."
  [db]
  [(put db :quota-loading? true :quota-error nil) [(quota-fx)]])

(defn- join
  "Sequence several `[db fx]`-returning steps over one db, concatenating effects."
  [db & steps]
  (reduce (fn [[d fx*] step] (let [[d' f] (step d)] [d' (into fx* f)])) [db []] steps))

(defn- refresh-creds+quota [db] (join db (fn [d] [d [(creds-fx d)]]) refresh-quota))

;; ---------------------------------------------------------------------------
;; Lifecycle

(defn enter [db] [db [(creds-fx db) (disabled-fx) (logs-fx db)]])

(defn leave [_]
  [(fx/close-watch :oauth-watch) (fx/interval-stop :credentials-device)])

(defn- loaded [db [_ payload]]
  (let [providers (:providers payload)
        db (put db :providers providers :key-pool (:keyPoolStatuses payload) :log-summary (:requestLogSummary payload))
        first-time? (and (not (:quota-requested? (slice db))) (seq providers))]
    (if first-time?
      (let [[db' fx*] (refresh-quota (put db :quota-requested? true))]
        [db' (conj fx* (audit-fx))])
      (ok db))))

(defn- disabled-loaded [db [_ payload]]
  [(put db :disabled (into #{} (map #(str (:providerId %) ":" (:accountId %))) (:disabledAccounts payload))) []])

(defn- logs-loaded [db [_ entries]] [(put db :logs entries) []])
(defn- error [db [_ message]] [(put db :error message) []])
(defn- quota-loaded [db [_ q]] [(put db :quota q :quota-loading? false) []])
(defn- quota-failed [db [_ m]] [(put db :quota-error m :quota-loading? false) []])
(defn- audit-loaded [db [_ a]] [(put db :audit a) []])

;; ---------------------------------------------------------------------------
;; Preferences and filters

(defn- set-reveal [db [_ v]]
  (let [[db' f] (st/set-stored db ls-reveal (boolean v))]
    [db' (into f [(creds-fx db') (disabled-fx)])]))
(defn- set-search [db [_ v]] (st/set-stored db ls-search v))
(defn- set-grouping [db [_ v]] (st/set-stored db ls-grouping (or (validate-grouping v) "provider")))
(defn- toggle-reauth-only [db _] [(update-in db [:pages :credentials :reauth-only?] not) []])
(defn- set-log-provider [db [_ v]]
  (let [[db' f] (st/set-stored db ls-log-provider v)] [db' (conj f (logs-fx db'))]))
(defn- set-log-account [db [_ v]]
  (let [[db' f] (st/set-stored db ls-log-account v)] [db' (conj f (logs-fx db'))]))
(defn- refresh-logs [db _] [db [(logs-fx db)]])
(defn- refresh-quota-and-audit [db _]
  (let [[db' fx*] (refresh-quota db)] [db' (conj fx* (audit-fx))]))

;; ---------------------------------------------------------------------------
;; API key form

(defn- set-api-key-field [db [_ field v]] [(st/update-page db :credentials assoc-in [:api-key field] v) []])
(defn- api-key-shortcut [db [_ provider]]
  [(put db :api-key {:provider provider :account "" :value ""}) []])

(defn- submit-api-key [db _]
  (let [{:keys [provider account value]} (:api-key (slice db))
        db (put db :error nil)]
    (if (str/blank? value)
      [(put db :error "API key value is required") []]
      [db [(fx/http (api/add-api-key-credential (str/trim provider) (str/trim value) (let [a (str/trim account)] (when (seq a) a)))
                    [:credentials/api-key-saved] [:credentials/error])]])))

(defn- api-key-saved [db _]
  (let [db (-> db (put :status "API key saved.") (st/update-page :credentials assoc :api-key (assoc (:api-key (slice db)) :value "" :account "")))]
    (refresh-creds+quota db)))

;; ---------------------------------------------------------------------------
;; OAuth

(defn- start-browser
  "`ctx`: {:kind :openai|:factory :account-id :label}."
  [db [_ ctx]]
  (let [origin (get-in db [:env :api-origin])
        req (if (= (:kind ctx) :factory)
              (api/start-factory-browser-oauth origin)
              (api/start-openai-browser-oauth origin (:account-id ctx)))]
    [(put db :error nil) [(fx/http req [:credentials/browser-started ctx] [:credentials/error])]]))

(defn- browser-started [db [_ ctx payload]]
  [db [(fx/open-watch :oauth-watch (:authorizeUrl payload) [:credentials/oauth-opened ctx] [:credentials/oauth-blocked]
                      [:credentials/oauth-closed ctx])]])

(defn- oauth-opened [db [_ {:keys [kind label]}]]
  [(put db :status (cond
                     (= kind :factory) "Factory.ai OAuth tab opened. Finish sign-in to save credentials."
                     label (str "OpenAI reauth tab opened for " label ". Sign into that same account to replace the old credential.")
                     :else "Browser OAuth tab opened. Finish sign-in to save credentials."))
   []])

(defn- oauth-blocked [db _] [(put db :error "Browser blocked the new tab. Allow popups and try again.") []])

(defn- oauth-closed [db [_ {:keys [kind label]}]]
  (if (= kind :factory)
    (let [db (put db :status "Factory.ai browser OAuth flow finished. Credentials refreshed.")]
      [db [(creds-fx db)]])
    (let [[db' fx*] (refresh-creds+quota db)]
      [(put db' :status (if label
                          (str "OpenAI reauth finished for " label ". Credentials refreshed.")
                          "Browser OAuth flow finished. Credentials refreshed."))
       fx*])))

(defn- start-device [db [_ provider]]
  (let [req (if (= provider :factory) (api/start-factory-device-oauth) (api/start-openai-device-oauth))]
    [(put db :error nil) [(fx/http req [:credentials/device-started provider] [:credentials/error])]]))

(defn- device-started [db [_ provider payload]]
  (let [label (if (= provider :factory) "Factory.ai device auth" "Device auth")]
    [(put db :device-auth (assoc payload :provider provider)
          :status (str label " started. Enter code " (:userCode payload) "; polling continues automatically."))
     [(fx/interval-start :credentials-device (max (+ (or (:intervalMs payload) 0) 3000) 3000) [:credentials/poll-device])]]))

(defn- poll-device [db _]
  (let [{:keys [device-auth device-polling?]} (slice db)]
    (if (or (nil? device-auth) device-polling?)
      (ok db)
      (let [req (if (= (:provider device-auth) :factory)
                  (api/poll-factory-device-oauth (:deviceAuthId device-auth))
                  (api/poll-openai-device-oauth (:deviceAuthId device-auth) (:userCode device-auth)))]
        [(put db :device-polling? true :error nil)
         [(fx/http req [:credentials/device-polled] [:credentials/device-poll-failed])]]))))

(defn- device-polled [db [_ result]]
  (let [db (put db :device-polling? false)
        provider (:provider (:device-auth (slice db)))]
    (case (:state result)
      "pending" [(put db :status "Authorization is still pending.") []]
      "failed" [(put db :error (or (:reason result) "OAuth device poll failed")) []]
      (let [label (if (= provider :factory) "Factory.ai" "OpenAI")
            db (put db :status (str label " OAuth account saved from device flow.") :device-auth nil)
            [db' fx*] (refresh-creds+quota db)]
        [db' (into [(fx/interval-stop :credentials-device)] fx*)]))))

(defn- device-poll-failed [db [_ m]] [(put db :device-polling? false :error m) []])

;; ---------------------------------------------------------------------------
;; Account actions

(defn- copy [db [_ value key]]
  [db [(fx/clipboard-write value [:credentials/copied key] [:credentials/error])]])
(defn- copied [db [_ key]] [(put db :copied key) [(fx/dispatch-later copy-reset-ms [:credentials/clear-copied key])]])
(defn- clear-copied [db [_ key]] [(if (= key (:copied (slice db))) (put db :copied nil) db) []])

(defn- remove-account [db [_ provider-id account-id display-name]]
  [db [(fx/confirm (str "Remove credential \"" display-name "\" (" provider-id "/" account-id ")?")
                   [:credentials/remove-confirmed provider-id account-id display-name])]])
(defn- remove-confirmed [db [_ provider-id account-id display-name]]
  [(put db :error nil)
   [(fx/http (api/remove-credential provider-id account-id) [:credentials/removed display-name] [:credentials/error])]])
(defn- removed [db [_ display-name]]
  (refresh-creds+quota (put db :status (str "Removed credential " display-name "."))))

(defn- probe [db [_ provider-id account-id]]
  (let [k (str provider-id ":" account-id)
        req (if (= provider-id "ollama-cloud")
              (api/probe-ollama-cloud-credential-account account-id)
              (api/probe-openai-credential-account account-id))]
    [(-> db (put :error nil) (st/update-page :credentials assoc-in [:probe-loading k] true))
     [(fx/http req [:credentials/probed k provider-id] [:credentials/probe-failed k provider-id account-id])]]))

(defn- probed [db [_ k provider-id result]]
  (let [db (-> db (st/update-page :credentials assoc-in [:probe-results k] result)
               (st/update-page :credentials assoc-in [:probe-loading k] false))]
    (if (= provider-id "openai")
      (let [[db' fx*] (refresh-quota db)] [db' (conj fx* (audit-fx))])
      (ok db))))

(defn- probe-failed [db [_ k provider-id account-id message]]
  [(-> db
       (st/update-page :credentials assoc-in [:probe-results k]
                       {:providerId provider-id :accountId account-id :displayName (str provider-id "/" account-id)
                        :testedAt (fmt/iso-from-ms (:now-ms db)) :model (cred/probe-model-for-provider provider-id)
                        :expectedText "hello" :status "error" :ok false :matchesExpectedOutput false :message message})
       (st/update-page :credentials assoc-in [:probe-loading k] false))
   []])

(defn- disable [db [_ provider-id account-id display-name]]
  [(put db :error nil) [(fx/http (api/disable-account provider-id account-id) [:credentials/disabled display-name provider-id account-id] [:credentials/error])]])
(defn- disabled [db [_ display-name provider-id account-id _]]
  [(-> db (put :status (str "Disabled account " display-name "."))
       (st/update-page :credentials update :disabled conj (str provider-id ":" account-id)))
   []])
(defn- enable [db [_ provider-id account-id display-name]]
  [(put db :error nil) [(fx/http (api/enable-account provider-id account-id) [:credentials/enabled display-name provider-id account-id] [:credentials/error])]])
(defn- enabled [db [_ display-name provider-id account-id _]]
  [(-> db (put :status (str "Enabled account " display-name "."))
       (st/update-page :credentials update :disabled disj (str provider-id ":" account-id)))
   []])

(def page
  {:init init :enter enter :leave leave
   :handlers {:credentials/loaded loaded :credentials/disabled-loaded disabled-loaded :credentials/logs-loaded logs-loaded
              :credentials/error error :credentials/quota-loaded quota-loaded :credentials/quota-failed quota-failed
              :credentials/audit-loaded audit-loaded
              :credentials/set-reveal set-reveal :credentials/set-search set-search :credentials/set-grouping set-grouping
              :credentials/toggle-reauth-only toggle-reauth-only
              :credentials/set-log-provider set-log-provider :credentials/set-log-account set-log-account
              :credentials/refresh-logs refresh-logs :credentials/refresh-quota refresh-quota-and-audit
              :credentials/api-key-field set-api-key-field :credentials/api-key-shortcut api-key-shortcut
              :credentials/submit-api-key submit-api-key :credentials/api-key-saved api-key-saved
              :credentials/start-browser start-browser :credentials/browser-started browser-started
              :credentials/oauth-opened oauth-opened :credentials/oauth-blocked oauth-blocked :credentials/oauth-closed oauth-closed
              :credentials/start-device start-device :credentials/device-started device-started
              :credentials/poll-device poll-device :credentials/device-polled device-polled :credentials/device-poll-failed device-poll-failed
              :credentials/copy copy :credentials/copied copied :credentials/clear-copied clear-copied
              :credentials/remove remove-account :credentials/remove-confirmed remove-confirmed :credentials/removed removed
              :credentials/probe probe :credentials/probed probed :credentials/probe-failed probe-failed
              :credentials/disable disable :credentials/disabled disabled
              :credentials/enable enable :credentials/enabled enabled}})

;; ---------------------------------------------------------------------------
;; View-model

(defn- quota-account-key [a] (str (:providerId a) ":" (:accountId a)))

(defn- audit-row-view [row]
  (let [rate (when (pos? (:promptTokens row)) (* (/ (:cachedPromptTokens row) (:promptTokens row)) 100))
        plural (fn [c word] (str c " " word (if (= c 1) "" "s")))]
    {:key (:promptCacheKeyHash row)
     :hash-short (cred/compact-middle (:promptCacheKeyHash row) 10 8)
     :hash (:promptCacheKeyHash row)
     :model-line (when (:latestModel row) (str (:providerId row) " · " (:latestModel row)))
     :ok-badge (if (> (:successfulAccountCount row) 1) "warning" "success")
     :ok-short (str (:successfulAccountCount row) " ok")
     :fail-badge (if (pos? (:failedAccountCount row)) "error" "default")
     :fail-short (str (:failedAccountCount row) " fail")
     :requests (:requestCount row)
     :cache-pct (cred/format-aggregate-percent rate)
     :last-seen (if (:lastSeenAt row) (fmt/format-datetime (:lastSeenAt row)) "Never")
     :ok-long (plural (:successfulAccountCount row) "successful account")
     :ok-ids (or (not-empty (str/join ", " (:successfulAccountIds row))) "None")
     :fail-long (plural (:failedAccountCount row) "failed account")
     :fail-ids (or (not-empty (str/join ", " (:failedAccountIds row))) "None")
     :counts (str (:successfulRequestCount row) " success · " (:failedRequestCount row) " failed · "
                  (:cacheHitCount row) " hit" (if (= 1 (:cacheHitCount row)) "" "s") " · "
                  (:shapeFingerprintCount row) " shape" (if (= 1 (:shapeFingerprintCount row)) "" "s"))
     :tokens (str (fmt/locale-number (:cachedPromptTokens row)) " / " (fmt/locale-number (:promptTokens row)) " prompt tokens")
     :first-seen (if (:firstSeenAt row) (str "first " (fmt/format-datetime (:firstSeenAt row))) "")}))

(defn- watch-row-view [row]
  (let [rate (:cacheRate row)]
    {:key (str "watch-" (:promptCacheKeyHash row))
     :hash (:promptCacheKeyHash row)
     :model-line (str (:providerId row) " · " (or (:latestModel row) "unknown model"))
     :cache-badge (cond (> rate 50) "success" (> rate 20) "warning" :else "default")
     :cache-text (str (cred/format-aggregate-percent rate) " cache")
     :success-text (str (:successfulRequestCount row) " success")
     :account (or (first (:successfulAccountIds row)) "Unknown")
     :prompt-tokens (fmt/locale-number (:promptTokens row))
     :cached-tokens (fmt/locale-number (:cachedPromptTokens row))
     :shapes (str/join ", " (:shapeFingerprints row))}))

(defn- tile-view [{:keys [now-ms reveal? quota-by-account diagnostics disabled copied probe-results probe-loading quota-loading?]}
                  show-provider-badge? {:keys [provider-id account] :as entry}]
  (let [k (cred/account-key entry)
        quota (get quota-by-account k)
        diag (get-in diagnostics [:byAccount k])
        plan (cred/title-case-plan (or (:planType quota) (:planType account)))
        expiry (when (number? (:expiresAt account)) (fmt/format-expiry-badge (:expiresAt account)))
        probe (get probe-results k)
        oauth-openai? (and (= provider-id "openai") (= "oauth_bearer" (:authType account)))
        can-probe? (or oauth-openai? (and (= provider-id "ollama-cloud") (= "api_key" (:authType account))))
        dup (or (:duplicateCount diag) 0)
        needs-reauth? (boolean (:needsReauth diag))
        disabled? (contains? disabled k)
        internal-key (str provider-id ":" (:id account) ":internal")
        workspace-key (str provider-id ":" (:id account) ":workspace")
        label (or (:email account) (:displayName account))
        visible-token (if reveal? (:secret account) (:secretPreview account))
        visible-refresh (if reveal? (:refreshToken account) (:refreshTokenPreview account))]
    {:key k :provider-id provider-id :account-id (:id account) :display-name (:displayName account)
     :subtitle (when (and (:email account) (not= (:email account) (:displayName account))) (:email account))
     :chips (cond-> []
              show-provider-badge? (conj {:label provider-id :variant "default"})
              disabled? (conj {:label "Disabled" :variant "warning"})
              needs-reauth? (conj {:label "Reauth required" :variant "error"})
              (> dup 1) (conj {:label (str "Possible duplicate ×" dup) :variant "warning"})
              plan (conj {:label plan :variant "info"})
              true (conj {:label (fmt/format-auth-type (:authType account)) :variant "default"}))
     :workspace-chip (when (:chatgptAccountId account) (str "workspace " (cred/compact-middle (:chatgptAccountId account))))
     :expiry-chip (when expiry (str "expires " expiry))
     :token-chip (str "token " (:secretPreview account))
     :can-reauth? oauth-openai? :reauth-label (if needs-reauth? "Reauth now" "Reauth") :reauth-ctx {:kind :openai :account-id (:id account) :label label}
     :can-probe? can-probe? :probe-loading? (true? (get probe-loading k))
     :probe (when probe {:badge (if (:ok probe) "success" "error") :badge-text (if (:ok probe) "Live" "Not live")
                         :note (str (:message probe) " Tested " (if (:testedAt probe) (fmt/format-datetime (:testedAt probe)) "never") ".")
                         :note-class (if (:ok probe) "credentials-probe-note" "credentials-probe-note credentials-probe-note-error")})
     :show-quota? (or oauth-openai? (some? quota))
     :quota {:updated (cond quota (str "Updated " (if (:fetchedAt quota) (fmt/format-datetime (:fetchedAt quota)) "never"))
                            quota-loading? "Refreshing…"
                            :else "Not loaded")
             :state (case (:status quota) "ok" :ok "error" :error :none)
             :groups (when (= "ok" (:status quota))
                       (into [] (keep identity)
                             [(cred/quota-group-view "General rate limit" (:rateLimit quota) (:fiveHour quota) (:weekly quota) now-ms)
                              (cred/quota-group-view "Code review rate limit" (:codeReviewRateLimit quota) nil nil now-ms)]))
             :error (or (:error quota) "Quota unavailable")
             :note (if quota-loading? "Loading current Codex quota…" "Refresh Codex quotas to load live 5h and weekly usage.")}
     :details [(let [] {:label "Internal ID" :value (:id account) :copy {:value (:id account) :key internal-key
                                                                          :text (if (= copied internal-key) "Copied" "Copy")}})
               (when (:chatgptAccountId account)
                 {:label "Workspace" :value (:chatgptAccountId account) :copy {:value (:chatgptAccountId account) :key workspace-key
                                                                                :text (if (= copied workspace-key) "Copied" "Copy")}})
               {:label "Provider" :value provider-id}
               (when quota {:label "Quota refreshed" :value (if (:fetchedAt quota) (fmt/format-datetime (:fetchedAt quota)) "never")})
               (when (:email account) {:label "Email" :value (:email account)})
               (when (:subject account) {:label "Subject" :value (:subject account)})
               {:label "Access token" :value visible-token}
               (when (and visible-refresh (not (str/blank? visible-refresh))) {:label "Refresh token" :value visible-refresh})
               (when (number? (:expiresAt account)) {:label "Expires" :value (fmt/format-datetime (:expiresAt account))})]
     :disabled? disabled?}))

(defn view-model
  "Everything the page shows. `now-ms` is the render-time clock."
  [db now-ms]
  (let [{:keys [providers key-pool log-summary logs api-key device-auth device-polling? reauth-only? quota quota-loading?
                quota-error audit probe-results probe-loading disabled copied status error]} (slice db)
        reveal (reveal? db)
        flat (cred/flat-accounts providers)
        quota-by-account (into {} (map (juxt quota-account-key identity)) (:accounts quota))
        diagnostics (cred/account-diagnostics flat quota-by-account now-ms)
        filtered (cred/filter-accounts flat (search db) reauth-only? diagnostics)
        grp (grouping db)
        sections (cred/grouped-sections grp providers filtered quota-by-account now-ms)
        ctx {:now-ms now-ms :reveal? reveal :quota-by-account quota-by-account :diagnostics diagnostics :disabled disabled
             :copied copied :probe-results probe-results :probe-loading probe-loading :quota-loading? quota-loading?}
        pool (cred/openai-quota-pool (:accounts quota) now-ms)
        reauth-count (:reauthRequiredCount diagnostics)]
    {:reveal? reveal :search (search db) :grouping grp :quota-loading? quota-loading? :reauth-only? reauth-only?
     :reauth-count reauth-count
     :reauth-button (if reauth-only? "Show all accounts" (str "Show reauth required (" reauth-count ")"))
     :reauth-disabled? (and (not reauth-only?) (zero? reauth-count))
     :showing (str "Showing " (count filtered) " of " (count flat) " account(s)")
     :quota-line (if quota (str "Codex quotas updated " (if (:generatedAt quota) (fmt/format-datetime (:generatedAt quota)) "never")) "Codex quotas not loaded yet")
     :diag-line (str (if (zero? reauth-count) "No accounts currently require reauth" (str reauth-count " account(s) currently require reauth"))
                     " · OpenAI identities " (:humanIdentifiedOpenAiOauthCount diagnostics) "/" (:openAiOauthCount diagnostics)
                     " · " (cred/duplicate-summary (:duplicateGroups diagnostics)))
     :quota-error quota-error
     :pool (when pool
             (let [gen (:generalCombinedRemainingPercent pool)]
               {:summary (str (:okAccounts pool) "/" (:totalAccounts pool) " live account(s) · " (:generalAvailableCount pool)
                              " available now · " (:errorAccounts pool) " needing attention")
                :badge (cred/pool-badge-variant gen)
                :badge-text (str (cred/format-aggregate-percent (or gen 0)) " combined left")
                :tone (cred/quota-tone-class gen)
                :width (str (max 0 (min 100 (or gen 0))) "%")
                :metrics [{:title "Combined general quota left" :value (cred/format-aggregate-percent gen) :note (str (:windowLabel pool) " (all accounts)")}
                          {:title "Combined code review left" :value (cred/format-aggregate-percent (:codeReviewCombinedRemainingPercent pool))
                           :note (str (:codeReviewWindowLabel pool) " (all accounts)")}
                          {:title "Status" :value (str (:generalAvailableCount pool) " ok")
                           :note (str (:generalBlockedCount pool) " blocked · " (:generalCriticalCount pool) " critical")}
                          {:title "Next general reset"
                           :value (if (:nextResetWindow pool) (or (cred/format-reset-summary (:nextResetWindow pool) now-ms) "Unknown") "Unknown")
                           :note (if (:nextResetWindow pool) (cred/format-quota-window-label (:nextResetWindow pool) "Primary window") "No reset window data")}]}))
     :audit (when audit
              {:summary (str (:crossSuccessfulAccountHashCount audit) " multi-success-account hash(es) · "
                             (:crossAccountHashCount audit) " cross-account hash(es) · "
                             (:distinctHashCount audit) " distinct hash(es) · scanned "
                             (:scannedEntryCount audit) " recent OpenAI OAuth request(s)")
               :rows (mapv audit-row-view (:rows audit))
               :watch (mapv watch-row-view (cred/cache-watch-rows audit))})
     :sections (mapv (fn [s] (update s :accounts (fn [entries] (mapv #(tile-view ctx (not= grp "provider") %) entries)))) sections)
     :provider-health (mapv (fn [{:keys [providerId keyPool logs]}]
                              {:id providerId
                               :recent (str "Recent logs: " (or (:count logs) 0))
                               :last (when logs (str "Last request: " (fmt/format-datetime (:lastTimestamp logs))))
                               :pool (when keyPool [(str "Accounts ready: " (:availableAccounts keyPool) "/" (:totalAccounts keyPool))
                                                    (str "Cooldown accounts: " (:cooldownAccounts keyPool))])})
                            (cred/provider-health providers key-pool log-summary))
     :api-key api-key
     :device (when device-auth
               {:provider (:provider device-auth) :url (:verificationUrl device-auth) :code (:userCode device-auth)})
     :poll-label (fn [p] (if (and device-polling? (= p (:provider device-auth))) "Polling..." "Poll device flow"))
     :poll-disabled? (fn [p] (or (nil? device-auth) (not= p (:provider device-auth))))
     :status status :error error
     :log-provider (log-provider db) :log-account (log-account db)
     :account-ids (vec (sort (distinct (for [p providers a (:accounts p)] (:id a)))))
     :logs (mapv (fn [e]
                   (let [origin (fmt/format-request-origin e)
                         origin-part (if (and (not= origin "unknown") (not= origin "local")) (str " · from " origin) "")]
                     {:id (:id e)
                      :title (str (:providerId e) "/" (:accountId e))
                      :status-line (str (:status e) " · " (:latencyMs e) "ms")
                      :detail (str (:model e) " · " (:upstreamMode e) " · " (cred/format-service-tier e) " · " (cred/format-route-label e)
                                   origin-part " · " (fmt/format-datetime (:timestamp e))
                                   (when (number? (:totalTokens e)) (str " · " (:totalTokens e) " tok")))
                      :error (:error e)}))
                 logs)}))
