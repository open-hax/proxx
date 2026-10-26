(ns proxx.web.api
  "The web console's API client as data.

  Every endpoint is a pure constructor returning a *request description*
  `{:method :path :query :body :decode}`; `:decode` is a pure function over the
  parsed response. The only code that performs a request is the fetch edge in
  `proxx.web.runtime`. Paths, query shapes and bodies are therefore plain data
  and are tested without a network.

  Wire payloads arrive string-keyed (`proxx.json`); `keywordize` turns the
  shapes the UI reads into keyword maps while keeping provider-defined subtrees
  (`meta`, `payload`, `auth`, `capabilities`, id-keyed maps) untouched."
  (:require [clojure.string :as str]
            [proxx.json :as json]))

(def auth-token-key "open-hax-proxy.auth-token")
(def auth-token-cookie "open_hax_proxy_auth_token")

;; ---------------------------------------------------------------------------
;; URLs and queries

(defn encode-component [s]
  #?(:cljs (js/encodeURIComponent (str s))
     :clj (-> (java.net.URLEncoder/encode (str s) "UTF-8") (str/replace "+" "%20"))))

(defn- blank-value? [v] (or (nil? v) (and (string? v) (str/blank? v)) (false? v)))

(defn query-string
  "URLSearchParams-style query from ordered `[k v]` pairs; nil/\"\"/false skipped.
  Returns \"\" or \"?a=b\"."
  [pairs]
  (let [parts (->> pairs
                   (remove (comp blank-value? second))
                   (map (fn [[k v]]
                          (str (-> (encode-component (name k)) (str/replace "%20" "+"))
                               "="
                               (-> (encode-component (str v)) (str/replace "%20" "+"))))))]
    (if (seq parts) (str "?" (str/join "&" parts)) "")))

