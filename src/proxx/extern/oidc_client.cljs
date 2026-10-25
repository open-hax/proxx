;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.oidc-client
  "Maintained relying-party and host primitives. No JWT validation is implemented here."
  (:require [clojure.string :as str]
            [proxx.auth.oidc-law :as law]
            ["node:crypto" :as crypto]
            ["node:module" :as module]))

(defn random-secret [] (.toString (crypto/randomBytes 32) "base64url"))
(defn digest [value] (.digest (.update (crypto/createHash "sha256") value) "hex"))
(defn now [] (.now js/Date))

(defn require-url! [value allow-loopback? origin?]
  (let [url (js/URL. value)
        local? (contains? #{"127.0.0.1" "[::1]" "localhost"} (.-hostname url))]
    (when-not (and (or (= "https:" (.-protocol url))
                       (and allow-loopback? local? (= "http:" (.-protocol url))))
                   (= "" (.-username url)) (= "" (.-password url))
                   (= "" (.-hash url)) (= "" (.-search url))
                   (or (not origin?) (= value (.-origin url))))
      (throw (ex-info "Axxium requires fixed HTTPS issuer and public origin" {}))))
  value)

(defn require-config! [config]
  (let [{:keys [issuer publicOrigin linksJson allowLoopback]} config
        links (js->clj (js/JSON.parse (or linksJson "[]")) :keywordize-keys true)]
    (require-url! issuer allowLoopback false)
    (require-url! publicOrigin allowLoopback true)
    (when-not (law/configuration-admitted? config links)
      (throw (ex-info "Axxium client configuration or approved links are invalid" {})))
    (assoc config :links links :callback (str publicOrigin law/callback-path)
           :secure? (str/starts-with? publicOrigin "https:"))))

(defn library! []
  (let [require-library (module/createRequire (str (.cwd js/process) "/package.json"))]
    (require-library "openid-client")))

(defn ^:async discover! [config]
  ;; openid-client supports require(esm) on Node >=22.12. Load only when the
  ;; configured consumer is used; native auth does not load this dependency.
  (let [^js client (library!)
        execute (cond-> [(.-enableNonRepudiationChecks client)]
                  (:allowLoopback config) (conj (.-allowInsecureRequests client)))
        options #js {:timeout law/authority-timeout-seconds :execute (clj->js execute)}
        _ (when-let [transport (:transport config)]
            (aset options (.-customFetch client) transport))
        ^js rp (await (.discovery client (js/URL. (:issuer config)) (:clientId config)
                              #js {:client_secret (:clientSecret config)
                                   :id_token_signed_response_alg "RS256"}
                              (.ClientSecretPost client (:clientSecret config))
                              options))
        metadata (js->clj (.serverMetadata rp) :keywordize-keys true)]
    ;; Discovery is trusted only for the exact configured authority; do not
    ;; let metadata send a client secret/token to another host.
    (doseq [field [:authorization_endpoint :token_endpoint :jwks_uri
                   :introspection_endpoint :revocation_endpoint]]
      (let [endpoint (get metadata field)]
        (require-url! endpoint (:allowLoopback config) false)
        (when-not (= (.-origin (js/URL. (:issuer config)))
                     (.-origin (js/URL. endpoint)))
          (throw (ex-info "Axxium discovery endpoint origin mismatch" {})))))
    (when (:deviceEnabled config)
      (let [endpoint (:device_authorization_endpoint metadata)]
        (require-url! endpoint (:allowLoopback config) false)
        (when-not (= (.-origin (js/URL. (:issuer config))) (.-origin (js/URL. endpoint)))
          (throw (ex-info "Device discovery endpoint origin mismatch" {})))))
    {:client client :rp rp}))

(defn ^:async authorization! [{:keys [^js client ^js rp]} config]
  (let [verifier (.randomPKCECodeVerifier client)
        state (.randomState client)
        nonce (.randomNonce client)
        challenge (await (.calculatePKCECodeChallenge client verifier))]
    {:state state :nonce nonce :verifier verifier
     :url (.-href (.buildAuthorizationUrl client rp
                  #js {:redirect_uri (:callback config) :response_type "code"
                       :scope "openid profile" :state state :nonce nonce
                       :code_challenge challenge :code_challenge_method "S256"}))}))

(defn ^:async exchange! [{:keys [^js client ^js rp]} config query transaction]
  (try
    (let [url (js/URL. (:callback config))]
      (set! (.-search url) query)
      (let [^js tokens (await (.authorizationCodeGrant client rp url
                               #js {:pkceCodeVerifier (:verifier transaction)
                                    :expectedState (:state transaction)
                                    :expectedNonce (:nonce transaction)
                                    :idTokenExpected true}))
            claims (js->clj (.claims tokens) :keywordize-keys true)]
        {:access-token (.-access_token tokens) :refresh-token (.-refresh_token tokens)
         :expires-at (min (* 1000 (:exp claims)) (+ (now) (* 1000 (.-expires_in tokens))))
         :claims claims}))
    (catch :default error
      (throw (ex-info "Shared authorization response refused"
                      (law/callback-failure (.-code error)))))))

