(ns proxx.runtime.oauth
  "Stateful edge of the OAuth managers: one atom per manager holding the
  immutable flow tables (`proxx.oauth.flow`), a side table for promises that
  are in flight, and the HTTP/crypto/clock effects sequenced around the pure
  decisions in `proxx.oauth.openai` and `proxx.oauth.factory`.

  The TypeScript classes build a manager with
    options  the legacy manager options object
    deps     {fetchFn, now, randomBytes (n) => Uint8Array, randomUUID () => string,
              callbackPort (openai), makeRefreshError (openai)}
  and forward their methods to the returned facade."
  (:require ["node:crypto" :as crypto]
            [proxx.oauth.factory :as factory]
            [proxx.oauth.flow :as flow]
            [proxx.oauth.openai :as openai]))

;; ---------------------------------------------------------------------------
;; Primitives
;; ---------------------------------------------------------------------------

(defn sha256-hex [s]
  (-> (.createHash crypto "sha256") (.update s) (.digest "hex")))

(defn jwt-claims
  "Claims of a JWT's payload segment as string-keyed data, or nil when the
  token is not a three-part JWT carrying JSON. The signature is NOT verified:
  these claims are only ever used to label an account, never to authorise."
  [token]
  (when (string? token)
    (let [parts (.split token ".")]
      (when (= 3 (alength parts))
        (try
          (js->clj (js/JSON.parse (.toString (js/Buffer.from (aget parts 1) "base64url") "utf8")))
          (catch :default _ nil))))))

(defn- form-body [pairs]
  (.toString (js/URLSearchParams. (clj->js pairs))))

(defn- put! [^js o k v]
  (when (some? v) (aset o k v))
  o)

