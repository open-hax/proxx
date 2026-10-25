(ns proxx.runtime.quota
  "Effects around OpenAI account quota reads and liveness probes: the usage and
  token fetches, abort timeouts, workspace retry, and credential persistence.
  Every verdict (is the token stale, what does the body mean, did the
  probe match) comes from proxx.quota.openai; endpoints and timeouts come from
  the manifest's `:provider-quota-profile` contract.

  The credential store, logger and fetch function are host collaborators
  (JS objects) passed per call, exactly as the TypeScript entry points did."
  (:require [proxx.compat.responses :as responses]
            [proxx.compat.responses.stream :as stream]
            [proxx.json :as json]
            [proxx.jsval :as j]
            [proxx.policy.loader :as loader]
            [proxx.quota.openai :as q]))

(defonce ^:private profiles (atom {}))

(defn- profile-for
  "The OpenAI `:provider-quota-profile` of a manifest, loaded and validated once."
  [manifest-path]
  (or (get @profiles manifest-path)
      (let [c (->> (loader/load-policy-contracts! manifest-path)
                   (filter #(= :provider-quota-profile (:contract/kind %)))
                   first)
            _ (when-not c (throw (js/Error. "Policy has no :provider-quota-profile contract")))
            p {:token-url (:quota/token-url c) :usage-url (:quota/usage-url c) :client-id (:quota/client-id c)
               :refresh-buffer-ms (:quota/refresh-buffer-ms c) :usage-timeout-ms (:quota/usage-timeout-ms c)
               :probe-timeout-ms (:quota/probe-timeout-ms c) :probe-model (:quota/probe-model c)
               :probe-expected-text (:quota/probe-expected-text c)}]
        (swap! profiles assoc manifest-path p)
        p)))

;; ---------------------------------------------------------------------------
;; JS conversion helpers (the only place camelCase and undefined exist)
;; ---------------------------------------------------------------------------

(defn- undef [x] (if (nil? x) js/undefined x))
(defn- nullish-or [v default] (if (nil? v) default v))
(defn- now-ms [] (js/Date.now))
(defn- now-iso [] (.toISOString (js/Date.)))
(defn- err-message [e] (if (instance? js/Error e) (.-message e) (str e)))

(defn- js->account [^js a]
  {:id (.-id a) :display-name (.-displayName a) :email (.-email a) :plan-type (.-planType a)
   :chatgpt-account-id (.-chatgptAccountId a) :secret (.-secret a) :refresh-token (.-refreshToken a)
   :expires-at (.-expiresAt a) :auth-type (.-authType a) :subject (.-subject a)})

(defn- log! [logger level obj msg]
  (when logger
    (let [f (aget logger level)]
      (when (fn? f) (.call f logger obj msg)))))

(defn- window->js [w]
  (when w
    #js {:usedPercent (:used-percent w) :remainingPercent (:remaining-percent w)
         :resetsAt (:resets-at w) :resetAfterSeconds (:reset-after-seconds w)
         :limitWindowSeconds (:limit-window-seconds w)}))

(defn- rate-limit->js [r]
  (when r
    #js {:allowed (:allowed r) :limitReached (:limit-reached r)
         :primaryWindow (window->js (:primary-window r)) :secondaryWindow (window->js (:secondary-window r))}))

(defn- put-some! [^js o k v] (when (some? v) (aset o k v)) o)

