(ns proxx.tools.bulk-oauth
  "Pure planning and verdicts for the bulk OpenAI OAuth import script
  (`proxx.tools.bulk-oauth-import`): what the CSV holds, which accounts to
  process, what a login page's text means, and where the verification code is.
  The browser, IMAP session, proxy calls and clock are the script's edge.

  Page and mail text are matched by substring/regex exactly as the script's
  TypeScript predecessor did; the strings belong to OpenAI's pages."
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Configuration (env is a plain string-keyed map)

(defn- finite-number [s]
  (when (and (string? s) (not (str/blank? s)))
    (let [n #?(:cljs (js/Number s) :clj (try (Double/parseDouble (str/trim s)) (catch Exception _ ##NaN)))]
      (when (and (number? n) #?(:cljs (js/Number.isFinite n)
                                 :clj (not (or (Double/isNaN n) (Double/isInfinite n)))))
        n))))

(defn- num-env
  "A numeric variable; a missing, blank or non-numeric value is the default."
  [env k default]
  (or (finite-number (get env k)) default))

(defn- str-env [env k default] (or (get env k) default))

(defn- first-present
  "The first of `ks` that is set in env (as `??` would pick), trimmed."
  [env & ks]
  (str/trim (or (some #(get env %) ks) "")))

(defn config
  "The script's settings from the environment, with its documented defaults.
  `cwd` anchors the default CSV path."
  [env cwd]
  (let [port (num-env env "OPENAI_OAUTH_CALLBACK_PORT" 1455)]
    {:proxy-base (str-env env "PROXY_BASE_URL" "http://localhost:8789")
     :proxy-token (str-env env "PROXY_AUTH_TOKEN" "")
     :callback-port (if (pos? port) port 1455)
     :csv-path (str-env env "CSV_PATH" (str cwd "/../../passwords.csv"))
     :delay-ms (num-env env "DELAY_MS" 4000)
     :headless? (= "true" (get env "HEADLESS"))
     :start-index (num-env env "START_INDEX" 0)
     :max-accounts (num-env env "MAX_ACCOUNTS" 9999)
     :debug-dir (str-env env "DEBUG_DIR" "/tmp/oauth-debug")
     :callback-mode (if (= "capture" (get env "OAUTH_CALLBACK_MODE")) :capture :proxy)
     :max-login-attempts (num-env env "MAX_LOGIN_ATTEMPTS" 3)
     :imap {:host (str-env env "IMAP_HOST" "imap.gmail.com")
            :port (num-env env "IMAP_PORT" 993)
            :gmail-account (first-present env "IMAP_GMAIL_ACCOUNT" "IMAP_USER" "GMAIL_APP_EMAIL")
            :user (first-present env "IMAP_USER" "GMAIL_APP_EMAIL")
            :pass (first-present env "IMAP_PASS" "GMAIL_APP_PASSWORD")}}))

;; ---------------------------------------------------------------------------
;; CSV: header row, then url,username,password (quotes with "" escapes)

(defn parse-csv-line
  "The fields of one line. A quote toggles quoting; `\"\"` inside quotes is a
  literal quote; commas outside quotes separate fields."
  [line]
  (let [n (count line)
        {:keys [fields current]}
        (loop [i 0 quoted? false current "" fields []]
          (if (= i n)
            {:fields fields :current current}
            (let [ch (nth line i)]
              (cond
                (and quoted? (= ch \") (= (nth line (inc i) nil) \"))
                (recur (+ i 2) true (str current \") fields)

                quoted?
                (if (= ch \")
                  (recur (inc i) false current fields)
                  (recur (inc i) true (str current ch) fields))

                (= ch \") (recur (inc i) true current fields)
                (= ch \,) (recur (inc i) false "" (conj fields current))
                :else (recur (inc i) false (str current ch) fields)))))]
    (conj fields current)))

(defn- strip-quotes [s]
  (if (and (str/starts-with? s "\"") (str/ends-with? s "\""))
    (if (< (count s) 2) "" (subs s 1 (dec (count s))))
    s))

(defn parse-csv
  "Rows [{:url :username :password}] of a CSV text: the first non-blank line is
  a header, blank lines and lines with fewer than three fields are skipped."
  [text]
  (->> (str/split text #"\r?\n")
       (remove #(str/blank? %))
       rest
       (keep (fn [line]
               (let [[url username password :as fields] (parse-csv-line line)]
                 (when (>= (count fields) 3)
                   {:url (strip-quotes url)
                    :username (strip-quotes username)
                    :password (strip-quotes password)}))))
       vec))

(defn sanitize
  "A file-name-safe rendering of a label."
  [s]
  (str/replace s #"[^a-zA-Z0-9._@-]" "_"))

(defn compact-text
  "Whitespace-collapsed, trimmed text cut to `max-length` (default 200)."
  ([text] (compact-text text 200))
  ([text max-length]
   (let [t (str/trim (str/replace text #"\s+" " "))]
     (subs t 0 (min max-length (count t))))))

;; ---------------------------------------------------------------------------
;; Which accounts to process

(defn gmail-credentials
  "{:user :pass} for the Gmail account named `account`, from a google.com row of
  the CSV; nil when no row matches. Throws on a blank account."
  [rows account]
  (let [normalized (str/lower-case (str/trim account))]
    (when (empty? normalized)
      (throw (ex-info "Missing IMAP account. Set IMAP_USER/GMAIL_APP_EMAIL or IMAP_GMAIL_ACCOUNT to auto-extract IMAP credentials from CSV."
                      {:error/type ::missing-imap-account})))
    (let [username-only (str/replace normalized #"@gmail\.com$" "")]
      (some (fn [{:keys [url username password]}]
              (when (and (str/includes? url "google.com")
                         (let [u (str/lower-case username)] (or (= u normalized) (= u username-only))))
                {:user (if (str/includes? normalized "@") normalized (str normalized "@gmail.com"))
                 :pass password}))
            rows))))

(defn openai-rows [rows]
  (filterv #(or (str/includes? (:url %) "openai.com") (str/includes? (:url %) "chatgpt.com")) rows))

(defn plan
  "The accounts to process: OpenAI rows, windowed by start/max, first row per
  username (case-insensitive) wins."
  [rows start max-accounts]
  (let [start (long start)]
    (->> (openai-rows rows)
         (drop start)
         (take max-accounts)
         (reduce (fn [{:keys [seen out]} row]
                   (let [k (str/lower-case (:username row))]
                     (if (seen k) {:seen seen :out out} {:seen (conj seen k) :out (conj out row)})))
                 {:seen #{} :out []})
         :out)))

;; ---------------------------------------------------------------------------
;; What a page's text means. A verdict is nil (nothing noteworthy) or
;; {:message ... :retryable? bool}.

(defn retryable-page-error
  "A transient OpenAI failure page, or nil."
  [body]
  (cond
    (or (str/includes? body "Oops, an error occurred") (str/includes? body "Operation timed out"))
    {:message (str "OpenAI login page timed out: " (compact-text body)) :retryable? true}

    (and (str/includes? body "Authentication Error") (str/includes? body "unknown_error"))
    {:message (str "OpenAI authentication error page: " (compact-text body)) :retryable? true}))

(defn- excerpt
  "The first `n` characters of `text`, whitespace-collapsed (cut first, then
  collapsed, so the result may be shorter than `n`)."
  [text n]
  (str/trim (str/replace (subs text 0 (min n (count text))) #"\s+" " ")))

(defn- includes-any? [s needles] (some #(str/includes? s %) needles))

(defn post-password-failure
  "Why the page after submitting the password is a dead end, or nil."
  [body]
  (cond
    (str/includes? body "Incorrect email address or password") "Wrong password"
    (str/includes? body "Too many login attempts") "Rate limited"
    (includes-any? body ["account has been locked" "Account locked"]) "Account locked"))

(defn account-gone? [text]
  (boolean (includes-any? text ["deleted or deactivated" "do not have an account"])))

(defn email-verification-required? [url body]
  (or (str/includes? url "email-verification") (str/includes? body "Check your inbox")))

(defn consent-url? [url] (str/includes? url "consent"))

(defn authorize-or-consent-url? [url]
  (or (str/includes? url "consent") (str/includes? url "authorize")))

(defn waiting-failure
  "While waiting for the OAuth callback: the page text that ends the wait with a
  failure message, or nil."
  [body]
  (cond
    (includes-any? body ["Incorrect" "invalid code" "expired"])
    (str "Verification failed: " (subs body 0 (min 100 (count body))))

    (account-gone? body) "Account deleted or deactivated"

    (str/includes? body "Oops, an error occurred")
    (str "OpenAI error page: " (excerpt body 200))

    (str/includes? body "Authentication Error")
    (str "OpenAI authentication error: " (excerpt body 240))))

(defn callback-landed?
  "True when the browser reached the local callback port (or a Chrome error
  page, which is what a refused localhost connection looks like)."
  [url port]
  (boolean (or (str/includes? url (str "localhost:" port))
               (str/includes? url (str "127.0.0.1:" port))
               (str/includes? url "chrome-error"))))

(defn cloudflare-title?
  "A Cloudflare interstitial: \"Just a moment\" or \"Checking\"."
  [title]
  (boolean (includes-any? title ["Just a moment" "Checking"])))

(defn just-a-moment?
  "The narrower interstitial test the script applies mid-flow."
  [title]
  (str/includes? title "Just a moment"))

;; ---------------------------------------------------------------------------
;; The verification email

(defn verification-code
  "The six-digit code in a message source addressed to `recipient`, or nil.
  The subject line wins over a loose \"code is\" mention."
  [source recipient]
  (when (str/includes? (str/lower-case source) (str/lower-case recipient))
    (or (second (re-find #"(?i)Your ChatGPT code is (\d{6})" source))
        (second (re-find #"(?i)(?:verification code|code is|your code)[:\s]*(\d{6})" source)))))

;; ---------------------------------------------------------------------------
;; Retries and the final report

(defn retry?
  "Whether a failed login attempt is retried: only transient failures, and only
  while attempts remain."
  [{:keys [retryable?]} attempt max-attempts]
  (boolean (and retryable? (< attempt max-attempts))))

(defn result-entry
  "The report line for an account. An error's text is cut to 120 characters."
  [email outcome]
  (if (= :ok outcome)
    {:email email :status "ok"}
    (let [msg (str outcome)]
      {:email email :status (str "error: " (subs msg 0 (min 120 (count msg))))})))

(defn summary
  "{:ok :failed :total :failures} of a vector of result entries."
  [results]
  (let [failures (filterv #(not= "ok" (:status %)) results)]
    {:ok (- (count results) (count failures))
     :failed (count failures)
     :total (count results)
     :failures failures}))
