(ns proxx.tools.bulk-oauth-import
  "Bulk-import OpenAI OAuth accounts into a running proxy: for each account of a
  CSV, drive a browser through the OpenAI login (fetching the emailed
  verification code over IMAP when asked) and hand the resulting OAuth callback
  to the proxy. Run with `pnpm import:oauth:bulk`.

  Planning and every verdict about page text are pure (`proxx.tools.bulk-oauth`);
  this namespace is the effect edge: Playwright, IMAP, the proxy's HTTP API, the
  clock and the console."
  (:require ["node:fs" :as fs]
            ["node:http" :as http]
            ["playwright" :as pw]
            ["imapflow" :refer [ImapFlow]]
            [clojure.string :as str]
            [proxx.tools.bulk-oauth :as bo]))

(defn- sleep [ms] (js/Promise. (fn [resolve] (js/setTimeout resolve ms))))

(defn- say [& xs] (js/console.log (str/join " " xs)))
(defn- complain [& xs] (js/console.error (str/join " " xs)))

(defn- ^:async safe
  "Await `p`; `default` when it rejects (Playwright's `.catch(() => default)`)."
  [p default]
  (try (await p) (catch :default _ default)))

(defn- fail! [message] (throw (js/Error. message)))

(defn- retryable! [message]
  (throw (doto (js/Error. message) (aset "retryable" true))))

(defn- retryable? [^js e] (true? (.-retryable e)))

(defn- raise-verdict! [{:keys [message retryable?]}]
  (if retryable? (retryable! message) (fail! message)))

;; ---------------------------------------------------------------------------
;; Page helpers

(defn- ^:async body-text [^js page]
  (or (await (safe (.textContent (.locator page "body")) nil)) ""))

(defn- ^:async page-title [^js page] (await (safe (.title page) "")))

(defn- ^:async visible? [^js locator] (await (safe (.isVisible locator) false)))