(defn- snapshot->js [s]
  (let [o #js {:providerId (:provider-id s) :accountId (:account-id s) :displayName (:display-name s)}]
    (put-some! o "email" (:email s))
    (put-some! o "planType" (:plan-type s))
    (put-some! o "chatgptAccountId" (:chatgpt-account-id s))
    (aset o "status" (:status s))
    (aset o "fetchedAt" (:fetched-at s))
    (aset o "fiveHour" (window->js (:five-hour s)))
    (aset o "weekly" (window->js (:weekly s)))
    (aset o "rateLimit" (rate-limit->js (:rate-limit s)))
    (aset o "codeReviewRateLimit" (rate-limit->js (:code-review-rate-limit s)))
    (put-some! o "error" (:error s))))

(defn- probe->js [r]
  (let [o #js {:providerId (:provider-id r) :accountId (:account-id r) :displayName (:display-name r)}]
    (put-some! o "email" (:email r))
    (put-some! o "planType" (:plan-type r))
    (put-some! o "chatgptAccountId" (:chatgpt-account-id r))
    (aset o "testedAt" (:tested-at r))
    (aset o "model" (:model r))
    (aset o "expectedText" (:expected-text r))
    (aset o "status" (:status r))
    (aset o "ok" (:ok r))
    (aset o "matchesExpectedOutput" (:matches? r))
    (put-some! o "outputText" (:output-text r))
    (put-some! o "upstreamStatus" (:upstream-status r))
    (put-some! o "errorCode" (:error-code r))
    (aset o "message" (:message r))
    o))

(defn- decode-base64url [segment]
  (.toString (.from js/Buffer segment "base64url") "utf8"))

(defn- header-js [token accept workspace-id extra]
  (let [h #js {"authorization" (str "Bearer " token) "accept" accept}]
    (doseq [[k v] extra] (aset h k v))
    (aset h "originator" "codex_cli_rs")
    (when (and workspace-id (seq (j/trim workspace-id)))
      (aset h "chatgpt-account-id" (j/trim workspace-id)))
    h))

;; ---------------------------------------------------------------------------
;; Token refresh
;; ---------------------------------------------------------------------------

(defn- ^:async refresh-token-call [profile refresh-token fetch-fn]
  (let [^js response (await (fetch-fn (:token-url profile)
                                      #js {:method "POST"
                                           :headers #js {"content-type" "application/x-www-form-urlencoded"}
                                           :body (.toString (js/URLSearchParams.
                                                             #js {:grant_type "refresh_token"
                                                                  :refresh_token refresh-token
                                                                  :client_id (:client-id profile)}))}))]
    (when (.-ok response)
      (let [payload (js->clj (await (.json response)))]
        (q/refreshed-tokens payload (now-ms))))))

(defn- ^:async refresh-account-tokens [profile provider-id account ^js store fetch-fn logger]
  (when-let [refresh-token (not-empty (some-> (:refresh-token account) j/trim))]
    (if-let [tokens (await (refresh-token-call profile refresh-token fetch-fn))]
      (let [next-account (q/apply-refresh account tokens (q/jwt-claims (:access-token tokens) decode-base64url))]
        (await (.upsertOAuthAccount store provider-id (:id next-account) (:access-token tokens) (:refresh-token tokens)
                                    (undef (:expires-at tokens)) (undef (:chatgpt-account-id next-account))
                                    (undef (:email next-account)) (undef (:subject next-account))
                                    (undef (:plan-type next-account))))
        (when (fn? (.-flush store)) (await (.flush store)))
        (log! logger "info" #js {:providerId provider-id :accountId (:id account)} "refreshed OpenAI account token")
        next-account)
      (do (log! logger "warn" #js {:providerId provider-id :accountId (:id account)} "failed to refresh OpenAI account token")
          nil))))

(defn- ^:async ensure-fresh-account [profile provider-id account store fetch-fn logger]
  (if (q/needs-refresh? account (now-ms) (:refresh-buffer-ms profile))
    (or (await (refresh-account-tokens profile provider-id account store fetch-fn logger)) account)
    account))

;; ---------------------------------------------------------------------------
;; Usage
;; ---------------------------------------------------------------------------

(defn- ^:async usage-attempt [profile fetch-fn token workspace-id]
  (let [controller (js/AbortController.)
        timeout (js/setTimeout #(.abort controller) (:usage-timeout-ms profile))]
    (try
      (let [^js response (await (fetch-fn (:usage-url profile)
                                          #js {:method "GET"
                                               :headers (header-js token "application/json" workspace-id nil)
                                               :signal (.-signal controller)}))]
        (if-not (.-ok response)
          {:ok false :status (.-status response) :text (await (.text response))}
          {:ok true :payload (js->clj (await (.json response)))}))
      (finally (js/clearTimeout timeout)))))

(defn- ^:async fetch-usage-payload [profile token workspace-id fetch-fn]
  (let [primary (await (usage-attempt profile fetch-fn token workspace-id))]
    (if (:ok primary)
      {:payload (:payload primary) :resolved-workspace-id workspace-id}
      (if (q/retry-without-workspace? (q/error-code (:text primary)) workspace-id)
        (let [fallback (await (usage-attempt profile fetch-fn token nil))]
          (if (:ok fallback)
            {:payload (:payload fallback) :resolved-workspace-id nil}
            (throw (js/Error. (q/error-message (:status fallback) (:text fallback))))))
        (throw (js/Error. (q/error-message (:status primary) (:text primary))))))))

(defn- ^:async persist-usage! [provider-id fresh token resolved-workspace plan ^js store]
  (await (.upsertOAuthAccount store provider-id (:id fresh) token (undef (:refresh-token fresh)) (undef (:expires-at fresh))
                              (undef resolved-workspace) (undef (:email fresh)) (undef (:subject fresh)) (undef plan)))
  (when (fn? (.-flush store)) (await (.flush store))))

(defn- ^:async fetch-quota-for-account [profile provider-id account store fetch-fn logger]
  (let [fetched-at (now-iso)]
    (try
      (let [fresh (await (ensure-fresh-account profile provider-id account store fetch-fn logger))
            token (q/access-token fresh)]
        (if-not token
          (q/error-snapshot provider-id fresh fetched-at "Missing access token")
          (let [workspace (q/workspace-id fresh)
                {:keys [payload resolved-workspace-id]} (await (fetch-usage-payload profile token workspace fetch-fn))
                details (q/quota-details payload (now-ms))
                plan (q/plan-type payload (:plan-type fresh))]
            (when (q/persist-usage-result? fresh plan resolved-workspace-id)
              (await (persist-usage! provider-id fresh token resolved-workspace-id plan store)))
            (q/ok-snapshot provider-id fresh fetched-at resolved-workspace-id plan details))))
      (catch :default e
        (let [message (err-message e)]
          (log! logger "warn" #js {:providerId provider-id :accountId (:id account) :error message}
                "failed to fetch OpenAI quota usage")
          (q/error-snapshot provider-id account fetched-at message))))))

(defn- ^:async list-oauth-accounts [^js store provider-id account-id]
  (let [providers (await (.listProviders store true))
        provider (first (filter #(= provider-id (.-id ^js %)) (array-seq providers)))]
    (q/oauth-accounts (map js->account (array-seq (or (some-> ^js provider .-accounts) #js []))) account-id)))

(defn ^:async fetch-openai-quota-snapshots
  "{:generated-at :accounts [snapshot]} as data; see `fetch-openai-quota-snapshots-js`."
  [manifest-path store ^js options]
  (let [profile (profile-for manifest-path)
        fetch-fn (nullish-or (.-fetchFn options) (.-fetch js/globalThis))
        provider-id (.-providerId options)
        logger (.-logger options)
        accounts (if-let [given (.-accounts options)]
                   (q/oauth-accounts (map js->account (array-seq given)) (.-accountId options))
                   (await (list-oauth-accounts store provider-id (.-accountId options))))
        snapshots (await (js/Promise.all
                          (to-array (map #(fetch-quota-for-account profile provider-id % store fetch-fn logger) accounts))))]
    {:generated-at (now-iso) :accounts (vec (array-seq snapshots))}))

(defn ^:async fetch-openai-quota-snapshots-js
  "Quota snapshots of a provider's OAuth accounts, fetched concurrently.
  options: {providerId, accountId?, accounts?, fetchFn?, logger?}."
  [manifest-path store options]
  (let [{:keys [generated-at accounts]} (await (fetch-openai-quota-snapshots manifest-path store options))]
    #js {:generatedAt generated-at :accounts (to-array (map snapshot->js accounts))}))

;; ---------------------------------------------------------------------------
;; Liveness probe
;; ---------------------------------------------------------------------------

(defn- probe-payload [model]
  (assoc (responses/chat-request->responses-request
          {"model" model
           "messages" [{"role" "user" "content" "Reply with exactly hello."}]
           "reasoning_effort" "none"})
         "instructions" "" "store" false "stream" true))

(defn- ^:async probe-attempt [profile fetch-fn endpoint token model workspace-id]
  (let [controller (js/AbortController.)
        timeout (js/setTimeout #(.abort controller) (:probe-timeout-ms profile))]
    (try
      (let [^js response (await (fetch-fn endpoint
                                          #js {:method "POST"
                                               :headers (header-js token "text/event-stream, application/json" workspace-id
                                                                   [["content-type" "application/json"]])
                                               :body (json/write (probe-payload model))
                                               :signal (.-signal controller)}))]
        (if-not (.-ok response)
          (let [text (await (.text response))]
            {:ok false :status (.-status response) :text text :error-code (q/error-code text)
             :resolved-workspace-id workspace-id})
          (let [content-type (j/lower (nullish-or (.get (.-headers response) "content-type") ""))]
            (if (or (.includes content-type "text/event-stream") (zero? (count content-type)))
              (let [stream-text (await (.text response))]
                (if-let [upstream-error (stream/event-stream->error-payload stream-text)]
                  (let [text (json/write {"error" upstream-error})]
                    {:ok false :status 400 :text text :error-code (q/error-code text)
                     :resolved-workspace-id workspace-id})
                  (if-let [terminal (stream/extract-terminal-response stream-text)]
                    {:ok true :payload terminal :resolved-workspace-id workspace-id :upstream-status (.-status response)}
                    {:ok false :status 502 :text "OpenAI Codex probe stream completed without a terminal response."
                     :resolved-workspace-id workspace-id})))
              {:ok true :payload (js->clj (await (.json response))) :resolved-workspace-id workspace-id
               :upstream-status (.-status response)}))))
      (finally (js/clearTimeout timeout)))))

(defn- ^:async fetch-probe-response [profile fetch-fn base-url path token workspace-id model]
  (let [endpoint (str (.replace base-url (js/RegExp. "/+$") "") (if (.startsWith path "/") path (str "/" path)))
        primary (await (probe-attempt profile fetch-fn endpoint token model workspace-id))]
    (cond
      (:ok primary) primary
      (q/retry-without-workspace? (:error-code primary) workspace-id)
      (await (probe-attempt profile fetch-fn endpoint token model nil))
      :else primary)))

(defn- ^:async run-probe [profile fetch-fn ^js options model current]
  (if-let [token (q/access-token current)]
    (await (fetch-probe-response profile fetch-fn (.-openAiBaseUrl options) (.-openAiResponsesPath options)
                                 token (q/workspace-id current) model))
    {:ok false :status 401 :text "Missing access token."
     :resolved-workspace-id (:chatgpt-account-id current)}))

(defn ^:async probe-openai-account-js
  "Send a minimal Codex request with the account and report whether it answered.
  options: {providerId, accountId, openAiBaseUrl, openAiResponsesPath, model?, fetchFn?, logger?}."
  [manifest-path store ^js options]
  (let [profile (profile-for manifest-path)
        fetch-fn (nullish-or (.-fetchFn options) (.-fetch js/globalThis))
        provider-id (.-providerId options)
        logger (.-logger options)
        tested-at (now-iso)
        model (or (not-empty (some-> (.-model options) j/trim)) (:probe-model profile))
        expected (:probe-expected-text profile)
        account (first (await (list-oauth-accounts store provider-id (.-accountId options))))]
    (when-not account
      (throw (js/Error. (str "OpenAI account not found: " (.-accountId options)))))
    (let [run-probe #(run-probe profile fetch-fn options model %)
          fresh (await (ensure-fresh-account profile provider-id account store fetch-fn logger))
          first-response (await (run-probe fresh))
          [fresh response] (if (and (not (:ok first-response)) (= "token_expired" (:error-code first-response)))
                             (if-let [refreshed (await (refresh-account-tokens profile provider-id fresh store fetch-fn logger))]
                               [refreshed (await (run-probe refreshed))]
                               [fresh first-response])
                             [fresh first-response])
          base (q/probe-result provider-id fresh tested-at model expected (:resolved-workspace-id response))]
      (probe->js
       (if-not (:ok response)
         (assoc base :status "error" :ok false :matches? false :upstream-status (:status response)
                :error-code (:error-code response) :message (q/error-message (:status response) (:text response)))
         (try
           (let [completion (responses/responses->chat-completion (:payload response) model (now-ms))
                 {:keys [output-text matches? message]} (q/probe-outcome (q/completion-text completion) expected)]
             (assoc base :status "ok" :ok true :matches? matches? :output-text output-text
                    :upstream-status (:upstream-status response) :message message))
           (catch :default e
             (assoc base :status "error" :ok false :matches? false :upstream-status (:upstream-status response)
                    :message (err-message e)))))))))
