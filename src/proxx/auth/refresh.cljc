(ns proxx.auth.refresh
  "Pure decisions of OAuth token refresh: which accounts to refresh, when an
  account is backed off after repeated failures, and what the credential
  becomes after a refresh (or a terminal refresh failure).

  Credentials are string-keyed maps of the host credential object
  {\"providerId\" \"accountId\" \"token\" \"authType\" \"chatgptAccountId\" \"planType\"
   \"refreshToken\" \"expiresAt\"}; nil stands for an absent field. Time is an
  argument. In-flight promises, timers, HTTP calls and persistence belong to
  proxx.runtime.token-refresh."
  (:require [proxx.jsval :as j]))

(defn- string-of
  "Template-literal rendering; an absent (nil) field renders as `undefined`."
  [x]
  (if (nil? x) "undefined" #?(:cljs (js/String x) :clj (str x))))
(defn- js-pow [b e] #?(:cljs (js/Math.pow b e) :clj (Math/pow b e)))

(def default-config
  {:max-concurrency 5
   :background-interval-ms 60000
   :expiry-buffer-ms 60000
   :proactive-refresh-window-ms (* 5 60000)
   :max-consecutive-failures 3})

(defn account-key
  "Identity of an account for in-flight tracking and failure records."
  [credential]
  (str (string-of (get credential "providerId")) "\u0000" (string-of (get credential "accountId"))))

;; ---------------------------------------------------------------------------
;; Failure backoff
;; ---------------------------------------------------------------------------

(def ^:private base-backoff-ms 30000)
(def ^:private max-backoff-ms (* 10 60000))

(defn backoff-ms
  "Exponential backoff after `failures` consecutive failures: 30s, 60s, ... capped at 10 min."
  [failures]
  (min (* base-backoff-ms (js-pow 2 (dec failures))) max-backoff-ms))

(defn record-failure
  "The failure record after another failure at `now-ms`."
  [existing now-ms]
  (let [count (inc (or (:consecutive-failures existing) 0))]
    {:consecutive-failures count :last-failure-at now-ms :backoff-until (+ now-ms (backoff-ms count))}))

(defn backed-off?
  "An account stops being refreshed once it has failed `max-consecutive-failures`
  times in a row, until its backoff expires."
  [record now-ms {:keys [max-consecutive-failures]}]
  (boolean (and record
                (>= (:consecutive-failures record) max-consecutive-failures)
                (< now-ms (:backoff-until record)))))

;; ---------------------------------------------------------------------------
;; Batching
;; ---------------------------------------------------------------------------

(defn batches
  "`credentials` in consecutive groups of at most `max-concurrency` (a non-positive
  limit is treated as 1 rather than never advancing)."
  [credentials max-concurrency]
  (partition-all (max 1 max-concurrency) credentials))

;; ---------------------------------------------------------------------------
;; Which accounts to refresh
;; ---------------------------------------------------------------------------

(defn factory-accounts-to-refresh
  "The Factory accounts for which `needs-refresh?` holds, in order."
  [accounts needs-refresh?]
  (filterv needs-refresh? accounts))

;; ---------------------------------------------------------------------------
;; Credentials after a refresh
;; ---------------------------------------------------------------------------

(defn openai-refreshed-credential
  "The OpenAI credential after a successful refresh. `tokens` is
  {\"accountId\" \"accessToken\" \"refreshToken\" \"expiresAt\" \"chatgptAccountId\" \"planType\" ...};
  the workspace and refresh token fall back to the previous credential's."
  [credential tokens]
  {"providerId" (get credential "providerId")
   "accountId" (get tokens "accountId")
   "token" (get tokens "accessToken")
   "authType" "oauth_bearer"
   "chatgptAccountId" (j/first-non-nil (get tokens "chatgptAccountId") (get credential "chatgptAccountId"))
   "planType" (get tokens "planType")
   "refreshToken" (j/first-non-nil (get tokens "refreshToken") (get credential "refreshToken"))
   "expiresAt" (get tokens "expiresAt")})

(defn disabled-credential
  "The credential after its refresh token proved terminally invalid: unchanged but
  for a cleared refresh token, so it is never refreshed again."
  [credential]
  (assoc credential "refreshToken" nil))

(defn rate-limit-disabled?
  "A disabled account whose access token has already expired is useless until
  reauthorization, so it is parked for a day."
  [credential now-ms]
  (let [expires (get credential "expiresAt")]
    (boolean (and (number? expires) (<= expires now-ms)))))

(def disabled-cooldown-ms (* 24 60 60 1000))

(defn factory-refreshed-credential
  "The Factory credential after a refresh: same account, new tokens; expiry from
  the response, else the access token's JWT `exp`."
  [credential refreshed jwt-expiry]
  {"providerId" "factory"
   "accountId" (get credential "accountId")
   "token" (get refreshed "accessToken")
   "authType" "oauth_bearer"
   "refreshToken" (get refreshed "refreshToken")
   "expiresAt" (j/first-non-nil (get refreshed "expiresAt") jwt-expiry)})