(defn base-url
  "Same rule the console has always used: an explicit base wins; the Vite/preview
  port 5174 talks to the API on 8789 of the same host; otherwise same-origin."
  [{:keys [explicit protocol hostname port]}]
  (let [explicit (str/trim (or explicit ""))]
    (cond
      (seq explicit) (str/replace explicit #"/+$" "")
      (= port "5174") (str protocol "//" hostname ":8789")
      :else "")))

(defn absolute-url [base path]
  (if (re-find #"(?i)^https?://" path) path (str base path)))

(defn request-headers
  "Auth + (for bodies) content-type, lowercase string keys."
  [token body?]
  (cond-> {}
    (seq (str/trim (or token ""))) (assoc "authorization" (str "Bearer " token))
    body? (assoc "content-type" "application/json")))

;; ---------------------------------------------------------------------------
;; Responses

(defn error-message
  "Message for a non-2xx response whose body parsed to `data`."
  [status data]
  (let [msg (get-in data ["error" "message"])
        detail (get data "detail")]
    (cond
      (string? msg) msg
      (string? detail) detail
      :else (str "Request failed: " status))))

(defn parse-body
  "Empty body is `{}`; otherwise JSON. A malformed body on an error status
  yields nil so the status message is reported."
  [text ok?]
  (if (str/blank? text)
    {}
    (try (json/parse text)
         (catch #?(:cljs :default :clj Exception) e
           (if ok? (throw e) nil)))))

(defn interpret-response
  "`{:status n :text s}` -> `{:ok data}` | `{:error msg}`."
  [{:keys [status text]}]
  (let [ok? (<= 200 status 299)]
    (try
      (let [data (parse-body text ok?)]
        (if ok? {:ok data} {:error (error-message status data)}))
      (catch #?(:cljs :default :clj Exception) e
        {:error (or (ex-message e) (str e))}))))

(defn keywordize
  "String-keyed wire data -> keyword-keyed. `opaque` keys keep their raw value;
  `keep-keys` keys keep their string keys but their values are recursed."
  ([x] (keywordize x #{"meta" "payload" "auth" "capabilities"} #{"keyPoolStatuses" "requestLogSummary" "tags"}))
  ([x opaque keep-keys]
   (letfn [(walk [x]
             (cond
               (map? x) (reduce-kv
                         (fn [m k v]
                           (let [k (if (string? k) k (str k))]
                             (cond
                               (contains? opaque k) (assoc m (keyword k) v)
                               (and (contains? keep-keys k) (map? v))
                               (assoc m (keyword k) (reduce-kv (fn [m2 k2 v2] (assoc m2 k2 (walk v2))) {} v))
                               :else (assoc m (keyword k) (walk v)))))
                         {} x)
               (sequential? x) (mapv walk x)
               :else x))]
     (walk x))))

;; ---------------------------------------------------------------------------
;; Request descriptions

(defn- req
  [method path {:keys [query body decode]}]
  (cond-> {:method method :path (str path (query-string query))}
    (some? body) (assoc :body body)
    decode (assoc :decode decode)))

(defn- kw-then [f] (fn [data] (f (keywordize data))))
(def ^:private kw (kw-then identity))

(defn- compact [m] (into {} (remove (comp nil? val)) m))

;; sessions / chat ----------------------------------------------------------

(defn list-sessions [] (req :get "/api/v1/sessions" {:decode (kw-then :sessions)}))
(defn create-session [title] (req :post "/api/v1/sessions" {:body (compact {:title title}) :decode (kw-then :session)}))
(defn get-session [session-id] (req :get (str "/api/v1/sessions/" session-id) {:decode (kw-then :session)}))
(defn get-session-prompt-cache-key [session-id]
  (req :get (str "/api/v1/sessions/" session-id "/cache-key") {:decode (kw-then :promptCacheKey)}))
(defn add-session-message [session-id message]
  (req :post (str "/api/v1/sessions/" session-id "/messages") {:body (compact message) :decode (kw-then :message)}))
(defn fork-session [session-id message-id]
  (req :post (str "/api/v1/sessions/" session-id "/fork") {:body (compact {:messageId message-id}) :decode (kw-then :session)}))
(defn search-session-history [query limit]
  (req :post "/api/v1/sessions/search" {:body {:query query :limit limit} :decode kw}))
(defn run-chat-completion [payload] (req :post "/v1/chat/completions" {:body payload}))
(defn run-image-generation [payload] (req :post "/v1/images/generations" {:body payload}))

(defn normalize-models
  "`/v1/models` payload -> sorted distinct trimmed non-empty ids."
  [payload]
  (let [data (get payload "data")]
    (if (sequential? data)
      (->> data
           (keep (fn [m] (let [id (when (map? m) (get m "id"))] (when (string? id) (str/trim id)))))
           (remove str/blank?)
           distinct
           sort
           vec)
      [])))

(defn list-models [] (req :get "/v1/models" {:decode normalize-models}))

;; dashboard / hosts / analytics / settings -----------------------------------

(defn- sort-window-query [sort window]
  (letfn [(norm [v] (when (and (string? v) (not (str/blank? v))) (str/trim v)))]
    [["sort" (norm sort)] ["window" (norm window)]]))

(defn get-usage-overview [sort window]
  (req :get "/api/v1/dashboard/overview" {:query (sort-window-query sort window) :decode kw}))
(defn get-hosts-overview [] (req :get "/api/v1/hosts/overview" {:decode kw}))
(defn get-provider-model-analytics [sort window]
  (req :get "/api/v1/analytics/provider-model" {:query (sort-window-query sort window) :decode kw}))
(defn get-proxy-ui-settings [] (req :get "/api/v1/settings" {:decode kw}))
(defn save-proxy-ui-settings [settings] (req :post "/api/v1/settings" {:body settings :decode kw}))

;; events --------------------------------------------------------------------

(defn list-events
  "`filters`: :kind :entryId :providerId :model :status :statusGte :statusLt :tag
  :since :until :limit :offset :includePayload :includeCount."
  [{:keys [kind entryId providerId model status statusGte statusLt tag since until limit offset
           includePayload includeCount]}]
  (req :get "/api/v1/events"
       {:query [["kind" kind] ["entry_id" entryId] ["provider_id" providerId] ["model" model]
                ["status" (when (number? status) status)]
                ["status_gte" (when (number? statusGte) statusGte)]
                ["status_lt" (when (number? statusLt) statusLt)]
                ["tag" tag] ["since" since] ["until" until]
                ["limit" (when (number? limit) limit)]
                ["offset" (when (number? offset) offset)]
                ["include_payload" (when includePayload "true")]
                ["include_count" (when includeCount "true")]]
        :decode kw}))
(defn get-event-by-id [id] (req :get (str "/api/v1/events/" (encode-component id)) {:decode (kw-then :event)}))
(defn list-event-tags [] (req :get "/api/v1/events/tags" {:decode kw}))
(defn add-event-tag [event-id tag] (req :post (str "/api/v1/events/" (encode-component event-id) "/tag") {:body {:tag tag}}))
(defn remove-event-tag [event-id tag] (req :delete (str "/api/v1/events/" (encode-component event-id) "/tag") {:body {:tag tag}}))

;; credentials ---------------------------------------------------------------

(defn list-credentials [reveal?]
  (req :get "/api/v1/credentials" {:query [["reveal" (when reveal? "1")]] :decode kw}))
(defn add-api-key-credential [provider-id api-key account-id]
  (req :post "/api/v1/credentials/api-key"
       {:body (cond-> {:providerId provider-id :apiKey api-key}
                (and (string? account-id) (not (str/blank? account-id))) (assoc :accountId (str/trim account-id)))}))
(defn remove-credential [provider-id account-id]
  (req :delete "/api/v1/credentials/account" {:body {:providerId provider-id :accountId account-id}}))
(defn disable-account [provider-id account-id]
  (req :post "/api/v1/credentials/account/disable" {:body {:providerId provider-id :accountId account-id}}))
(defn enable-account [provider-id account-id]
  (req :post "/api/v1/credentials/account/enable" {:body {:providerId provider-id :accountId account-id}}))
(defn get-disabled-accounts [] (req :get "/api/v1/credentials/accounts/disabled" {:decode kw}))
(defn get-openai-credential-quota [account-id]
  (req :get "/api/v1/credentials/openai/quota"
       {:query [["accountId" (when (string? account-id) (str/trim account-id))]] :decode kw}))
(defn get-openai-prompt-cache-audit [limit]
  (req :get "/api/v1/credentials/openai/prompt-cache-audit"
       {:query [["limit" (when (and (number? limit) (pos? limit)) (long limit))]] :decode kw}))
(defn probe-openai-credential-account [account-id]
  (req :post "/api/v1/credentials/openai/probe" {:body {:accountId account-id} :decode kw}))
(defn probe-ollama-cloud-credential-account [account-id]
  (req :post "/api/v1/credentials/ollama-cloud/probe" {:body {:accountId account-id} :decode kw}))
(defn start-openai-browser-oauth [redirect-base-url account-id]
  (req :post "/api/v1/credentials/openai/oauth/browser/start"
       {:body (compact {:redirectBaseUrl redirect-base-url :accountId account-id}) :decode kw}))
(defn start-openai-device-oauth [] (req :post "/api/v1/credentials/openai/oauth/device/start" {:decode kw}))
(defn poll-openai-device-oauth [device-auth-id user-code]
  (req :post "/api/v1/credentials/openai/oauth/device/poll" {:body {:deviceAuthId device-auth-id :userCode user-code} :decode kw}))
(defn start-factory-browser-oauth [redirect-base-url]
  (req :post "/api/v1/credentials/factory/oauth/browser/start" {:body {:redirectBaseUrl redirect-base-url} :decode kw}))
(defn start-factory-device-oauth [] (req :post "/api/v1/credentials/factory/oauth/device/start" {:decode kw}))
(defn poll-factory-device-oauth [device-auth-id]
  (req :post "/api/v1/credentials/factory/oauth/device/poll" {:body {:deviceAuthId device-auth-id} :decode kw}))

(defn list-request-logs [{:keys [providerId accountId limit before]}]
  (req :get "/api/v1/request-logs"
       {:query [["providerId" providerId] ["accountId" accountId]
                ["limit" (when (number? limit) limit)] ["before" before]]
        :decode (kw-then :entries)}))

;; tools / mcp ---------------------------------------------------------------

(defn list-tool-seeds [model]
  (req :get (str "/api/v1/tools?model=" (encode-component model)) {:decode (kw-then :tools)}))
(defn list-mcp-seeds [] (req :get "/api/v1/mcp-servers" {:decode (kw-then :servers)}))

;; federation ------------------------------------------------------------------

(defn- owner-suffix [owner-subject]
  (if (and owner-subject (not (str/blank? owner-subject)))
    (str "?ownerSubject=" (encode-component (str/trim owner-subject)))
    ""))

(defn get-federation-self [] (req :get "/api/v1/federation/self" {:decode kw}))
(defn list-federation-peers [owner-subject]
  (req :get (str "/api/v1/federation/peers" (owner-suffix owner-subject)) {:decode (kw-then :peers)}))
(defn add-federation-peer [input]
  (req :post "/api/v1/federation/peers" {:body (compact input) :decode (kw-then :peer)}))
(defn get-federation-accounts [owner-subject]
  (req :get (str "/api/v1/federation/accounts" (owner-suffix owner-subject)) {:decode kw}))
(defn sync-federation-peer [input]
  (req :post "/api/v1/federation/sync/pull" {:body (compact input) :decode kw}))
(defn list-federation-bridges [] (req :get "/api/v1/federation/bridges" {:decode (kw-then :sessions)}))

(def federation-ws-path "/api/v1/federation/observability/ws")
