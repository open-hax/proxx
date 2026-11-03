(ns proxx.http.app
  "The application's global request decisions as pure functions of request
  facts (src/app.ts): CORS, which routes are public, who the internal bridge may
  act as, tenant quota, error and not-found responses, the landing page.

  The Fastify hooks are thin adapters (proxx.runtime.app): they gather facts,
  ask these functions, and apply the answer. Route allow-lists are data here, not
  conditionals in the hook."
  (:require [clojure.string :as str]
            [proxx.http.request :as http-request]))

;; ---------------------------------------------------------------------------
;; Route classes (data)
;; ---------------------------------------------------------------------------

(def public-paths
  "Reachable with no credentials: the landing page, health, the OAuth callbacks
  and the login/refresh/logout endpoints."
  #{"/" "/favicon.ico" "/health"
    "/api/ui/credentials/openai/oauth/browser/callback"
    "/api/v1/credentials/openai/oauth/browser/callback"
    "/auth/callback" "/auth/factory/callback"
    "/auth/login" "/auth/refresh" "/auth/logout"})

(def ui-session-prefixes
  "Path prefixes where a UI session cookie may authenticate the request."
  ["/api/ui/" "/api/v1/" "/auth/"])

(def ui-session-exact #{"/api/v1"})

(def tenant-quota-paths
  "POST routes that spend a tenant's request quota."
  #{"/v1/chat/completions" "/v1/responses" "/v1/images/generations" "/v1/embeddings"})

(def options-paths
  "Paths that answer CORS preflight with 204."
  ["/" "/health" "/v1/chat/completions" "/v1/responses" "/v1/images/generations" "/v1/embeddings"
   "/v1/models" "/v1/models/:model" "/api/chat" "/api/generate" "/api/embed" "/api/embeddings"
   "/api/tags" "/api/ui" "/api/ui/*" "/api/v1" "/api/v1/*"])

(def supported-v1-endpoints
  ["POST /v1/chat/completions" "POST /v1/responses" "POST /v1/images/generations"
   "POST /v1/embeddings" "GET /v1/models" "GET /v1/models/:model"])

(def supported-native-ollama-endpoints
  ["POST /api/chat" "POST /api/generate" "POST /api/embed" "POST /api/embeddings" "GET /api/tags"])

(def bridge-internal-prefix "/v1/")
(def owner-subject-header "x-open-hax-federation-owner-subject")
(def bridge-tenant-header "x-open-hax-bridge-tenant-id")
(def bridge-auth-header "x-open-hax-bridge-auth")
(def error-code-header "x-open-hax-error-code")

(defn public-route?
  "Is `path` open to anyone? `github-callback-path` is the configured GitHub OAuth callback."
  [path github-callback-path]
  (or (contains? public-paths path) (= path github-callback-path)))

(defn ui-session-route? [path]
  (or (contains? ui-session-exact path)
      (boolean (some #(str/starts-with? path %) ui-session-prefixes))))

(defn raw-path
  "The path of a raw request URL (no query string)."
  [url]
  (first (str/split url #"\?" 2)))

;; ---------------------------------------------------------------------------
;; CORS
;; ---------------------------------------------------------------------------

(defn cors-headers
  "The CORS headers every response carries; the caller's Origin is echoed."
  [origin]
  {"Access-Control-Allow-Origin" (or origin "*")
   "Vary" "Origin"
   "Access-Control-Allow-Headers" "Authorization, Content-Type, Accept, X-Requested-With, Cookie"
   "Access-Control-Allow-Methods" "GET, POST, DELETE, OPTIONS"})

;; ---------------------------------------------------------------------------
;; Errors
;; ---------------------------------------------------------------------------

(defn openai-error-body [message type code]
  {"error" (cond-> {"message" message "type" type "param" nil}
             (some? code) (assoc "code" code))})

(defn openai-error-response
  "The OpenAI-shaped error reply (with the error code also as a header)."
  [status message type code]
  (cond-> {:status status :body (openai-error-body message type code)}
    (seq code) (assoc :headers {error-code-header code})))

(def unauthorized-response
  (openai-error-response 401 "Unauthorized" "invalid_request_error" "unauthorized"))

(defn error-plan
  "How the global error handler answers. `typed` is {:status :message :type :code}
  for a typed OpenAI error, else nil. Returns {:level :log-message :response}."
  [typed]
  (if typed
    {:level :warn
     :log-message "request failed with typed OpenAI error"
     :response (openai-error-response (:status typed) (:message typed) (:type typed) (:code typed))}
    {:level :error
     :log-message "request failed with unhandled error"
     :response {:status 500 :body (openai-error-body "Internal server error" "server_error" "internal_error")}}))

(defn not-found-response
  "The 404 for an unmatched route."
  [method path]
  (cond
    (str/starts-with? path "/v1/")
    (openai-error-response 404 (str "Unsupported endpoint: " method " " path ". Supported endpoints: " (str/join ", " supported-v1-endpoints))
                           "invalid_request_error" "unsupported_endpoint")

    (str/starts-with? path "/api/v1/")
    (openai-error-response 404 (str "Unsupported endpoint: " method " " path ". Supported API v1 endpoints begin with /api/v1 and are routed through the canonical control surface.")
                           "invalid_request_error" "unsupported_endpoint")

    (str/starts-with? path "/api/")
    {:status 404 :body {"error" (str "Unsupported endpoint: " method " " path ". Supported native endpoints: " (str/join ", " supported-native-ollama-endpoints))}}

    :else {:status 404 :body {"ok" false "error" "Not Found"}}))

;; ---------------------------------------------------------------------------
;; Authentication
;; ---------------------------------------------------------------------------

(defn- trimmed-header [v] (when (string? v) (str/trim v)))

(defn bridge-internal-auth
  "The identity of a request from the co-located federation bridge, or nil. It
  needs the `internal` marker, an owner subject, a /v1/ path and a loopback
  peer; then it acts as the legacy owner (for the named tenant, else the default).

  NOTE: the peer address is the socket's, so behind a reverse proxy on the same
  host every client looks local."
  [{:keys [headers path remote-address default-tenant-id]}]
  (let [subject (trimmed-header (get headers owner-subject-header))
        tenant (trimmed-header (get headers bridge-tenant-header))]
    (when (and (= "internal" (get headers bridge-auth-header))
               (str/starts-with? path bridge-internal-prefix)
               (seq subject)
               (http-request/trusted-local-bridge-address? remote-address))
      {"kind" "legacy_admin"
       "tenantId" (if (seq tenant) tenant default-tenant-id)
       "role" "owner"
       "source" "none"
       "subject" subject})))

(defn active-tenant-id
  "The tenant a stored UI session is acting in, when it names one."
  [extra]
  (let [id (get extra "activeTenantId")] (when (string? id) id)))

(defn request-plan
  "What the global hook does with a request, from its method and raw path:
  :preflight (CORS only), :public (no authentication) or :authenticate, with
  whether a UI session cookie may authenticate it."
  [method path github-callback-path]
  (cond
    (= "OPTIONS" method) {:action :preflight}
    (public-route? path github-callback-path) {:action :public}
    :else {:action :authenticate :ui-session? (ui-session-route? path)}))

;; ---------------------------------------------------------------------------
;; Tenant quota and key usage
;; ---------------------------------------------------------------------------

(defn tenant-quota-route? [method path]
  (and (= "POST" method) (contains? tenant-quota-paths path)))

(defn quota-checked?
  "Is this request's tenant quota enforced? Not for unauthenticated callers."
  [method path auth]
  (and (tenant-quota-route? method path) (not= "unauthenticated" (get auth "kind"))))

(defn quota-exceeded-response
  "The 429 when `recent-count` requests in the last minute already reach the
  tenant's per-minute limit, else nil. A missing or non-positive limit means none."
  [tenant-id requests-per-minute recent-count]
  (when (and (number? requests-per-minute) (pos? requests-per-minute) (>= recent-count requests-per-minute))
    (-> (openai-error-response 429
                               (str "Tenant request quota exceeded for " tenant-id ". Allowed requests per minute: " requests-per-minute ".")
                               "rate_limit_error" "tenant_quota_exceeded")
        (update :headers assoc "retry-after" 60))))

(defn touch-key?
  "Should the tenant API key's last-used time be recorded? Only for a key
  authenticating a POST under /v1/."
  [auth method path store?]
  (boolean (and (= "tenant_api_key" (get auth "kind"))
                store?
                (= "POST" method)
                (str/starts-with? path "/v1/")
                (seq (get auth "tenantId"))
                (seq (get auth "keyId")))))

;; ---------------------------------------------------------------------------
;; Landing page
;; ---------------------------------------------------------------------------

(defn hostname-of
  "The hostname of a Host-header value, \"localhost\" when it has none."
  [host]
  (or (not-empty
       #?(:cljs (try (.-hostname (js/URL. (str "http://" host)))
                     (catch :default _ (first (str/split host #":" 2))))
          :clj (first (str/split host #":" 2))))
      "localhost"))

(defn web-console-url
  "Where the operator console runs: the host the client used, on the web port."
  [{:keys [forwarded-host host forwarded-proto protocol web-port]}]
  (let [trim #(some-> % str/trim)
        host (or (not-empty (trim forwarded-host)) (not-empty (trim host)) "localhost")
        proto (or (not-empty (trim forwarded-proto)) (not-empty protocol) "http")
        port (or (not-empty (str/trim web-port)) "5174")]
    (str proto "://" (hostname-of host) ":" port)))

(def ^:private landing-head "<!doctype html>\n<html>\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>Open Hax Proxy</title>\n    <style>\n      body { font-family: \"IBM Plex Sans\", \"Fira Sans\", sans-serif; background: radial-gradient(circle at top, #12313b 0%, #0b161c 60%); color: #e9f7fb; margin: 0; min-height: 100vh; display: grid; place-items: center; }\n      .card { background: rgba(17, 33, 42, 0.9); border: 1px solid rgba(145, 212, 232, 0.35); padding: 28px; border-radius: 14px; width: min(680px, 92vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }\n      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }\n      p { margin: 0 0 10px 0; color: #bce2ec; line-height: 1.5; }\n      code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; }\n      a { color: #9be7ff; }\n      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }\n      .button { display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border-radius: 10px; background: #10313d; border: 1px solid rgba(145, 212, 232, 0.35); color: #e9f7fb; text-decoration: none; }\n      .button.secondary { background: transparent; }\n    </style>\n  </head>\n  <body>\n    <section class=\"card\">\n      <h1>Open Hax OpenAI Proxy</h1>\n      <p>This port serves the proxy API and OAuth callback surface. The operator web console lives on a separate port.</p>\n      <p>You can open the console without an API token, then paste the frontend bearer token into the <code>Proxy Token</code> field there.</p>\n      <div class=\"actions\">\n        <a class=\"button\" href=\"")
(def ^:private landing-tail "\">Open web console</a>\n        <a class=\"button secondary\" href=\"/health\">View health</a>\n      </div>\n    </section>\n  </body>\n</html>")

(defn landing-page [console-url]
  (str landing-head (http-request/escape-html console-url) landing-tail))

;; ---------------------------------------------------------------------------
;; OpenAI OAuth account refresh and model inventory
;; ---------------------------------------------------------------------------

(defn refresh-candidates
  "Accounts to refresh: OAuth ones with a refresh token, restricted to
  `account-id` when it names one (blank means all)."
  [accounts account-id]
  (let [wanted (when (string? account-id) (not-empty (str/trim account-id)))]
    (filterv (fn [account]
               (and (= "oauth_bearer" (get account "authType"))
                    (string? (get account "refreshToken"))
                    (seq (str/trim (get account "refreshToken")))
                    (or (nil? wanted) (= wanted (get account "accountId")))))
             accounts)))

(defn advertised-model-ids
  "The distinct model ids the connected bridge sessions advertise, in first-seen order."
  [sessions]
  (vec (distinct (for [session sessions
                       capability (get session "capabilities")
                       model (get capability "models")]
                   model))))

(defn merge-model-ids
  "Local catalog ids then bridged ids, without repeats."
  [local-ids bridged-ids]
  (vec (distinct (concat local-ids bridged-ids))))
