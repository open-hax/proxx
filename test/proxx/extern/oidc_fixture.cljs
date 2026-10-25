;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.extern.oidc-fixture
  "Synthetic wire fixture for the real relying-party library; no human sessions."
  (:require [clojure.string :as str]
            ["node:crypto" :as crypto]))

(def issuer "https://authority.example/oidc")
(def origin "https://product.example")
(def client-id "fixture-proxx")
(def secret "fixture-confidential-client-secret")
(def subject "SyntheticActor/CaseSensitive")

(defn- b64 [value] (.toString (js/Buffer.from (js/JSON.stringify (clj->js value))) "base64url"))
(defn- response [body status]
  (js/Response. (js/JSON.stringify (clj->js body))
                #js {:status status :headers #js {"content-type" "application/json"}}))

(defn create []
  (let [^js keys (crypto/generateKeyPairSync "rsa" #js {:modulusLength 2048})
        public-key (js->clj (.export (.-publicKey keys) #js {:format "jwk"}) :keywordize-keys true)
        codes (atom {}) tokens (atom {}) refreshes (atom {}) devices (atom {}) revoked (atom #{})
        mode (atom {}) exchanges (atom 0) checks (atom 0) rotations (atom 0)
        sign-token (fn [claims]
                     (let [body (str (b64 {:alg "RS256" :kid "fixture-key"}) "." (b64 claims))]
                       (str body "." (.toString (crypto/sign "RSA-SHA256" (js/Buffer.from body)
                                                             (.-privateKey keys)) "base64url"))))
        metadata {:issuer issuer :authorization_endpoint (str issuer "/auth")
                  :device_authorization_endpoint (str issuer "/device/auth")
                  :token_endpoint (str issuer "/token") :jwks_uri (str issuer "/jwks")
                  :introspection_endpoint (str issuer "/introspection")
                  :revocation_endpoint (str issuer "/revocation")
                  :response_types_supported ["code"] :subject_types_supported ["public"]
                  :id_token_signing_alg_values_supported ["RS256"]
                  :token_endpoint_auth_methods_supported ["client_secret_post"]
                  :code_challenge_methods_supported ["S256"]}
        transport
        (fn ^:async fixture-fetch [url options]
          (when (:unavailable @mode) (throw (js/TypeError. "fixture authority unavailable")))
          (let [url (js/URL. (str url))
                path (.-pathname url)
                body (js/URLSearchParams. (.-body options))
                field (fn [k] (.get body k))
                authenticated? (and (= client-id (field "client_id")) (= secret (field "client_secret")))]
            (when (and (= path "/oidc/introspection") (:introspection-unavailable @mode))
              (throw (js/TypeError. "fixture introspection unavailable")))
            (cond
              (and (= path "/oidc/introspection") (:introspection-status @mode))
              (response {:error "temporarily_unavailable"} (:introspection-status @mode))
              (str/includes? path ".well-known") (response (merge metadata (:metadata @mode)) 200)
              (= path "/oidc/jwks") (response {:keys [(assoc public-key :kid "fixture-key" :alg "RS256" :use "sig")]} 200)
              (not authenticated?) (response {:error "invalid_client"} 401)
              (= path "/oidc/device/auth")
              (let [code (crypto/randomUUID)]
                (swap! devices assoc code true)
                (response {:device_code code :user_code "TEST-CODE" :verification_uri (str issuer "/device")
                           :verification_uri_complete (str issuer "/device?user_code=TEST-CODE")
                           :expires_in 600 :interval 5} 200))
              (and (= path "/oidc/token")
                   (= "urn:ietf:params:oauth:grant-type:device_code" (field "grant_type")))
              (case (:device-status @mode)
                :approved (let [now (long (/ (.now js/Date) 1000))
                                access (str "device-access-" (crypto/randomUUID))]
                            (if (get @devices (field "device_code"))
                              (do (swap! devices dissoc (field "device_code"))
                                  (swap! tokens assoc access {:active true :sub subject :client_id client-id
                                                              :exp (+ now 300) :scope "openid profile"})
                                  (response {:access_token access :token_type "Bearer" :expires_in 300
                                             :id_token (sign-token (merge {:iss issuer :aud client-id :sub subject
                                                                          :iat now :exp (+ now 300)} (:device-claims @mode)))} 200))
                              (response {:error "invalid_grant"} 400)))
                :denied (response {:error "access_denied"} 400)
                :expired (response {:error "expired_token"} 400)
                (response {:error "authorization_pending"} 400))
              (and (= path "/oidc/token") (= "refresh_token" (field "grant_type")))
              (let [old (field "refresh_token") tx (get @refreshes old)]
                (swap! rotations inc)
                (swap! refreshes dissoc old)
                (when-let [entered (:refresh-entered @mode)] ((entered)))
                (when-let [barrier (:refresh-wait @mode)] (await barrier))
                (if (and tx (not (contains? @revoked old)))
                  (let [now (long (/ (.now js/Date) 1000))
                        access (str "renewed-access-" (crypto/randomUUID))
                        refresh (str "renewed-refresh-" (crypto/randomUUID))
                        claims (merge {:iss issuer :sub subject :aud client-id :iat now :exp (+ now 300)
                                       :nonce (:nonce tx)} (:refresh-claims @mode))]
                    (swap! refreshes assoc refresh tx)
                    (swap! tokens assoc access {:active true :sub subject :client_id client-id
                                               :exp (+ now 300) :scope "openid profile"
                                               :root_session_expires_at (+ now 3600)})
                    (response (cond-> {:access_token access :refresh_token refresh :token_type "Bearer" :expires_in 300}
                                (not (:omit-refresh-id-token @mode)) (assoc :id_token (sign-token claims))) 200))
                  (response {:error "invalid_grant"} 400)))
              (= path "/oidc/token")
              (let [code (field "code") tx (get @codes code)
                    verifier (field "code_verifier")
                    challenge (when verifier (.digest (.update (crypto/createHash "sha256") verifier) "base64url"))
                    now (long (/ (.now js/Date) 1000))]
                (swap! exchanges inc)
                (swap! codes dissoc code)
                (if (and tx (= (:code_challenge tx) challenge)
                         (= (:redirect_uri tx) (field "redirect_uri")))
                  (let [access-token (str "opaque-fixture-" (crypto/randomUUID))
                        refresh-token (str "refresh-fixture-" (crypto/randomUUID))
                        claims (merge {:iss issuer :sub subject :aud client-id :iat now :exp (+ now 300)
                                       :nonce (:nonce tx)} (:claims @mode))]
                    (swap! refreshes assoc refresh-token tx)
                    (swap! tokens assoc access-token {:active true :client_id client-id :sub subject
                                                       :exp (+ now 300) :scope "openid profile"
                                                       :root_session_expires_at (+ now 3600)})
                    (response {:refresh_token refresh-token :access_token access-token :token_type "Bearer" :expires_in 300
                               :id_token (sign-token claims)} 200))
                  (response {:error "invalid_grant"} 400)))
              (= path "/oidc/introspection")
              (do (swap! checks inc)
                  (response (if (contains? @revoked (field "token")) {:active false}
                                (merge (or (get @tokens (field "token")) {:active false}) (:evidence @mode))) 200))
              (= path "/oidc/revocation")
              (do (swap! revoked conj (field "token")) (response {} 200))
              :else (response {:error "fixture_not_found"} 404))))]
    {:transport transport :mode mode :tokens tokens :revoked revoked
     :exchanges exchanges :checks checks :rotations rotations :refreshes refreshes
     :issue-code (fn [authorization-url]
                   (let [url (js/URL. authorization-url)
                         parameters (js->clj (js/Object.fromEntries (.-searchParams url)) :keywordize-keys true)
                         code (crypto/randomUUID)]
                     (swap! codes assoc code parameters)
                     {:code code :state (:state parameters) :parameters parameters}))}))
