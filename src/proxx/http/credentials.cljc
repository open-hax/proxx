(ns proxx.http.credentials
  "Decisions for the credential routes (src/routes/credentials/*) as pure
  functions of plain data: request-value parsers, the merged provider/account
  views, the prompt-cache audit, the OAuth callback pages and messages.

  Wire values are string-keyed. Every function takes the clock or randomness as
  an argument; stores, the key pool and the OAuth managers are the edge's
  (proxx.runtime.routes.credentials)."
  (:require [clojure.string :as str]
            [proxx.http.guard :as guard]
            [proxx.http.request :as http-request]
            [proxx.routing.account-identity :as identity]))

;; ---------------------------------------------------------------------------
;; Small JS-semantics helpers
;; ---------------------------------------------------------------------------

(defn- js-trim [s] #?(:cljs (.trim ^string s) :clj (str/trim s)))

(defn- locale-compare [a b] #?(:cljs (.localeCompare ^string a ^string b) :clj (compare a b)))

(defn- js-lower [s] #?(:cljs (.toLowerCase ^string s) :clj (str/lower-case s)))

(def js-null
  "Stands for a JS `null` inside account views, where `null` and `undefined`
  (an absent key) must stay distinct: both are skipped by `??`, but `a ?? b`
  yields `b` when neither has a value, and a `null` field is visible in JSON."
  ::null)

(defn- nullish? [x] (or (nil? x) (= js-null x)))

(defn- coalesce
  "`a ?? b ?? ...`: the first argument that is not nullish, else the last one."
  [& xs]
  (if-let [x (seq (remove nullish? xs))] (first x) (last xs)))

(defn- truthy-or
  "`a || b`: `a` unless it is JS-falsy (nil, null, false, 0, NaN, \"\")."
  [a b]
  (if (or (nullish? a) (false? a) (= 0 a) (= "" a) (and (number? a) (not= a a))) b a))

(defn trimmed-string
  "A string's trimmed text when it is not blank, else nil (for non-strings too)."
  [value]
  (when (string? value)
    (let [t (js-trim value)] (when (seq t) t))))

(defn trimmed-or-empty
  "A string's trimmed text (possibly empty); \"\" for non-strings."
  [value]
  (if (string? value) (js-trim value) ""))

(defn- string-or-empty [value] (if (string? value) value ""))

(defn- parse-int
  "Leading base-10 integer of a string (like parseInt), or nil."
  [s]
  (when-let [[_ digits] (re-find #"^\s*([+-]?\d+)" s)]
    #?(:cljs (js/parseInt digits 10) :clj (Long/parseLong (str/replace digits #"^\+" "")))))

(defn- finite? [x]
  (and (number? x) #?(:cljs (js/Number.isFinite x) :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x)))))))

;; ---------------------------------------------------------------------------
;; Request values
;; ---------------------------------------------------------------------------

(defn generated-account-id
  "`<provider>-<now-ms>-<suffix>` for a credential added without an id."
  [provider-id now-ms suffix]
  (str provider-id "-" now-ms "-" suffix))

(defn- credential-secret
  "The pasted credential: `credentialValue` when it is a string, else `apiKey`,
  trimmed; \"\" when neither is a string."
  [body]
  (trimmed-or-empty (if (string? (get body "credentialValue")) (get body "credentialValue") (get body "apiKey"))))

(defn api-key-request
  "POST /credentials/api-key: {:error code} or
  {:provider-id :api-key :account-id <given id or nil>}. The provider id is
  taken verbatim when it is a string (even blank), else `default-provider-id`."
  [body default-provider-id]
  (let [api-key (credential-secret body)]
    (if (empty? api-key)
      {:error "api_key_required"}
      {:provider-id (if (string? (get body "providerId")) (get body "providerId") default-provider-id)
       :api-key api-key
       :account-id (trimmed-string (get body "accountId"))})))

(defn provider-request
  "POST /credentials/provider: {:error code} or
  {:provider-id :base-url :api-key (\"\" when none) :account-id (given or nil)}."
  [body]
  (let [provider-id (trimmed-or-empty (get body "providerId"))
        base-url (trimmed-or-empty (get body "baseUrl"))]
    (cond
      (empty? provider-id) {:error "provider_id_required"}
      (empty? base-url) {:error "base_url_required"}
      :else {:provider-id provider-id :base-url base-url
             :api-key (credential-secret body)
             :account-id (trimmed-string (get body "accountId"))})))

(defn account-ref
  "{:provider-id :account-id} from a body, or nil unless both are non-blank."
  [body]
  (let [provider-id (trimmed-or-empty (get body "providerId"))
        account-id (trimmed-or-empty (get body "accountId"))]
    (when (and (seq provider-id) (seq account-id))
      {:provider-id provider-id :account-id account-id})))

(def account-ref-required
  (guard/error 400 "provider_id_and_account_id_required"))

(defn device-poll-request
  "OpenAI device poll: {:device-auth-id :user-code} (verbatim strings, \"\" when
  absent). The caller rejects when either is empty."
  [body]
  {:device-auth-id (string-or-empty (get body "deviceAuthId"))
   :user-code (string-or-empty (get body "userCode"))})

;; ---------------------------------------------------------------------------
;; Probe endpoints
;; ---------------------------------------------------------------------------

(def ^:private local-base-url
  #"(?i)^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:/|$)")

(defn openai-probe-endpoint
  "{:base-url :responses-path} the probe should use: a local base URL is probed
  at the real ChatGPT backend, and the path must be a /codex/ one."
  [openai-base-url openai-responses-path]
  (let [base (js-trim openai-base-url)
        path (js-trim openai-responses-path)]
    {:base-url (if (re-find local-base-url base) "https://chatgpt.com/backend-api" base)
     :responses-path (if (str/includes? path "/codex/") path "/codex/responses")}))

(defn ollama-cloud-base-url
  "The configured Ollama Cloud base URL (trimmed), else the public one."
  [configured]
  (let [t (when (string? configured) (js-trim configured))]
    (if (seq t) t "https://ollama.com")))

(defn probe-failure-response
  "How a failed probe is reported: 404 `not-found-code` when the message starts
  with `not-found-prefix`, else 500 `failed-code`."
  [message not-found-prefix not-found-code failed-code]
  (let [missing? (str/starts-with? message not-found-prefix)]
    {:status (if missing? 404 500)
     :body {"error" (if missing? not-found-code failed-code) "detail" message}}))

;; ---------------------------------------------------------------------------
;; OAuth flows
;; ---------------------------------------------------------------------------

(defn infer-base-url
  "`<proto>://<host>` for the request as the client addressed it, or nil.
  The Host header wins over X-Forwarded-Host; X-Forwarded-Proto over `protocol`."
  [headers protocol]
  (let [forwarded-host (when (string? (get headers "x-forwarded-host")) (get headers "x-forwarded-host"))
        host (if (string? (get headers "host")) (get headers "host") forwarded-host)]
    (when (seq host)
      (let [forwarded-proto (when (string? (get headers "x-forwarded-proto")) (get headers "x-forwarded-proto"))]
        (str (coalesce forwarded-proto protocol) "://" host)))))

(defn redirect-base-url
  "The body's trimmed `redirectBaseUrl` when non-blank, else the inferred one."
  [body inferred]
  (or (trimmed-string (get body "redirectBaseUrl")) inferred))

(defn callback-query
  "What an OAuth callback carries, from the query: the provider's `error`
  (non-empty string) or the `state` and `code` (strings, \"\" when absent)."
  [query]
  (let [error (get query "error")]
    (if (and (string? error) (seq error))
      {:error error :description (get query "error_description")}
      {:state (string-or-empty (get query "state"))
       :code (string-or-empty (get query "code"))})))

(def missing-callback-params "Missing OAuth callback state or code.")

(defn openai-reauth-target
  "The account a browser re-authentication must keep matching."
  [account]
  {:account-id (get account "id")
   :chatgpt-account-id (get account "chatgptAccountId")
   :email (get account "email")
   :subject (get account "subject")})

(defn openai-reauth-outcome
  "After the new tokens are saved: {:replace? true} when the re-auth target
  resolved to the same identity under a different account id (the old account is
  to be removed), {:retained? true} when the identity differs (the old account
  stays), else {}. `removable?` is whether the credential store can remove."
  [target tokens removable?]
  (if (and target (not= (:account-id target) (get tokens "accountId")) removable?)
    (if (identity/reauth-identity-matches? target {:email (get tokens "email")
                                                    :subject (get tokens "subject")
                                                    :chatgpt-account-id (get tokens "chatgptAccountId")})
      {:replace? true}
      {:retained? true})
    {}))

(defn openai-success-message
  "The page text after a browser sign-in. `replaced-id` is the account that was
  actually removed (nil if none)."
  [tokens replaced-id retained?]
  (let [label (coalesce (get tokens "email") (get tokens "chatgptAccountId") (get tokens "accountId"))]
    (cond
      replaced-id (str "Reauthenticated OpenAI account " label " and replaced " replaced-id ".")
      retained? (str "Saved OpenAI OAuth account " label ". Original account was kept because the completed sign-in resolved to a different identity.")
      :else (str "Saved OpenAI OAuth account " label "."))))

(defn factory-success-message [tokens]
  (str "Saved Factory.ai OAuth account"
       (when-let [email (truthy-or (get tokens "email") nil)] (str " (" email ")"))
       "."))

;; ---------------------------------------------------------------------------
;; OAuth result pages
;; ---------------------------------------------------------------------------

(def ^:private success-head "<!doctype html>\n<html>\n  <head>\n    <title>Open Hax OAuth Success</title>\n    <style>\n      body { font-family: \"IBM Plex Sans\", \"Fira Sans\", sans-serif; background: radial-gradient(circle at top, #12313b 0%, #0b161c 60%); color: #e9f7fb; margin: 0; min-height: 100vh; display: grid; place-items: center; }\n      .card { background: rgba(17, 33, 42, 0.86); border: 1px solid rgba(145, 212, 232, 0.35); padding: 28px; border-radius: 14px; width: min(560px, 90vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }\n      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }\n      p { margin: 0; color: #bce2ec; }\n    </style>\n  </head>\n  <body>\n    <section class=\"card\">\n      <h1>Authorization Successful</h1>\n      <p>")
(def ^:private success-tail "</p>\n    </section>\n    <script>setTimeout(() => window.close(), 1500)</script>\n  </body>\n</html>")
(def ^:private error-head "<!doctype html>\n<html>\n  <head>\n    <title>Open Hax OAuth Failed</title>\n    <style>\n      body { font-family: \"IBM Plex Sans\", \"Fira Sans\", sans-serif; background: radial-gradient(circle at top, #381613 0%, #1a0f0e 60%); color: #ffe8e4; margin: 0; min-height: 100vh; display: grid; place-items: center; }\n      .card { background: rgba(42, 18, 16, 0.9); border: 1px solid rgba(255, 158, 143, 0.4); padding: 28px; border-radius: 14px; width: min(560px, 90vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }\n      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }\n      p { margin: 0; color: #ffc6bb; }\n    </style>\n  </head>\n  <body>\n    <section class=\"card\">\n      <h1>Authorization Failed</h1>\n      <p>")
(def ^:private error-tail "</p>\n    </section>\n  </body>\n</html>")

(defn html-success [message] (str success-head (http-request/escape-html message) success-tail))
(defn html-error [message] (str error-head (http-request/escape-html message) error-tail))

(defn html-response
  "A 200 text/html reply (the OAuth pages report failure in the page, not the status)."
  [html]
  {:status 200 :headers {"content-type" "text/html"} :body html})

;; ---------------------------------------------------------------------------
;; Merged provider/account view (key pool accounts shown beside stored ones)
;; ---------------------------------------------------------------------------

(defn- merge-account [existing incoming]
  (if-not existing
    incoming
    (-> (merge existing incoming)
        (assoc "displayName" (truthy-or (get incoming "displayName") (get existing "displayName"))
               "secretPreview" (truthy-or (get incoming "secretPreview") (get existing "secretPreview")))
        (as-> m
              (reduce (fn [acc k] (assoc acc k (coalesce (get incoming k) (get existing k))))
                      m
                      ["secret" "refreshTokenPreview" "refreshToken" "expiresAt" "chatgptAccountId" "email" "subject" "planType"])))))

(defn- account-label [account]
  (js-lower (coalesce (get account "email") (get account "displayName") (get account "id"))))

(defn- compare-accounts [left right]
  (let [by-label (locale-compare (account-label left) (account-label right))]
    (if (zero? by-label) (locale-compare (get left "id") (get right "id")) by-label)))

(defn- drop-nils [m] (into {} (remove (comp nil? val)) m))

(defn- accounts-by-id
  "[ids-in-first-seen-order {id account}] folding `accounts` into `acc` with `combine`."
  [acc accounts combine]
  (reduce (fn [[order by-id] account]
            (let [id (get account "id")]
              [(if (contains? by-id id) order (conj order id))
               (assoc by-id id (combine (get by-id id) account))]))
          acc
          accounts))

(defn- merge-provider [existing incoming]
  (let [acc (accounts-by-id [[] {}] (get existing "accounts") (fn [_ account] account))
        [order by-id] (accounts-by-id acc (get incoming "accounts") merge-account)
        accounts (vec (sort compare-accounts (map by-id order)))]
    {"id" (get incoming "id")
     "authType" (coalesce (get incoming "authType") (get existing "authType") "api_key")
     "accountCount" (count accounts)
     "accounts" accounts}))

(defn- key-pool-account-view [{:keys [account-id auth-type chatgpt-account-id plan-type]}]
  (drop-nils {"id" account-id
              "authType" auth-type
              "displayName" (coalesce chatgpt-account-id account-id)
              "secretPreview" "runtime-only"
              "chatgptAccountId" chatgpt-account-id
              "planType" plan-type}))

(defn visible-providers
  "The providers to show: those in the credential store, plus every key pool
  provider that has accounts (merged into the stored one when both exist),
  sorted by id with accounts sorted by label.

  `store-providers` are the stored provider views (string-keyed maps, nil-valued
  fields absent); `key-pool-accounts` is an ordered seq of
  [provider-id [{:account-id :auth-type :chatgpt-account-id :plan-type} ...]]."
  [store-providers key-pool-accounts]
  (let [by-id (into {} (map (juxt #(get % "id") identity)) store-providers)
        by-id (reduce (fn [by-id [provider-id accounts]]
                        (if (empty? accounts)
                          by-id
                          (assoc by-id provider-id
                                 (merge-provider (get by-id provider-id)
                                                 {"id" provider-id
                                                  "authType" (coalesce (:auth-type (first accounts)) (get-in by-id [provider-id "authType"]) "api_key")
                                                  "accountCount" (count accounts)
                                                  "accounts" (mapv key-pool-account-view accounts)}))))
                      by-id
                      key-pool-accounts)]
    (vec (sort (fn [l r] (locale-compare (get l "id") (get r "id"))) (vals by-id)))))

(defn visible-openai-accounts
  "The OAuth accounts of `provider-id` among `providers`."
  [providers provider-id]
  (let [provider (some #(when (= provider-id (get % "id")) %) providers)]
    (filterv #(= "oauth_bearer" (get % "authType")) (get provider "accounts"))))

;; ---------------------------------------------------------------------------
;; Prompt-cache audit
;; ---------------------------------------------------------------------------

(def default-row-limit 40)
(def max-row-limit 200)
(def default-scan-limit 5000)
(def max-scan-limit 20000)

(defn safe-limit
  "A query limit clamped to [1, max]: a finite number is floored, a string is
  read like parseInt, anything else (or an unparseable string) is `fallback`."
  [value fallback max-value]
  (let [clamp (fn [n] (max 1 (min n max-value)))]
    (cond
      (finite? value) (clamp (Math/floor value))
      (string? value) (if-let [n (parse-int value)] (clamp n) fallback)
      :else fallback)))

(defn- distinct-sorted [xs] (vec (sort locale-compare (distinct xs))))

(def ^:private empty-group
  {:request-count 0 :account-ids [] :successful-request-count 0 :failed-request-count 0
   :successful-account-ids [] :failed-account-ids [] :shape-fingerprints []
   :cache-hit-count 0 :cached-prompt-tokens 0 :prompt-tokens 0
   :latest-model nil :first-seen nil :last-seen nil :provider-id nil})

(defn- add-entry
  "Fold one log entry into its group."
  [group {:keys [provider-id account-id status error shape-fingerprint cache-hit cached-prompt-tokens prompt-tokens model timestamp]}]
  (let [ok? (and (number? status) (>= status 200) (< status 300))
        failed? (and (not ok?) (or (and (number? status) (>= status 400)) (string? error)))
        newest? (or (nil? (:last-seen group)) (>= timestamp (:last-seen group)))]
    (-> group
        (update :provider-id #(or % provider-id))
        (update :request-count inc)
        (update :account-ids conj account-id)
        (cond-> ok? (-> (update :successful-request-count inc) (update :successful-account-ids conj account-id))
                failed? (-> (update :failed-request-count inc) (update :failed-account-ids conj account-id))
                (seq shape-fingerprint) (update :shape-fingerprints conj shape-fingerprint)
                (true? cache-hit) (update :cache-hit-count inc)
                newest? (assoc :latest-model model))
        (update :cached-prompt-tokens + (if (finite? cached-prompt-tokens) cached-prompt-tokens 0))
        (update :prompt-tokens + (if (finite? prompt-tokens) prompt-tokens 0))
        (update :first-seen #(if (nil? %) timestamp (min % timestamp)))
        (update :last-seen #(if (nil? %) timestamp (max % timestamp))))))

(defn- group-row [hash group iso]
  (let [account-ids (distinct-sorted (:account-ids group))
        ok-ids (distinct-sorted (:successful-account-ids group))
        failed-ids (distinct-sorted (:failed-account-ids group))
        fingerprints (distinct-sorted (:shape-fingerprints group))]
    (cond-> {"promptCacheKeyHash" hash
             "providerId" (:provider-id group)
             "requestCount" (:request-count group)
             "accountCount" (count account-ids)
             "accountIds" account-ids
             "successfulRequestCount" (:successful-request-count group)
             "failedRequestCount" (:failed-request-count group)
             "successfulAccountCount" (count ok-ids)
             "successfulAccountIds" ok-ids
             "failedAccountCount" (count failed-ids)
             "failedAccountIds" failed-ids
             "shapeFingerprintCount" (count fingerprints)
             "shapeFingerprints" fingerprints
             "cacheHitCount" (:cache-hit-count group)
             "cachedPromptTokens" (:cached-prompt-tokens group)
             "promptTokens" (:prompt-tokens group)
             "firstSeenAt" (iso (:first-seen group))
             "lastSeenAt" (iso (:last-seen group))}
      (some? (:latest-model group)) (assoc "latestModel" (:latest-model group)))))

(def audit-row-key-order
  "The JSON key order of an audit row (the order the response has always used)."
  ["promptCacheKeyHash" "providerId" "requestCount" "accountCount" "accountIds"
   "successfulRequestCount" "failedRequestCount" "successfulAccountCount" "successfulAccountIds"
   "failedAccountCount" "failedAccountIds" "shapeFingerprintCount" "shapeFingerprints"
   "cacheHitCount" "cachedPromptTokens" "promptTokens" "latestModel" "firstSeenAt" "lastSeenAt"])

(def audit-key-order
  ["generatedAt" "scannedEntryCount" "distinctHashCount" "crossAccountHashCount"
   "crossSuccessfulAccountHashCount" "rows" "watchRows"])

(defn- last-seen-ms [row]
  (if-let [s (get row "lastSeenAt")] #?(:cljs (js/Date.parse s) :clj 0) 0))

(defn- compare-rows [left right]
  (let [desc (fn [f] (compare (f right) (f left)))
        by #(fn [row] (get row %))]
    (let [r (desc (by "successfulAccountCount"))]
      (if-not (zero? r) r
              (let [r (desc (by "accountCount"))]
                (if-not (zero? r) r
                        (let [r (desc last-seen-ms)]
                          (if-not (zero? r) r
                                  (let [r (desc (by "requestCount"))]
                                    (if-not (zero? r) r
                                            (locale-compare (get left "promptCacheKeyHash") (get right "promptCacheKeyHash"))))))))))))

(defn- cache-rate [row]
  (let [prompt (get row "promptTokens")]
    (if (pos? prompt) (/ (get row "cachedPromptTokens") prompt) 0)))

(defn- compare-watch-rows [left right]
  (let [lr (cache-rate left) rr (cache-rate right)]
    (cond
      (not= lr rr) (compare lr rr)
      (not= (get right "promptTokens") (get left "promptTokens")) (compare (get right "promptTokens") (get left "promptTokens"))
      :else (locale-compare (get left "promptCacheKeyHash") (get right "promptCacheKeyHash")))))

(defn prompt-cache-audit
  "The audit of `entries` (maps with :provider-id :prompt-cache-key-hash
  :account-id :status :error :shape-fingerprint :cache-hit :cached-prompt-tokens
  :prompt-tokens :model :timestamp). `iso` renders epoch ms (or nil) as an ISO
  string (or nil); `now-ms` stamps the report. Entries of other providers, or
  without a key hash, are scanned but not grouped."
  [entries row-limit open-ai-provider-id now-ms iso]
  (let [groups (reduce (fn [groups entry]
                         (let [hash (trimmed-string (:prompt-cache-key-hash entry))]
                           (if (and (= open-ai-provider-id (:provider-id entry)) hash)
                             (update groups hash #(add-entry (or % empty-group) entry))
                             groups)))
                       {}
                       entries)
        all-rows (vec (sort compare-rows (map (fn [[hash group]] (group-row hash group iso)) groups)))
        watch-rows (->> all-rows
                        (filter #(= 1 (get % "successfulAccountCount")))
                        (filter #(= 1 (get % "shapeFingerprintCount")))
                        (filter #(>= (get % "successfulRequestCount") 4))
                        (filter #(>= (get % "promptTokens") 10000))
                        (sort compare-watch-rows)
                        (take 8)
                        vec)]
    {"generatedAt" (iso now-ms)
     "scannedEntryCount" (count entries)
     "distinctHashCount" (count groups)
     "crossAccountHashCount" (count (filter #(> (get % "accountCount") 1) all-rows))
     "crossSuccessfulAccountHashCount" (count (filter #(> (get % "successfulAccountCount") 1) all-rows))
     "rows" (vec (take row-limit all-rows))
     "watchRows" watch-rows}))