(defn token-result!
  "Shape a signature-validated maintained RP response, requiring fresh ID evidence."
  [config ^js tokens]
  (let [claims (some-> (.claims tokens) (js->clj :keywordize-keys true))
        aud (:aud claims)
        audiences (if (string? aud) [aud] aud)]
    (when-not (and (= (:issuer config) (:iss claims))
                   (some #{(:clientId config)} audiences)
                   (law/nonblank? (:sub claims)) (number? (:exp claims))
                   (law/nonblank? (.-access_token tokens)) (number? (.-expires_in tokens)))
      (throw (ex-info "unauthorized" {:status 401 :error "unauthorized" :invalidate-session? true})))
    {:claims claims :access-token (.-access_token tokens) :refresh-token (.-refresh_token tokens)
     :expires-at (min (* 1000 (:exp claims)) (+ (now) (* 1000 (.-expires_in tokens))))}))

(defn protocol-error
  "Decode only maintained-library error identifiers, never response bodies."
  [error]
  {:oauth-error (.-error error) :validation-code (.-code error)})

(defn ^:async refresh! [{:keys [^js client ^js rp]} config session]
  (token-result! config (await (.refreshTokenGrant client rp (:refresh-token session)))))

(defn ^:async revoke-session! [{:keys [^js client ^js rp]} session]
  (let [results (await (js/Promise.allSettled
                        (clj->js (mapv (fn [[hint token]]
                                         (.tokenRevocation client rp token #js {:token_type_hint hint}))
                                       (filter second [["refresh_token" (:refresh-token session)]
                                                       ["access_token" (:access-token session)]])))))]
    (when (some #(= "rejected" (.-status %)) (array-seq results))
      (throw (ex-info "authority_unavailable" {:status 503 :error "authority_unavailable"})))))

(defn ^:async introspect! [{:keys [^js client ^js rp]} token]
  (js->clj (await (.tokenIntrospection client rp token
                   #js {:token_type_hint "access_token"})) :keywordize-keys true))

(defn ^:async revoke! [{:keys [^js client ^js rp]} token]
  (await (.tokenRevocation client rp token #js {:token_type_hint "access_token"})))

(defn cookie-name [config kind]
  (str (when (:secure? config) "__Host-") "proxx_axxium_" (name kind)))

(defn read-cookie [header cookie]
  (some (fn [part]
          (let [[k v] (str/split (str/trim part) #"=" 2)]
            (when (= k cookie) v)))
        (str/split (or header "") #";")))

(defn cookie [config kind value seconds]
  (str (cookie-name config kind) "=" value "; Path=/; HttpOnly; SameSite=Lax; Max-Age="
       seconds (when (:secure? config) "; Secure")))

(defn- trusted-device-uri! [config value]
  (let [url (js/URL. value)]
    (when-not (and (= (.-origin url) (.-origin (js/URL. (:issuer config))))
                   (or (= "https:" (.-protocol url)) (:allowLoopback config))
                   (= "" (.-username url)) (= "" (.-password url)) (= "" (.-hash url)))
      (throw (ex-info "authority_unavailable" {:status 503 :error "authority_unavailable"}))))
  value)

(defn ^:async device-start! [{:keys [^js client ^js rp]} config]
  (let [^js response (await (.initiateDeviceAuthorization client rp #js {:scope "openid profile"}))
        seconds (.-expires_in response)
        interval (or (.-interval response) 5)
        controller (js/AbortController.)]
    (when-not (and (integer? seconds) (<= 1 seconds 600)
                   (integer? interval) (<= 5 interval 600) (law/nonblank? (.-user_code response)))
      (throw (ex-info "authority_unavailable" {:status 503 :error "authority_unavailable"})))
    (trusted-device-uri! config (.-verification_uri response))
    (when (.-verification_uri_complete response)
      (trusted-device-uri! config (.-verification_uri_complete response)))
    {:handle #js {:response response :controller controller
                  :timer (js/setTimeout (fn [] (.abort controller)) (* 1000 seconds))}
     :expires-at (+ (now) (* 1000 seconds))
     :public (cond-> {:user_code (.-user_code response) :verification_uri (.-verification_uri response)
                      :expires_in seconds :interval interval}
               (.-verification_uri_complete response)
               (assoc :verification_uri_complete (.-verification_uri_complete response)))}))

(defn cancel-device! [^js handle]
  (.abort ^js (.-controller handle))
  (js/clearTimeout (.-timer handle)))

(defn ^:async device-grant! [{:keys [^js client ^js rp]} config ^js handle]
  (try
    (token-result! config
      (await (.pollDeviceAuthorizationGrant client rp (.-response handle) nil
               #js {:signal (.-signal ^js (.-controller handle))})))
    (catch :default error (throw error))))

(defn device-failure [error]
  (case (.-error ^js error) "access_denied" "denied" "expired_token" "expired" "failed"))

(defn on-device-expiry!
  "Remove sensitive transaction state when the bounded controller aborts."
  [^js handle expire!]
  (.addEventListener (.-signal ^js (.-controller handle)) "abort" expire! #js {:once true}))