(defn- ^:async screenshot [^js page dir label]
  (await (safe (.screenshot page #js {:path (str dir "/" (bo/sanitize label) ".png")}) nil)))

(defn- ^:async wait-for-cloudflare [^js page timeout-ms]
  (let [deadline (+ (js/Date.now) timeout-ms)]
    (loop []
      (when (>= (js/Date.now) deadline)
        (fail! "Cloudflare challenge did not resolve"))
      (let [title (await (page-title page))]
        (when (bo/cloudflare-title? title)
          (let [checkbox (.first (.locator page "input[type=\"checkbox\"]"))]
            (when (await (visible? checkbox)) (await (safe (.click checkbox) nil))))
          (let [frame (.first (.frameLocator page "iframe[src*=\"turnstile\"], iframe[title*=\"Cloudflare\"]"))
                cb (.first (.locator frame "input[type=\"checkbox\"], .cb-lb"))]
            (when (await (visible? cb)) (await (safe (.click cb) nil))))
          (await (.waitForTimeout page 1500))
          (recur))))))

;; ---------------------------------------------------------------------------
;; IMAP: the verification code

(defn- ^:async internal-date-ms
  "When the message with `uid` arrived (ms), or nil."
  [^js client uid]
  (let [meta (await (.fetchOne client uid #js {:internalDate true}))
        raw (some-> meta (aget "internalDate"))
        ms (cond (instance? js/Date raw) (.getTime raw)
                 (or (string? raw) (number? raw)) (.getTime (js/Date. raw)))]
    (when (and (number? ms) (js/Number.isFinite ms)) ms)))

(defn- ^:async search-uids [^js client] (or (await (.search client #js {:subject "ChatGPT"})) #js []))

(defn- ^:async baseline-uid
  "The newest matching message strictly older than `since-ms`: anything at or
  below it predates this login. 0 when none."
  [^js client since-ms]
  (let [lock (await (.getMailboxLock client "INBOX"))]
    (try
      (let [uids (await (search-uids client))]
        (loop [i (dec (.-length uids))]
          (if (neg? i)
            0
            (let [uid (or (aget uids i) 0)]
              (if (<= uid 0)
                (recur (dec i))
                (let [ms (await (internal-date-ms client uid))]
                  (if (and ms (< ms since-ms)) uid (recur (dec i)))))))))
      (finally (.release lock)))))

(defn- ^:async scan-inbox
  "Look at not-yet-checked matching messages, newest first, and return the code
  of the first one addressed to `recipient`; nil if none yet. Mutates `checked`
  (an atom of uids) so a message is read once."
  [^js client checked baseline since-ms recipient]
  (let [lock (await (.getMailboxLock client "INBOX"))]
    (try
      (let [uids (vec (await (search-uids client)))]
        (loop [[uid & more] (reverse (remove @checked uids))]
          (when (some? uid)
            (let [predates? (and (<= uid baseline)
                                 (let [ms (await (internal-date-ms client uid))] (and ms (< ms since-ms))))]
              (when-not predates?
                (swap! checked conj uid)
                (let [^js msg (await (.fetchOne client uid #js {:source true}))
                      source (some-> msg (aget "source") (.toString "utf8"))]
                  (or (when source (bo/verification-code source recipient))
                      (recur more))))))))
      (finally (.release lock)))))

(defn- ^:async fetch-verification-code
  [{:keys [host port user pass]} recipient since-ms timeout-ms]
  (let [^js client (ImapFlow. #js {:host host :port port :secure true :auth #js {:user user :pass pass} :logger false})]
    (await (.connect client))
    (try
      (let [deadline (+ (js/Date.now) timeout-ms)
            baseline (await (baseline-uid client since-ms))
            checked (atom #{})]
        (loop []
          (if (>= (js/Date.now) deadline)
            (fail! "Timed out waiting for verification email")
            (do (await (.noop client)) ; makes the server report new mail
                (or (await (scan-inbox client checked baseline since-ms recipient))
                    (do (await (sleep 4000)) (recur)))))))
      (finally (await (safe (.logout client) nil))))))

;; ---------------------------------------------------------------------------
;; The proxy

(defn- ^:async proxy-start-browser-oauth [{:keys [proxy-base proxy-token]}]
  (let [^js res (await (js/fetch (str proxy-base "/api/v1/credentials/openai/oauth/browser/start")
                                 #js {:method "POST"
                                      :headers (clj->js (cond-> {"content-type" "application/json"}
                                                          (seq proxy-token) (assoc "authorization" (str "Bearer " proxy-token))))
                                      :body (js/JSON.stringify #js {:redirectBaseUrl proxy-base})}))]
    (when-not (.-ok res)
      (fail! (str "Proxy browser/start: " (.-status res) " " (await (.text res)))))
    (await (.json res))))

(defn- ^:async proxy-complete-callback [{:keys [proxy-base]} code state]
  (let [^js res (await (js/fetch (str proxy-base "/api/v1/credentials/openai/oauth/browser/callback?code=" (js/encodeURIComponent code)
                                      "&state=" (js/encodeURIComponent state))))
        body (await (.text res))]
    (when-not (str/includes? body "Successful")
      (fail! (str "Proxy callback: " (.-status res) " " (subs body 0 (min 200 (count body))))))))

;; ---------------------------------------------------------------------------
;; Local callback server (capture mode): remembers the last code it was handed

(def ^:private no-capture {:code "" :state ""})

(defn- ^:async start-callback-server [port]
  (let [capture (atom no-capture)
        ^js server (.createServer http
                                  (fn [^js req ^js res]
                                    (let [url (js/URL. (or (.-url req) "/") (str "http://localhost:" port))
                                          code (or (.get (.-searchParams url) "code") "")
                                          state (or (.get (.-searchParams url) "state") "")]
                                      (when (seq code) (reset! capture {:code code :state state}))
                                      (.writeHead res 200 #js {"Content-Type" "text/html"})
                                      (.end res "<html><body><h1>OAuth callback captured. You can close this tab.</h1></body></html>"))))]
    (await (js/Promise. (fn [resolve reject]
                          (.once server "error" reject)
                          (.listen server port "127.0.0.1" (fn [] (.off server "error" reject) (resolve nil))))))
    {:server server
     :capture #(deref capture)
     :reset! #(reset! capture no-capture)}))

;; ---------------------------------------------------------------------------
;; OpenAI login automation. Returns {:kind :capture :code :state} or {:kind :proxy}.

(def ^:private submit-button "button[type=\"submit\"], button:has-text(\"Continue\")")

(defn- captured [get-capture]
  (let [{:keys [code state]} (when get-capture (get-capture))]
    (when (seq code) {:kind :capture :code code :state state})))

(defn- ^:async check-retryable-page! [page]
  (when-let [verdict (bo/retryable-page-error (await (body-text page)))]
    (raise-verdict! verdict)))

(defn- ^:async submit-email [^js page email]
  (let [input (.first (.locator page "input[name=\"email\"], input[type=\"email\"], input[name=\"username\"], input[autocomplete=\"email\"]"))]
    (await (.waitFor input #js {:state "visible" :timeout 15000}))
    (await (.fill input email))
    (await (.click (.first (.locator page submit-button))))
    (say "  email submitted")))

(defn- ^:async fill-password
  "Wait up to six polls for the password field; a capture or a transient error
  page ends the wait early. Returns a capture result, or nil once filled."
  [^js page password get-capture]
  (let [input (.first (.locator page "input[type=\"password\"]"))]
    (loop [attempt 0]
      (cond
        (>= attempt 6) :missing
        (await (visible? input)) (do (await (.fill input password)) nil)
        :else (do (await (check-retryable-page! page))
                  (or (captured get-capture)
                      (do (await (.waitForTimeout page 2000)) (recur (inc attempt)))))))))

(defn- ^:async verify-by-email!
  "Fetch the emailed code (resending once if the first wait times out) and enter it."
  [^js page imap email login-start debug-dir label]
  (say "  email verification required, checking IMAP...")
  (when (or (str/blank? (:user imap)) (str/blank? (:pass imap)))
    (fail! "Email verification required but IMAP_USER/IMAP_PASS not set"))
  (let [code (try (await (fetch-verification-code imap email login-start 45000))
                  (catch :default _
                    (say "  code not found yet, clicking Resend email...")
                    (let [resend (.first (.locator page "button:has-text(\"Resend\"), a:has-text(\"Resend\")"))]
                      (when (await (visible? resend))
                        (await (.click resend))
                        (await (.waitForTimeout page 2000))))
                    (await (fetch-verification-code imap email login-start 60000))))
        input (.first (.locator page "input[name=\"code\"], input[placeholder*=\"Code\" i], input[type=\"text\"]"))]
    (say "  got verification code")
    (await (.waitFor input #js {:state "visible" :timeout 10000}))
    (await (.fill input code))
    (await (.click (.first (.locator page submit-button))))
    (say "  verification code submitted")
    (await (.waitForTimeout page 5000))
    (await (screenshot page debug-dir (str label "-after-verify")))))

(defn- ^:async click-consent! [^js page]
  (say "  consent page detected, clicking Continue...")
  (let [button (.first (.locator page "button:has-text(\"Continue\")"))]
    (await (safe (.waitFor button #js {:state "visible" :timeout 5000}) nil))
    (when (await (visible? button))
      (await (.click button))
      (await (.waitForTimeout page 5000)))))

(defn- ^:async await-callback
  "Poll for up to 30s: fail on a dead-end page, click through consent, and
  return once the callback was captured or the proxy page says Successful."
  [^js page {:keys [callback-port callback-mode]} get-capture]
  (let [deadline (+ (js/Date.now) 30000)]
    (loop []
      (when (>= (js/Date.now) deadline) (throw ::timed-out))
      (let [text (await (body-text page))]
        (when-let [message (bo/waiting-failure text (.url page))] (fail! message))
        (or (captured get-capture)
            (do
              (when (bo/authorize-or-consent-url? (.url page))
                (let [button (.first (.locator page "button:has-text(\"Continue\"), button:has-text(\"Allow\"), button:has-text(\"Authorize\"), button:has-text(\"Accept\")"))]
                  (when (await (visible? button))
                    (say "  clicking consent/authorize")
                    (await (.click button))
                    (await (.waitForTimeout page 3000)))))
              (if (bo/callback-landed? (.url page) callback-port)
                (if (and (= :proxy callback-mode) (str/includes? text "Successful"))
                  {:kind :proxy}
                  (do (await (.waitForTimeout page 1000))
                      (or (captured get-capture)
                          (do (when (bo/just-a-moment? (await (page-title page)))
                                (await (safe (wait-for-cloudflare page 20000) nil)))
                              (await (.waitForTimeout page 1000))
                              (recur)))))
                (do (when (bo/just-a-moment? (await (page-title page)))
                      (await (safe (wait-for-cloudflare page 20000) nil)))
                    (await (.waitForTimeout page 1000))
                    (recur))))))))) 

(defn- ^:async automate-login
  [^js page settings imap authorize-url email password label get-capture]
  (let [{:keys [debug-dir]} settings
        login-start (js/Date.now)]
    (await (.goto page authorize-url #js {:waitUntil "domcontentloaded" :timeout 30000}))
    (when (bo/cloudflare-title? (await (page-title page)))
      (say "  waiting for Cloudflare...")
      (await (wait-for-cloudflare page 45000)))
    (await (.waitForTimeout page 2000))
    ;; step 1: email
    (await (submit-email page email))
    (await (.waitForTimeout page 3000))
    (await (check-retryable-page! page))
    (or
     (captured get-capture)
     (do
       (when (bo/just-a-moment? (await (page-title page)))
         (await (wait-for-cloudflare page 30000))
         (await (.waitForTimeout page 2000)))
       ;; step 2: password
       (let [pw-result (await (fill-password page password get-capture))]
         (cond
           (map? pw-result) pw-result

           (= :missing pw-result)
           (do (await (screenshot page debug-dir (str label "-no-pw")))
               (let [text (await (body-text page))]
                 (when-let [verdict (bo/retryable-page-error text)] (raise-verdict! verdict))
                 (fail! (str "No password field. URL: " (.url page) " Body: " (bo/compact-text text)))))

           :else
           (do
             (await (.click (.first (.locator page submit-button))))
             (say "  password submitted")
             (await (.waitForTimeout page 3000))
             (await (screenshot page debug-dir (str label "-after-pw")))
             (or
              (captured get-capture)
              (let [cur-url (.url page)
                    text (await (body-text page))]
                ;; step 3: dead ends
                (when-let [message (bo/post-password-failure text)] (fail! message))
                ;; step 4: email verification, if asked for
                (let [early
                      (when (bo/email-verification-required? cur-url text)
                        (await (verify-by-email! page imap email login-start debug-dir label))
                        (let [after (or (await (safe (.textContent (.locator page "body")) nil)) "")]
                          (when (bo/account-gone? after) (fail! "Account deleted or deactivated")))
                        (or (captured get-capture)
                            (do (when (bo/consent-url? (.url page)) (await (click-consent! page)))
                                nil)))]
                  (or early
                      ;; step 5: wait for the callback
                      (try (await (await-callback page settings get-capture))
                           (catch :default e
                             (if (= ::timed-out e)
                               (do (await (screenshot page debug-dir (str label "-timeout")))
                                   (let [text (await (body-text page))]
                                     (when (bo/email-verification-required? (.url page) text)
                                       (retryable! (str "Timed out on email verification page for " email)))
                                     (fail! (str "Timed out. URL: " (.url page) ", title: " (await (.title page))))))
                               (throw e))))))))))))))) 

;; ---------------------------------------------------------------------------
;; Main

(defn- ^:async attempt-login
  "One login attempt in a fresh browser context. Resolves to :ok, or
  {:message :retryable?} for a failure."
  [^js browser settings imap callback-server label {:keys [username password]}]
  (when callback-server ((:reset! callback-server)))
  (let [^js context (await (.newContext browser #js {:userAgent "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                                                      :viewport #js {:width 1280 :height 800}
                                                      :locale "en-US"}))
        page (await (.newPage context))]
    (try
      (let [^js started (await (proxy-start-browser-oauth settings))
            result (await (automate-login page settings imap (.-authorizeUrl started) username password label
                                          (:capture callback-server)))]
        (when (= :capture (:kind result))
          (say "  completing via proxy...")
          (await (proxy-complete-callback settings (:code result) (:state result))))
        (say "  SUCCESS\n")
        :ok)
      (catch :default e
        {:message (if (instance? js/Error e) (.-message e) (str e))
         :retryable? (and (instance? js/Error e) (retryable? e))})
      (finally (await (.close context))))))

(defn- ^:async process-account
  "Try one account up to :max-login-attempts times; the report entry."
  [browser {:keys [max-login-attempts] :as settings} imap callback-server label row]
  (loop [attempt 1 last-error "unknown"]
    (if (> attempt max-login-attempts)
      (do (complain (str "  FAILED: " last-error "\n"))
          (bo/result-entry (:username row) last-error))
      (do
        (when (> attempt 1) (say (str "  retrying login attempt " attempt "/" max-login-attempts "...")))
        (let [outcome (await (attempt-login browser settings imap callback-server label row))]
          (if (= :ok outcome)
            (bo/result-entry (:username row) :ok)
            (let [{:keys [message]} outcome]
              (if (bo/retry? outcome attempt max-login-attempts)
                (do (complain (str "  RETRYABLE: " message))
                    (await (sleep 3000))
                    (recur (inc attempt) message))
                (do (complain (str "  FAILED: " message "\n"))
                    (bo/result-entry (:username row) message))))))))))

(defn- env-map []
  (let [env (.-env js/process)]
    (into {} (map (fn [k] [k (aget env k)])) (js/Object.keys env))))

(defn- ^:async check-imap! [{:keys [host port user pass]}]
  (say "Testing IMAP connection...")
  (let [^js client (ImapFlow. #js {:host host :port port :secure true :auth #js {:user user :pass pass} :logger false})]
    (await (.connect client))
    (await (.logout client))
    (say "IMAP connection OK\n")))

(defn- ^:async run [settings]
  (let [{:keys [proxy-base proxy-token csv-path headless? callback-mode callback-port
                max-login-attempts debug-dir start-index delay-ms]} settings]
    (when (str/blank? proxy-token)
      (complain "Required env vars: PROXY_AUTH_TOKEN")
      (complain "Optional env vars: IMAP_USER, IMAP_PASS, IMAP_GMAIL_ACCOUNT, CSV_PATH, START_INDEX, MAX_ACCOUNTS, DELAY_MS, HEADLESS, DEBUG_DIR")
      (.exit js/process 1))
    (.mkdirSync fs debug-dir #js {:recursive true})
    (let [imap0 (:imap settings)]
      (say (str "CSV: " csv-path))
      (say (str "Proxy: " proxy-base))
      (say (str "IMAP: " (if (seq (:user imap0)) (str (:user imap0) " @ " (:host imap0)) "NOT SET (email verification will fail)")))
      (say (str "Headless: " headless?))
      (say (str "Callback mode: " (name callback-mode)))
      (say (str "Max login attempts: " max-login-attempts))
      (say (str "Debug: " debug-dir "\n"))
      (let [rows (bo/parse-csv (.readFileSync fs csv-path "utf8"))
            ;; Gmail credentials may be borrowed from the same CSV
            imap (if (and (or (str/blank? (:user imap0)) (str/blank? (:pass imap0)))
                          (seq (:gmail-account imap0)))
                   (let [creds (or (bo/gmail-credentials rows (:gmail-account imap0))
                                   (fail! (str "IMAP_USER/IMAP_PASS not set and could not extract credentials from CSV for " (:gmail-account imap0)
                                               ". Set IMAP_USER/IMAP_PASS (or GMAIL_APP_EMAIL/GMAIL_APP_PASSWORD), or add a matching google.com entry to the CSV.")))]
                     (say (str "IMAP credentials extracted from CSV for " (:user creds)))
                     (merge imap0 creds))
                   (do (when (or (str/blank? (:user imap0)) (str/blank? (:pass imap0)))
                         (say "IMAP credentials not configured; email verification challenges will fail."))
                       imap0))
            openai (bo/openai-rows rows)
            _ (say (str "Found " (count openai) " OpenAI accounts (" (count rows) " total in CSV)"))
            accounts (bo/plan rows start-index (:max-accounts settings))]
        (if (empty? accounts)
          (say "Nothing to process.")
          (do
            (say (str "Processing " (count accounts) " unique accounts (index " start-index "+)\n"))
            (when (and (seq (:user imap)) (seq (:pass imap))) (await (check-imap! imap)))
            (let [callback-server (when (= :capture callback-mode) (await (start-callback-server callback-port)))
                  _ (if callback-server
                      (say (str "Starting callback server on :" callback-port "..."))
                      (say (str "Using direct proxy callback mode on :" callback-port "...")))
                  ^js browser (await (.launch (.-chromium pw)
                                              #js {:headless headless?
                                                   :args #js ["--disable-blink-features=AutomationControlled" "--no-sandbox"]}))
                  total (count accounts)
                  results (loop [i 0 results []]
                            (if (= i total)
                              results
                              (let [row (nth accounts i)
                                    label (str (inc i) "of" total "-" (bo/sanitize (:username row)))
                                    _ (say (str "[" (inc i) "/" total "] " (:username row)))
                                    entry (await (process-account browser settings imap callback-server label row))]
                                (when (< i (dec total)) (await (sleep delay-ms)))
                                (recur (inc i) (conj results entry)))))]
              (await (.close browser))
              (some-> callback-server :server (.close))
              (let [{:keys [ok failed total failures]} (bo/summary results)]
                (say "=== RESULTS ===")
                (say (str "Success: " ok " | Failed: " failed " | Total: " total))
                (when (pos? failed)
                  (say "\nFailed:")
                  (doseq [{:keys [email status]} failures] (say (str "  " email ": " status))))))))))))

(defn main [& _]
  (-> (run (bo/config (env-map) (.cwd js/process)))
      (.catch (fn [e] (js/console.error "Fatal:" e) (.exit js/process 1)))))
