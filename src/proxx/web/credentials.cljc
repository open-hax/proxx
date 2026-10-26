(ns proxx.web.credentials
  "Credential-domain logic behind the Credentials Manager page: quota shaping,
  account identity/diagnostics, search, grouping and ordering. Pure; the clock is
  always an explicit `now-ms`."
  (:require [clojure.string :as str]
            [proxx.web.format :as fmt]))

;; ---------------------------------------------------------------------------
;; Small text helpers

(defn compact-middle
  ([value] (compact-middle value 8 6))
  ([value head tail]
   (if (<= (count value) (+ head tail 1))
     value
     (str (subs value 0 head) "…" (subs value (- (count value) tail))))))

(defn title-case-plan [plan-type]
  (when (and plan-type (not (str/blank? plan-type)))
    (->> (str/split plan-type #"[-_\s]+")
         (remove str/blank?)
         (map #(str (str/upper-case (subs % 0 1)) (subs % 1)))
         (str/join " "))))

(defn email-domain [email]
  (when (string? email)
    (let [at (str/last-index-of email "@")]
      (when (and at (not= at (dec (count email))))
        (str/lower-case (subs email (inc at)))))))

(defn- present [v] (when (and (string? v) (not (str/blank? v))) v))

(defn account-label
  "Sort/display key: email, else display name, else id (lower-cased)."
  [{:keys [email displayName id]}]
  (str/lower-case (str (or email displayName id))))

(defn sort-accounts [accounts]
  (vec (sort-by account-label accounts)))

(defn probe-model-for-provider [provider-id]
  (if (= provider-id "ollama-cloud") "gemma4:31b" "gpt-5.2"))

(defn format-service-tier
  "Lower-case tier label used by the request-log lines."
  [{:keys [serviceTier serviceTierSource]}]
  (cond
    (str/blank? serviceTier) "standard"
    (= serviceTierSource "fast_mode") "fast mode"
    (= serviceTier "priority") "priority"
    :else (str/replace serviceTier #"[_-]+" " ")))

(defn format-route-label [{:keys [routeKind routedPeerLabel routedPeerId]}]
  (if (= routeKind "local") "local" (str routeKind " → " (or routedPeerLabel routedPeerId "unknown-peer"))))

;; ---------------------------------------------------------------------------
;; Quota

(defn- seconds-until [window now-ms]
  (cond
    (number? (:resetAfterSeconds window)) (max 0 (fmt/round-half-up (:resetAfterSeconds window)))
    (:resetsAt window) (when-let [t (fmt/parse-time-ms (:resetsAt window))]
                         (max 0 (fmt/round-half-up (/ (- t now-ms) 1000))))
    :else nil))

(defn format-reset-summary [window now-ms]
  (when window
    (when-let [seconds (seconds-until window now-ms)]
      (if (>= seconds 86400)
        (if (:resetsAt window)
          (str "resets " (fmt/format-datetime (:resetsAt window)))
          (str "resets in " (quot seconds 86400) "d"))
        (let [hours (quot seconds 3600) minutes (quot (rem seconds 3600) 60)]
          (if (pos? hours) (str "resets in " hours "h " minutes "m") (str "resets in " minutes "m")))))))

(defn format-quota-window-label [window fallback]
  (let [s (:limitWindowSeconds window)]
    (cond
      (or (nil? s) (<= s 0)) fallback
      (zero? (rem s 86400)) (str (fmt/round-half-up (/ s 86400)) "d window")
      (zero? (rem s 3600)) (str (fmt/round-half-up (/ s 3600)) "h window")
      (zero? (rem s 60)) (str (fmt/round-half-up (/ s 60)) "m window")
      :else (str s "s window"))))

(defn format-rate-limit-status [rate-limit]
  (cond
    (nil? rate-limit) "Unknown"
    (true? (:allowed rate-limit)) "Allowed"
    (or (false? (:allowed rate-limit)) (true? (:limitReached rate-limit))) "Blocked"
    :else "Unknown"))

(defn format-aggregate-percent [v]
  (cond
    (not (fmt/finite-number? v)) "No data"
    (>= v 10) (str (fmt/round-half-up v) "%")
    :else (str (fmt/fixed v 1) "%")))

(defn quota-tone-class [remaining]
  (cond
    (nil? remaining) "credentials-quota-fill-neutral"
    (<= remaining 5) "credentials-quota-fill-danger"
    (<= remaining 40) "credentials-quota-fill-warn"
    :else "credentials-quota-fill-good"))

(defn explicitly-blocked?
  "Only an explicit signal from OpenAI counts; very low remaining quota is
  still usable for the active turn."
  [account]
  (or (false? (get-in account [:rateLimit :allowed])) (true? (get-in account [:rateLimit :limitReached]))))

(defn primary-window [account]
  (or (get-in account [:rateLimit :primaryWindow]) (:fiveHour account)))

(defn critically-low? [account]
  (let [remaining (primary-window account)
        r (:remainingPercent remaining)]
    (and (number? r) (> r 0) (<= r 5) (not (explicitly-blocked? account)))))

(defn code-review-blocked? [account]
  (or (false? (get-in account [:codeReviewRateLimit :allowed])) (true? (get-in account [:codeReviewRateLimit :limitReached]))))

(defn- reset-seconds-for-sort [w now-ms]
  (or (when (number? (:resetAfterSeconds w)) (:resetAfterSeconds w))
      (when (:resetsAt w) (some-> (fmt/parse-time-ms (:resetsAt w)) (as-> t (max 0 (fmt/round-half-up (/ (- t now-ms) 1000))))))
      ##Inf))

(defn- average [xs] (when (seq xs) (/ (reduce + xs) (count xs))))

(defn openai-quota-pool
  "Aggregate over every OpenAI quota account; nil when there are none."
  [quota-accounts now-ms]
  (let [all (filterv #(= "openai" (:providerId %)) quota-accounts)]
    (when (seq all)
      (let [ok (filterv #(= "ok" (:status %)) all)
            errors (filterv #(= "error" (:status %)) all)
            general-windows (into [] (keep primary-window) ok)
            review-windows (into [] (keep #(get-in % [:codeReviewRateLimit :primaryWindow])) ok)
            remaining (fn [ws] (into [] (comp (map :remainingPercent) (filter fmt/finite-number?)) ws))
            blocked (filterv explicitly-blocked? ok)
            next-reset (first (sort-by #(reset-seconds-for-sort % now-ms)
                                       (concat (keep primary-window blocked) (keep primary-window ok))))]
        {:totalAccounts (count all) :okAccounts (count ok) :errorAccounts (count errors)
         :generalCombinedRemainingPercent (average (remaining general-windows))
         :codeReviewCombinedRemainingPercent (average (remaining review-windows))
         :generalAvailableCount (count (remove explicitly-blocked? ok))
         :generalBlockedCount (count blocked)
         :generalCriticalCount (count (filter critically-low? ok))
         :codeReviewAvailableCount (count (remove code-review-blocked? ok))
         :codeReviewBlockedCount (count (filter code-review-blocked? ok))
         :nextResetWindow next-reset
         :windowLabel (format-quota-window-label (first general-windows) "Primary window")
         :codeReviewWindowLabel (format-quota-window-label (first review-windows) "Primary window")}))))

(defn pool-badge-variant [combined]
  (let [v (or combined 0)] (cond (> v 50) "success" (> v 20) "warning" :else "error")))

(defn quota-row-view
  "Progress row for one window."
  [label window now-ms]
  (let [remaining (:remainingPercent window)
        width (if (nil? remaining) 0 (min 100 (max 0 remaining)))]
    {:label label
     :percent-label (if (nil? remaining) "No data" (str (fmt/round-half-up remaining) "% left"))
     :width (str width "%")
     :tone (quota-tone-class remaining)
     :reset (format-reset-summary window now-ms)}))

(defn quota-group-view
  "Rate-limit bucket (nil when it has nothing to show)."
  [title rate-limit fallback-primary fallback-secondary now-ms]
  (let [primary (or (:primaryWindow rate-limit) fallback-primary)
        secondary (or (:secondaryWindow rate-limit) fallback-secondary)]
    (when-not (and (nil? rate-limit) (nil? primary) (nil? secondary))
      (let [r (:remainingPercent primary)
            ;; Faithful to the original: critical only when explicitly allowed,
            ;; not limit-reached, and 0 < remaining <= 5.
            critical? (and (true? (:allowed rate-limit))
                           (not (true? (:limitReached rate-limit)))
                           (number? r) (> r 0) (<= r 5))]
        {:title title
         :badge (cond (true? (:allowed rate-limit)) (if critical? "warning" "success")
                      (or (false? (:allowed rate-limit)) (true? (:limitReached rate-limit))) "error"
                      :else "default")
         :badge-text (if critical? "Critical" (format-rate-limit-status rate-limit))
         :rows (cond-> []
                 primary (conj (quota-row-view (format-quota-window-label primary "Primary window") primary now-ms))
                 secondary (conj (quota-row-view (format-quota-window-label secondary "Secondary window") secondary now-ms)))
         :empty? (and (nil? primary) (nil? secondary))}))))

;; ---------------------------------------------------------------------------
;; Accounts

(defn flat-accounts
  "Sorted providers flattened to `{:provider-id :provider-auth-type :account}`."
  [providers]
  (vec (for [p (sort-by :id providers)
             a (sort-accounts (:accounts p))]
         {:provider-id (:id p) :provider-auth-type (:authType p) :account a})))

(defn account-key [{:keys [provider-id account]}] (str provider-id ":" (:id account)))

(defn account-search-blob [{:keys [provider-id account]}]
  (->> [provider-id (:id account) (:displayName account) (:email account) (:subject account)
        (:chatgptAccountId account) (:planType account) (title-case-plan (:planType account))
        (email-domain (:email account)) (:secretPreview account) (fmt/format-auth-type (:authType account))]
       (filter #(and (string? %) (not (str/blank? %))))
       (str/join "\n")
       str/lower-case))

(defn has-refresh-token? [account]
  (let [t (or (:refreshToken account) (:refreshTokenPreview account))]
    (and (string? t) (not (str/blank? t)))))

(defn error-suggests-reauth? [error]
  (let [n (some-> error str/trim str/lower-case)]
    (boolean
     (and (seq n)
          (some #(str/includes? n %)
                ["provided authentication token is expired" "please try signing in again"
                 "refresh token has already been used" "refresh token expired"
                 "refresh_token_expired" "refresh_token_reused" "signing in again"])))))

(defn human-identity-key [{:keys [provider-id account]}]
  (let [subject (some-> (:subject account) str/trim not-empty)
        email (some-> (:email account) str/trim str/lower-case not-empty)]
    (cond subject (str provider-id ":subject:" subject)
          email (str provider-id ":email:" email))))

(defn human-identity-label [{:keys [account]}]
  (cond (present (:email account)) (:email account)
        (present (:subject account)) (compact-middle (:subject account) 12 8)))

(defn- open-ai-oauth? [{:keys [provider-id account]}]
  (and (= provider-id "openai") (= "oauth_bearer" (:authType account))))

(defn account-diagnostics
  "Reauth + duplicate-identity facts per account key, with the roll-ups the
  toolbar shows."
  [flat quota-by-account now-ms]
  (let [groups (reduce (fn [m e]
                         (let [k (human-identity-key e) l (human-identity-label e)]
                           (if (and k l)
                             (update m k (fn [g] (-> (or g {:label l :keys []}) (update :keys conj (account-key e)))))
                             m)))
                       {} flat)
        dup-groups (->> (vals groups) (filter #(> (count (:keys %)) 1)) (sort-by :label) vec)
        dup-count (into {} (for [g dup-groups k (:keys g)] [k (count (:keys g))]))
        by-account (into {}
                         (for [e flat
                               :let [k (account-key e)
                                     quota (get quota-by-account k)
                                     expired? (and (number? (get-in e [:account :expiresAt])) (<= (get-in e [:account :expiresAt]) now-ms))
                                     needs? (and (open-ai-oauth? e)
                                                 (or (error-suggests-reauth? (:error quota))
                                                     (and expired? (not (has-refresh-token? (:account e))))))]]
                           [k {:needsReauth (boolean needs?) :duplicateCount (get dup-count k 0)}]))
        oauth (filter open-ai-oauth? flat)]
    {:byAccount by-account
     :duplicateGroups dup-groups
     :reauthRequiredCount (count (filter :needsReauth (vals by-account)))
     :openAiOauthCount (count oauth)
     :humanIdentifiedOpenAiOauthCount (count (filter #(or (:email (:account %)) (:subject (:account %))) oauth))}))

(defn duplicate-summary [dup-groups]
  (if (empty? dup-groups)
    "No possible duplicate identities detected"
    (let [preview (->> dup-groups (take 3) (map #(str (:label %) " (" (count (:keys %)) ")")) (str/join ", "))]
      (if (> (count dup-groups) 3)
        (str "Possible duplicates: " preview "…")
        (str "Possible duplicates: " preview)))))

(defn sort-account-entries
  "Quota-bearing OpenAI OAuth accounts first (most remaining, then allowed,
  then soonest reset), the rest by label."
  [entries quota-by-account now-ms]
  (let [metrics (fn [e]
                  (let [quota (get quota-by-account (account-key e))
                        pw (primary-window quota)
                        has-quota? (boolean (and (= (:provider-id e) "openai") (= "oauth_bearer" (get-in e [:account :authType]))
                                                 (= "ok" (:status quota)) pw))
                        allowed (get-in quota [:rateLimit :allowed])]
                    {:has-quota? has-quota?
                     :remaining (:remainingPercent pw)
                     :reset (if pw (reset-seconds-for-sort pw now-ms) ##Inf)
                     :allowed-rank (cond (true? allowed) 0
                                         (or (false? allowed) (true? (get-in quota [:rateLimit :limitReached]))) 1
                                         :else 2)}))
        cmp (fn [l r]
              (let [lm (metrics l) rm (metrics r)]
                (cond
                  (not= (:has-quota? lm) (:has-quota? rm)) (if (:has-quota? lm) -1 1)
                  (:has-quota? lm)
                  (let [lr (or (:remaining lm) -1) rr (or (:remaining rm) -1)]
                    (cond
                      (not= lr rr) (compare rr lr)
                      (not= (:allowed-rank lm) (:allowed-rank rm)) (compare (:allowed-rank lm) (:allowed-rank rm))
                      (not= (:reset lm) (:reset rm)) (compare (:reset lm) (:reset rm))
                      :else (compare (account-label (:account l)) (account-label (:account r)))))
                  :else (compare (account-label (:account l)) (account-label (:account r))))))]
    (vec (sort cmp entries))))

(defn filter-accounts
  "Search + reauth-only filtering of flat accounts."
  [flat query reauth-only? diagnostics]
  (let [q (str/lower-case (str/trim (or query "")))
        searched (if (str/blank? q) flat (filterv #(str/includes? (account-search-blob %) q) flat))]
    (if reauth-only?
      (filterv #(get-in diagnostics [:byAccount (account-key %) :needsReauth]) searched)
      searched)))

(defn grouped-sections
  "Sections for the account list: by provider (default), plan or email domain."
  [grouping providers filtered quota-by-account now-ms]
  (if (= grouping "provider")
    (let [by-provider (group-by :provider-id filtered)]
      (vec (for [p (sort-by :id providers)
                 :let [entries (get by-provider (:id p))]
                 :when (seq entries)]
             (let [shown (count entries)]
               {:key (:id p) :title (:id p)
                :description (if (= shown (:accountCount p))
                               (str (:accountCount p) " account(s) connected")
                               (str shown " of " (:accountCount p) " account(s) shown"))
                :badge (fmt/format-auth-type (:authType p)) :badge-muted (str shown " shown")
                :accounts (sort-account-entries (mapv (fn [e] (assoc e :provider-auth-type (:authType p))) (sort-by (comp account-label :account) entries))
                                                quota-by-account now-ms)}))))
    (let [plan? (= grouping "plan")
          groups (reduce (fn [m e]
                           (let [domain (email-domain (get-in e [:account :email]))
                                 plan (get-in e [:account :planType])
                                 k (if plan? (str "plan:" (or plan "__none__")) (str "domain:" (or domain "__none__")))
                                 title (if plan? (or (title-case-plan plan) "No plan") (or domain "No email domain"))]
                             (-> m
                                 (update-in [k :title] #(or % title))
                                 (update-in [k :accounts] (fnil conj []) e))))
                         (array-map) filtered)]
      (->> groups
           (map (fn [[k {:keys [title accounts]}]]
                  {:key k :title title
                   :description (str (count accounts) " account(s) · " (if plan? "Plan grouping" "Email domain grouping"))
                   :badge (if plan? "Plan" "Domain") :badge-muted (str (count accounts) " shown")
                   :accounts (sort-account-entries accounts quota-by-account now-ms)}))
           (sort (fn [l r]
                   (let [ln? (str/starts-with? (:title l) "No ") rn? (str/starts-with? (:title r) "No ")]
                     (cond (and ln? (not rn?)) 1
                           (and (not ln?) rn?) -1
                           :else (compare (:title l) (:title r))))))
           vec))))

(defn provider-health [providers key-pool-statuses request-log-summary]
  (let [ids (sort (distinct (concat (map :id providers) (keys key-pool-statuses) (keys request-log-summary))))]
    (mapv (fn [id] {:providerId id :keyPool (get key-pool-statuses id) :logs (get request-log-summary id)}) ids)))

(defn cache-watch-rows [audit]
  (when audit
    (let [source (if (seq (:watchRows audit)) (:watchRows audit) (:rows audit))]
      (mapv (fn [row] (assoc row :cacheRate (if (pos? (:promptTokens row))
                                              (* (/ (:cachedPromptTokens row) (:promptTokens row)) 100)
                                              0)))
            source))))
