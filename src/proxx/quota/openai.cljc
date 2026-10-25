(ns proxx.quota.openai
  "Pure decisions behind OpenAI (ChatGPT/Codex) account quota and liveness probes.

  Everything here is a function of already-fetched facts: usage JSON, error
  bodies, JWT claims, an account view, and an explicit `now-ms`. Fetching,
  token refresh calls and credential persistence are effects sequenced by
  proxx.runtime.quota around these verdicts.

  Wire payloads are string-keyed and untrusted: malformed values are dropped.
  Accounts are domain maps with keyword keys
  {:id :display-name :email :plan-type :chatgpt-account-id :secret
   :refresh-token :expires-at :auth-type :subject}."
  (:require [clojure.string :as str]
            [proxx.json :as json]
            [proxx.jsval :as j]))

;; ---------------------------------------------------------------------------
;; JWT claims -> account metadata
;; ---------------------------------------------------------------------------

(defn jwt-claims
  "Claims (string-keyed map) of a three-part JWT, or nil. `decode` turns the
  base64url payload segment into a UTF-8 string and is supplied by the edge."
  [token decode]
  (let [parts (str/split token #"\." -1)]
    (when (= 3 (count parts))
      (try
        (j/rec (json/parse (decode (nth parts 1 ""))))
        (catch #?(:cljs :default :clj Exception) _ nil)))))

(defn- non-blank [s] (when (and s (seq s)) s))

(defn oauth-metadata
  "{:email :subject :chatgpt-account-id :plan-type} derived from an access token's
  claims; absent or blank facts are omitted."
  [claims]
  (if-not claims
    {}
    (let [profile (j/rec (get claims "https://api.openai.com/profile"))
          auth (j/rec (get claims "https://api.openai.com/auth"))
          email (some-> (j/first-non-nil (j/as-string (get claims "email")) (j/as-string (get profile "email")))
                        j/trim j/lower)
          subject (some-> (j/as-string (get claims "sub")) j/trim)
          account-id (some-> (j/first-non-nil (j/as-string (get claims "chatgpt_account_id"))
                                              (j/as-string (get auth "chatgpt_account_id")))
                             j/trim)
          plan (some-> (j/as-string (get auth "chatgpt_plan_type")) j/trim j/lower)]
      (cond-> {}
        (non-blank email) (assoc :email email)
        (non-blank subject) (assoc :subject subject)
        (non-blank account-id) (assoc :chatgpt-account-id account-id)
        (non-blank plan) (assoc :plan-type plan)))))

;; ---------------------------------------------------------------------------
;; Usage payload -> quota windows
;; ---------------------------------------------------------------------------

(defn- normalize-percent [value]
  (let [v (if (and (> value 0) (< value 1)) (* value 100) value)]
    (min 100 (max 0 v))))

(defn- epoch-ms [n] (if (> n 1e12) (j/round n) (j/round (* n 1000))))

(defn- reset-timestamp-ms [value]
  (cond
    (j/finite? value) (epoch-ms value)
    (not (string? value)) nil
    :else (let [trimmed (j/trim value)]
            (when (seq trimmed)
              (let [n (j/js-number trimmed)]
                (if (j/finite? n) (epoch-ms n) (j/parse-date-ms trimmed)))))))

(defn- resets-at [resets reset-after now-ms]
  (if-let [ts (reset-timestamp-ms resets)]
    (j/iso-string ts)
    (when (j/finite? reset-after)
      (j/iso-string (+ now-ms (* reset-after 1000))))))

(defn- reset-after-seconds [resets reset-after now-ms]
  (cond
    (j/finite? reset-after) (max 0 (j/round reset-after))
    :else (when-let [ts (reset-timestamp-ms resets)]
            (max 0 (j/round (/ (- ts now-ms) 1000))))))

(defn- num-of [m & ks] (apply j/first-non-nil (map #(j/as-number (get m %)) ks)))

(defn parse-window
  "A quota window {:used-percent :remaining-percent :resets-at :reset-after-seconds
  :limit-window-seconds} from any of the field spellings providers use, or nil
  when the object carries no usable fact. Missing percentages are derived from
  each other or from unit counts."
  [value now-ms]
  (when-let [v (j/rec value)]
    (let [raw-used (num-of v "used_percent" "usedPercent" "percent_used" "percentUsed")
          raw-remaining (num-of v "remaining_percent" "remainingPercent" "percent_remaining" "percentRemaining")
          used-units (num-of v "used" "used_units" "usedUnits" "used_tokens" "usedTokens")
          remaining-units (num-of v "remaining" "remaining_units" "remainingUnits" "remaining_tokens" "remainingTokens")
          limit-units (num-of v "limit" "quota" "total" "max" "maximum")
          raw-resets (j/first-non-nil (get v "resets_at") (get v "resetsAt") (get v "reset_at")
                                      (get v "resetAt") (get v "reset"))
          raw-reset-after (num-of v "reset_after_seconds" "resetAfterSeconds")
          raw-limit-window (num-of v "limit_window_seconds" "limitWindowSeconds")
          used0 (some-> raw-used normalize-percent)
          remaining0 (some-> raw-remaining normalize-percent)
          remaining1 (if (and (nil? remaining0) (some? used0)) (max 0 (- 100 used0)) remaining0)
          used1 (if (and (nil? used0) (some? remaining1)) (max 0 (- 100 remaining1)) used0)
          from-units? (and (or (nil? used1) (nil? remaining1)) (some? limit-units) (> limit-units 0))
          used (if (and from-units? (nil? used1) (some? used-units))
                 (normalize-percent (* (/ used-units limit-units) 100))
                 used1)
          remaining (if (and from-units? (nil? remaining1) (some? remaining-units))
                      (normalize-percent (* (/ remaining-units limit-units) 100))
                      remaining1)
          resets (resets-at raw-resets raw-reset-after now-ms)
          after (reset-after-seconds raw-resets raw-reset-after now-ms)]
      (when-not (and (nil? used) (nil? remaining) (not resets) (nil? after) (nil? raw-limit-window))
        {:used-percent used
         :remaining-percent remaining
         :resets-at resets
         :reset-after-seconds after
         :limit-window-seconds raw-limit-window}))))

(defn parse-rate-limit
  "{:allowed :limit-reached :primary-window :secondary-window} or nil when empty."
  [value now-ms]
  (when-let [v (j/rec value)]
    (let [primary (parse-window (j/first-non-nil (get v "primary_window") (get v "primaryWindow") (get v "primary")) now-ms)
          secondary (parse-window (j/first-non-nil (get v "secondary_window") (get v "secondaryWindow") (get v "secondary")) now-ms)
          allowed (j/as-boolean (get v "allowed"))
          reached (j/first-non-nil (j/as-boolean (get v "limit_reached")) (j/as-boolean (get v "limitReached")))]
      (when-not (and (nil? allowed) (nil? reached) (nil? primary) (nil? secondary))
        {:allowed allowed :limit-reached reached :primary-window primary :secondary-window secondary}))))

(defn- usage-root [payload]
  (when-let [p (j/rec payload)]
    (or (j/rec (get p "usage")) p)))

(defn plan-type
  "The payload's lower-cased plan type, else `fallback`."
  [payload fallback]
  (let [plan (some-> (usage-root payload) (get "plan_type") j/as-string j/trim j/lower)]
    (if (seq plan) plan fallback)))

(defn quota-details
  "{:five-hour :weekly :rate-limit :code-review-rate-limit} of a usage payload."
  [payload now-ms]
  (if-let [usage (usage-root payload)]
    (let [rate-limit (parse-rate-limit (j/first-non-nil (get usage "rate_limit") (get usage "rateLimit")) now-ms)
          code-review (parse-rate-limit (j/first-non-nil (get usage "code_review_rate_limit") (get usage "codeReviewRateLimit")) now-ms)
          primary (or (:primary-window rate-limit)
                      (parse-window (j/first-non-nil (get usage "primary") (get usage "session") (get usage "fiveHour") (get usage "five_hour")) now-ms))
          secondary (or (:secondary-window rate-limit)
                        (parse-window (j/first-non-nil (get usage "secondary") (get usage "weekly") (get usage "week")) now-ms))]
      {:five-hour primary :weekly secondary :rate-limit rate-limit :code-review-rate-limit code-review})
    {:five-hour nil :weekly nil :rate-limit nil :code-review-rate-limit nil}))

;; ---------------------------------------------------------------------------
;; Error bodies
;; ---------------------------------------------------------------------------

(defn- parse-body [text] (try (json/parse text) (catch #?(:cljs :default :clj Exception) _ ::unparsable)))

(defn error-message
  "A one-line message for a failed quota/probe response."
  [status text]
  (let [trimmed (j/trim text)]
    (if (empty? trimmed)
      (str "HTTP " status)
      (let [parsed (j/rec (parse-body trimmed))
            detail (j/rec (get parsed "detail"))
            detail-code (some-> (j/as-string (get detail "code")) j/trim)
            detail-message (some-> (j/as-string (get detail "message")) j/trim)
            error (j/rec (get parsed "error"))
            message (when parsed
                      (j/first-non-nil (j/as-string (get parsed "message"))
                                       (when error (j/first-non-nil (j/as-string (get error "message"))
                                                                    (j/as-string error)))
                                       (j/as-string (get parsed "detail"))))]
        (cond
          (seq detail-code) (if (seq detail-message) (str detail-code ": " detail-message) detail-code)
          (and message (seq (j/trim message))) (j/trim message)
          (> (count trimmed) 160) (str (subs trimmed 0 157) "...")
          :else trimmed)))))

(defn error-code
  "The lower-cased machine code of a failed response body, or nil."
  [text]
  (let [trimmed (j/trim text)]
    (when (seq trimmed)
      (when-let [parsed (j/rec (parse-body trimmed))]
        (let [detail-code (some-> (j/rec (get parsed "detail")) (get "code") j/as-string j/trim j/lower)
              error (j/rec (get parsed "error"))
              error-code (some-> (j/first-non-nil (j/as-string (get error "code")) (j/as-string (get parsed "code")))
                                 j/trim j/lower)]
          (if (seq detail-code) detail-code (when (seq error-code) error-code)))))))

(defn retry-without-workspace?
  "A deactivated or invalid workspace id is retried once with no workspace header."
  [code chatgpt-account-id]
  (boolean (and (contains? #{"deactivated_workspace" "invalid_workspace"} code)
                (string? chatgpt-account-id)
                (seq (j/trim chatgpt-account-id)))))

;; ---------------------------------------------------------------------------
;; Accounts
;; ---------------------------------------------------------------------------

(defn needs-refresh?
  "An OAuth account whose token expires within `buffer-ms`."
  [{:keys [auth-type expires-at]} now-ms buffer-ms]
  (and (= "oauth_bearer" auth-type)
       (number? expires-at)
       (<= expires-at (+ now-ms buffer-ms))))

(defn refreshed-tokens
  "{:access-token :refresh-token :expires-at?} from a token endpoint payload, or nil."
  [payload now-ms]
  (when-let [p (j/rec payload)]
    (let [access (some-> (j/as-string (get p "access_token")) j/trim)
          refresh (some-> (j/as-string (get p "refresh_token")) j/trim)
          expires-in (j/as-number (get p "expires_in"))]
      (when (and (seq access) (seq refresh))
        (cond-> {:access-token access :refresh-token refresh}
          (some? expires-in) (assoc :expires-at (let [^number e expires-in] (+ now-ms (* e 1000)))))))))

(defn apply-refresh
  "The account after a token refresh; derived metadata wins over what was stored."
  [account {:keys [access-token refresh-token expires-at]} claims]
  (let [derived (oauth-metadata claims)]
    (-> account
        (assoc :secret access-token :refresh-token refresh-token :expires-at expires-at)
        (assoc :chatgpt-account-id (or (:chatgpt-account-id derived) (:chatgpt-account-id account))
               :email (or (:email derived) (:email account))
               :subject (or (:subject derived) (:subject account))
               :plan-type (or (:plan-type derived) (:plan-type account))))))

(defn account-label [{:keys [email display-name id]}]
  (j/lower (j/first-non-nil email display-name id)))

(defn oauth-accounts
  "OAuth accounts (optionally one id), ordered by lower-cased label."
  [accounts account-id]
  (->> accounts
       (filter #(= "oauth_bearer" (:auth-type %)))
       (filter #(or (not (seq account-id)) (= account-id (:id %))))
       (sort (fn [l r] (j/locale-compare (account-label l) (account-label r))))))

(defn- trimmed-or-nil [s] (let [t (some-> s j/trim)] (when (seq t) t)))

(defn workspace-id [account] (trimmed-or-nil (:chatgpt-account-id account)))
(defn access-token [account] (some-> (:secret account) j/trim not-empty))

;; ---------------------------------------------------------------------------
;; Snapshots
;; ---------------------------------------------------------------------------

(defn error-snapshot
  "The account's quota snapshot when nothing could be read."
  [provider-id account fetched-at message]
  {:provider-id provider-id :account-id (:id account) :display-name (:display-name account)
   :email (:email account) :plan-type (:plan-type account) :chatgpt-account-id (:chatgpt-account-id account)
   :status "error" :fetched-at fetched-at
   :five-hour nil :weekly nil :rate-limit nil :code-review-rate-limit nil :error message})

(defn ok-snapshot [provider-id account fetched-at resolved-workspace-id plan details]
  (merge {:provider-id provider-id :account-id (:id account) :display-name (:display-name account)
          :email (:email account) :plan-type plan :chatgpt-account-id resolved-workspace-id
          :status "ok" :fetched-at fetched-at}
         (select-keys details [:five-hour :weekly :rate-limit :code-review-rate-limit])))

(defn persist-usage-result?
  "Whether the plan type or workspace the usage call settled on differs from what is stored."
  [account plan resolved-workspace-id]
  (boolean (or (and plan (not= plan (:plan-type account)))
               (not= resolved-workspace-id (workspace-id account)))))

;; ---------------------------------------------------------------------------
;; Liveness probe
;; ---------------------------------------------------------------------------

(defn completion-text
  "Trimmed assistant text of the first choice of a chat completion, or \"\"."
  [completion]
  (let [choice (j/rec (first (let [c (get completion "choices")] (when (vector? c) c))))
        content (some-> (j/rec (get choice "message")) (get "content") j/as-string j/trim)]
    (or content "")))

(defn probe-outcome
  "{:output-text :matches? :message} for the text a probe got back."
  [output-text expected-text]
  (let [trimmed (j/trim output-text)
        matches? (= (j/lower trimmed) expected-text)]
    {:output-text (when (seq trimmed) trimmed)
     :matches? matches?
     :message (cond
                matches? (str "Live — replied with " (json/write (if (seq trimmed) trimmed expected-text)) ".")
                (seq trimmed) (str "Live — replied with " (json/write trimmed) ".")
                :else "Live — request completed without assistant text.")}))

(defn probe-result
  "The probe verdict for an account: `outcome` is {:error {:status :text :error-code?}}
  or {:ok {...}}-shaped fields merged by the edge. Shared identity fields only."
  [provider-id account tested-at model expected-text workspace]
  {:provider-id provider-id :account-id (:id account) :display-name (:display-name account)
   :email (:email account) :plan-type (:plan-type account)
   :chatgpt-account-id (or workspace (:chatgpt-account-id account))
   :tested-at tested-at :model model :expected-text expected-text})