(defn- post [fetch-fn url content-type body]
  (fetch-fn url #js {"method" "POST" "headers" #js {"content-type" content-type} "body" body}))

(def ^:private form-type "application/x-www-form-urlencoded")

(defn- ^:async read-json [^js response] (js->clj (await (.json response))))

(defn- pending-js [] #js {"state" "pending"})

(defn- ttls-of [^js options defaults]
  (let [pick (fn [v d] (if (some? v) v d))]
    {:browser-state-ttl-ms (pick (.-browserStateTtlMs options) (:browser-state-ttl-ms defaults))
     :browser-completion-ttl-ms (pick (.-browserCompletionTtlMs options) (:browser-completion-ttl-ms defaults))
     :device-state-ttl-ms (pick (.-deviceStateTtlMs options) (:device-state-ttl-ms defaults))}))

(def ^:private default-ttls
  {:browser-state-ttl-ms flow/default-browser-state-ttl-ms
   :browser-completion-ttl-ms flow/default-browser-completion-ttl-ms
   :device-state-ttl-ms flow/default-device-state-ttl-ms})

;; ---------------------------------------------------------------------------
;; OpenAI
;; ---------------------------------------------------------------------------

(defn- openai-tokens->js [{:keys [account-id chatgpt-account-id email subject access-token refresh-token expires-at plan-type]}]
  (-> #js {}
      (put! "accountId" account-id) (put! "chatgptAccountId" chatgpt-account-id)
      (put! "email" email) (put! "subject" subject)
      (put! "accessToken" access-token) (put! "refreshToken" refresh-token)
      (put! "expiresAt" expires-at) (put! "planType" plan-type)))

(defn- to-openai-tokens [now-ms response]
  (let [access (get response "access_token")]
    (when-not (string? access)
      (throw (js/Error. "OpenAI token response is missing access_token")))
    (let [id-token (get response "id_token")]
      (openai-tokens->js
       (openai/oauth-tokens sha256-hex now-ms response
                            (when (seq id-token) (jwt-claims id-token))
                            (jwt-claims access))))))

(defn- normalize-redirect-base [{:keys [allow-host-routed? port]} redirect-base-url]
  (if-not allow-host-routed?
    (openai/fixed-callback-base port)
    (let [url (js/URL. redirect-base-url)]
      (when (= :rewrite-loopback (openai/redirect-base-plan true (.-hostname url)))
        (aset url "hostname" "localhost")
        (aset url "port" port))
      (.toString url))))

(defn create-openai-oauth-manager-js [^js options ^js deps]
  (let [{:keys [oauth-scopes client-id issuer client-secret]}
        (openai/normalize-options {:oauth-scopes (.-oauthScopes options) :client-id (.-clientId options)
                                   :issuer (.-issuer options) :client-secret (.-clientSecret options)})
        fetch-fn (.-fetchFn deps)
        now (.-now deps)
        port (.-callbackPort deps)
        random-bytes (.-randomBytes deps)
        make-refresh-error (.-makeRefreshError deps)
        allow-host-routed? (boolean (.-allowHostRoutedCallbacks options))
        ttls (ttls-of options default-ttls)
        flows (atom flow/empty-flows)
        browser-in-flight (atom {})
        device-in-flight (atom {})
        prune! (fn [] (swap! flows flow/prune (now) ttls (set (keys @device-in-flight))))
        exchange-code
        (fn ^:async exchange-code [code redirect-uri verifier]
          (let [^js response (await (post fetch-fn (openai/token-endpoint issuer) form-type
                                          (form-body (openai/code-exchange-params
                                                      {:code code :redirect-uri redirect-uri :client-id client-id
                                                       :client-secret client-secret :code-verifier verifier}))))]
            (when-not (.-ok response)
              (throw (js/Error. (str "OpenAI token exchange failed with status " (.-status response)))))
            (await (read-json response))))
        poll-uncached
        (fn ^:async poll-uncached [device-auth-id user-code]
          (let [^js response (await (post fetch-fn (openai/device-token-endpoint issuer) "application/json"
                                          (js/JSON.stringify #js {"device_auth_id" device-auth-id "user_code" user-code})))]
            (if (.-ok response)
              (let [payload (await (read-json response))
                    tokens (await (exchange-code (get payload "authorization_code")
                                                 (openai/device-callback-uri issuer)
                                                 (get payload "code_verifier")))
                    result #js {"state" "authorized" "tokens" (to-openai-tokens (js/Date.now) tokens)}]
                (swap! flows flow/cache-device-result device-auth-id result (now) (:device-state-ttl-ms ttls))
                result)
              (let [[kind reason] (openai/device-poll-failure-plan (.-status response))]
                (if (= kind :pending)
                  (do (swap! flows flow/defer-next-poll device-auth-id (now))
                      (pending-js))
                  #js {"state" "failed" "reason" reason})))))]
    #js {"startBrowserFlow"
         (fn ^:async start-browser-flow [redirect-base-url]
           (let [verifier (openai/pkce-verifier (array-seq (js/Uint8Array. (random-bytes 43))))
                 challenge (-> (.createHash crypto "sha256") (.update verifier) (.digest "base64url"))
                 state (.toString (js/Buffer.from (random-bytes 32)) "base64url")
                 base (normalize-redirect-base {:allow-host-routed? allow-host-routed? :port port} redirect-base-url)
                 redirect-uri (.toString (js/URL. "/auth/callback" base))]
             (swap! flows flow/add-browser-pending state
                    {:created-at (now) :redirect-uri redirect-uri :verifier verifier})
             (prune!)
             #js {"state" state
                  "redirectUri" redirect-uri
                  "authorizeUrl" (str (openai/authorize-endpoint issuer) "?"
                                      (form-body (openai/authorization-params
                                                  {:redirect-uri redirect-uri :challenge challenge :state state
                                                   :oauth-scopes oauth-scopes :client-id client-id})))}))

         "completeBrowserFlow"
         (fn ^:async complete-browser-flow [state code]
           (prune!)
           (let [[action value] (flow/browser-completion-plan @flows state (now) (contains? @browser-in-flight state))]
             (case action
               :cached value
               :in-flight (await (get @browser-in-flight state))
               :unknown (throw (js/Error. "Unknown or expired OAuth state"))
               :exchange
               (do (swap! flows flow/take-browser-pending state)
                   (let [p (-> (exchange-code code (:redirect-uri value) (:verifier value))
                               (.then (fn [response]
                                        (let [tokens (to-openai-tokens (js/Date.now) response)]
                                          (swap! flows flow/record-browser-completion state tokens (now)
                                                 (:browser-completion-ttl-ms ttls))
                                          tokens)))
                               (.finally (fn [] (swap! browser-in-flight dissoc state))))]
                     (swap! browser-in-flight assoc state p)
                     (await p))))))

         "startDeviceFlow"
         (fn ^:async start-device-flow []
           (prune!)
           (let [^js response (await (post fetch-fn (openai/device-usercode-endpoint issuer) "application/json"
                                           (js/JSON.stringify #js {"client_id" client-id})))]
             (when-not (.-ok response)
               (throw (js/Error. (str "OpenAI device authorization failed with status " (.-status response)))))
             (let [payload (await (read-json response))
                   interval-ms (openai/device-interval-ms (get payload "interval"))
                   id (get payload "device_auth_id")
                   user-code (get payload "user_code")]
               (swap! flows flow/add-device-flow id
                      (flow/new-device-flow (now) interval-ms {:user-code user-code}))
               (-> #js {}
                   (put! "verificationUrl" (openai/device-verification-url issuer))
                   (put! "userCode" user-code) (put! "deviceAuthId" id) (put! "intervalMs" interval-ms)))))

         "pollDeviceFlow"
         (fn ^:async poll-device-flow [device-auth-id user-code]
           (prune!)
           (let [known (get-in @flows [:devices device-auth-id])
                 device (or known (flow/new-device-flow (now) flow/default-device-poll-interval-ms {:user-code user-code}))
                 _ (swap! flows flow/add-device-flow device-auth-id device)
                 [action value] (flow/device-poll-plan device (now) (contains? @device-in-flight device-auth-id))]
             (case action
               :cached value
               :in-flight (await (get @device-in-flight device-auth-id))
               :pending (pending-js)
               :poll (let [p (.finally (poll-uncached device-auth-id user-code)
                                       (fn [] (swap! device-in-flight dissoc device-auth-id)))]
                       (swap! device-in-flight assoc device-auth-id p)
                       (await p)))))

         "refreshToken"
         (fn ^:async refresh-token [refresh-token]
           (let [^js response (await (post fetch-fn (openai/token-endpoint issuer) form-type
                                           (form-body (openai/refresh-params
                                                       {:refresh-token refresh-token :client-id client-id
                                                        :client-secret client-secret}))))]
             (if (.-ok response)
               (to-openai-tokens (js/Date.now) (await (read-json response)))
               (let [text (await (.text response))
                     body (try (js->clj (js/JSON.parse text)) (catch :default _ nil))
                     {:keys [status message code type response-body]}
                     (openai/refresh-error-facts (.-status response) text body)]
                 (throw (make-refresh-error status message
                                            (-> #js {} (put! "code" code) (put! "type" type)
                                                (put! "responseBody" response-body))))))))

         "isTokenExpired"
         (fn [expires-at buffer-ms]
           (openai/token-expired? (now) expires-at (if (some? buffer-ms) buffer-ms openai/default-token-expiry-buffer-ms)))}))

(defn resolve-openai-callback-port-js [raw] (openai/callback-port raw))

(defn is-terminal-openai-refresh-error-facts-js
  "Facts: {status, code, type, message, responseBody} (JS)."
  [^js facts]
  (openai/terminal-refresh-error?
   {:status (.-status facts) :code (.-code facts) :type (.-type facts)
    :message (.-message facts) :response-body (.-responseBody facts)}))

(defn OpenAiOAuthRefreshError
  "Constructor of the refresh failure (an Error subclass): `new (status, message, {code, type, responseBody})`.
  Returns an object whose prototype is this constructor's, so `instanceof` holds."
  [status message details]
  (let [this (js/Object.create (.-prototype OpenAiOAuthRefreshError))]
    (aset this "name" "OpenAiOAuthRefreshError")
    (aset this "message" message)
    (aset this "stack" (.-stack (js/Error. message)))
    (aset this "status" status)
    (aset this "code" (if details (.-code ^js details) js/undefined))
    (aset this "type" (if details (.-type ^js details) js/undefined))
    (aset this "responseBody" (if details (.-responseBody ^js details) js/undefined))
    this))

(set! (.-prototype OpenAiOAuthRefreshError) (js/Object.create (.-prototype js/Error)))
(aset (.-prototype OpenAiOAuthRefreshError) "constructor" OpenAiOAuthRefreshError)

(defn terminal-openai-refresh-error?
  "True for an OpenAiOAuthRefreshError whose facts say the refresh token is unusable."
  [error]
  (and (instance? OpenAiOAuthRefreshError error)
       (is-terminal-openai-refresh-error-facts-js
        #js {"status" (.-status ^js error) "code" (.-code ^js error) "type" (.-type ^js error)
             "message" (.-message ^js error) "responseBody" (.-responseBody ^js error)})))

;; ---------------------------------------------------------------------------
;; Factory (WorkOS)
;; ---------------------------------------------------------------------------

(defn- to-factory-tokens [random-uuid response]
  (let [access (get response "access_token")]
    (when-not (string? access)
      (throw (js/Error. "WorkOS token response is missing access_token")))
    (let [{:keys [access-token refresh-token account-id email expires-at]}
          (factory/factory-tokens response (factory/jwt-expiry-ms (jwt-claims access)) random-uuid)]
      (-> #js {}
          (put! "accessToken" access-token) (put! "refreshToken" refresh-token)
          (put! "accountId" account-id) (put! "email" email) (put! "expiresAt" expires-at)))))

(defn- ^:async failing-response [what ^js response]
  (throw (js/Error. (str what ": " (.-status response) " " (await (.text response))))))

(defn create-factory-oauth-manager-js [^js options ^js deps]
  (let [fetch-fn (.-fetchFn deps)
        now (.-now deps)
        random-uuid (.-randomUUID deps)
        ttls (ttls-of options default-ttls)
        flows (atom flow/empty-flows)
        browser-in-flight (atom {})
        device-in-flight (atom {})
        prune! (fn [] (swap! flows flow/prune (now) ttls (set (keys @device-in-flight))))
        exchange-code
        (fn ^:async exchange-code [code]
          (let [^js response (await (post fetch-fn factory/authenticate-url form-type
                                          (form-body (factory/code-exchange-params code))))]
            (when-not (.-ok response)
              (await (failing-response "WorkOS token exchange failed" response)))
            (to-factory-tokens random-uuid (await (read-json response)))))
        poll-uncached
        (fn ^:async poll-uncached [device-auth-id device]
          (let [^js response (await (post fetch-fn factory/authenticate-url form-type
                                          (form-body (factory/device-poll-params (:device-code device)))))]
            (if (.-ok response)
              (let [result #js {"state" "authorized" "tokens" (to-factory-tokens random-uuid (await (read-json response)))}]
                (swap! flows flow/cache-device-result device-auth-id result (now) (:device-state-ttl-ms ttls))
                result)
              (let [body (try (await (read-json response)) (catch :default _ nil))
                    error (when (map? body) (get body "error"))
                    [kind reason] (factory/device-poll-failure-plan (.-status response) error)]
                (case kind
                  :pending (do (swap! flows flow/defer-next-poll device-auth-id (now)) (pending-js))
                  :slow-down (do (swap! flows flow/slow-down device-auth-id (now)) (pending-js))
                  :expired (do (swap! flows flow/drop-device device-auth-id) #js {"state" "failed" "reason" reason})
                  :failed #js {"state" "failed" "reason" reason})))))]
    #js {"startDeviceFlow"
         (fn ^:async start-device-flow []
           (prune!)
           (let [^js response (await (post fetch-fn factory/device-authorize-url form-type
                                           (form-body (factory/device-start-params))))]
             (when-not (.-ok response)
               (await (failing-response "WorkOS device authorization failed" response)))
             (let [payload (await (read-json response))
                   interval-ms (factory/device-interval-ms (get payload "interval"))
                   id (random-uuid)
                   user-code (get payload "user_code")]
               (swap! flows flow/add-device-flow id
                      (flow/new-device-flow (now) interval-ms {:device-code (get payload "device_code") :user-code user-code}))
               (-> #js {}
                   (put! "verificationUrl" (factory/verification-url payload))
                   (put! "userCode" user-code) (put! "deviceAuthId" id) (put! "intervalMs" interval-ms)))))

         "pollDeviceFlow"
         (fn ^:async poll-device-flow [device-auth-id]
           (prune!)
           (if-let [device (get-in @flows [:devices device-auth-id])]
             (let [[action value] (flow/device-poll-plan device (now) (contains? @device-in-flight device-auth-id))]
               (case action
                 :cached value
                 :in-flight (await (get @device-in-flight device-auth-id))
                 :pending (pending-js)
                 :poll (let [p (.finally (poll-uncached device-auth-id device)
                                         (fn [] (swap! device-in-flight dissoc device-auth-id)))]
                         (swap! device-in-flight assoc device-auth-id p)
                         (await p))))
             #js {"state" "failed" "reason" "Unknown or expired device authorization"}))

         "startBrowserFlow"
         (fn start-browser-flow [redirect-uri]
           (prune!)
           (let [state (random-uuid)]
             (swap! flows flow/add-browser-pending state {:created-at (now) :state state})
             #js {"authorizeUrl" (str factory/authorize-url "?" (form-body (factory/browser-authorize-params redirect-uri state)))
                  "state" state}))

         "completeBrowserFlow"
         (fn ^:async complete-browser-flow [state code]
           (prune!)
           (let [[action value] (flow/browser-completion-plan @flows state (now) (contains? @browser-in-flight state))]
             (case action
               :cached value
               :in-flight (await (get @browser-in-flight state))
               :unknown (throw (js/Error. "Unknown or expired OAuth state"))
               :exchange
               (do (swap! flows flow/take-browser-pending state)
                   (let [p (-> (exchange-code code)
                               (.then (fn [tokens]
                                        (swap! flows flow/record-browser-completion state tokens (now)
                                               (:browser-completion-ttl-ms ttls))
                                        tokens))
                               (.finally (fn [] (swap! browser-in-flight dissoc state))))]
                     (swap! browser-in-flight assoc state p)
                     (await p))))))}))


(defn create-openai-oauth-manager-default-js
  "An OpenAI OAuth manager over the process defaults (global fetch, Date.now, crypto
  randomness, OPENAI_OAUTH_CALLBACK_PORT). `options` as for create-openai-oauth-manager-js,
  plus optional fetchFn / now overrides."
  [^js options]
  (let [options (or options #js {})]
    (create-openai-oauth-manager-js
     options
     #js {"fetchFn" (or (.-fetchFn options) (.-fetch js/globalThis))
          "now" (or (.-now options) (fn [] (js/Date.now)))
          "callbackPort" (resolve-openai-callback-port-js (aget js/process.env "OPENAI_OAUTH_CALLBACK_PORT"))
          "randomBytes" (fn [length] (.getRandomValues js/crypto (js/Uint8Array. length)))
          "makeRefreshError" (fn [status message details] (new OpenAiOAuthRefreshError status message details))})))
