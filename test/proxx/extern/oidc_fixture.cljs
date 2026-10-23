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
        codes (atom {}) tokens (atom {}) revoked (atom #{})
        mode (atom {}) exchanges (atom 0) checks (atom 0)
        sign-token (fn [claims]
                     (let [body (str (b64 {:alg "RS256" :kid "fixture-key"}) "." (b64 claims))]
                       (str body "." (.toString (crypto/sign "RSA-SHA256" (js/Buffer.from body)
                                                             (.-privateKey keys)) "base64url"))))
        metadata {:issuer issuer :authorization_endpoint (str issuer "/auth")
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
            (cond
              (str/includes? path ".well-known") (response (merge metadata (:metadata @mode)) 200)
              (= path "/oidc/jwks") (response {:keys [(assoc public-key :kid "fixture-key" :alg "RS256" :use "sig")]} 200)
              (not authenticated?) (response {:error "invalid_client"} 401)
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
                        claims (merge {:iss issuer :sub subject :aud client-id :iat now :exp (+ now 300)
                                       :nonce (:nonce tx)} (:claims @mode))]
                    (swap! tokens assoc access-token {:active true :client_id client-id :sub subject
                                                       :exp (+ now 300) :scope "openid profile"})
                    (response {:access_token access-token :token_type "Bearer" :expires_in 300
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
     :exchanges exchanges :checks checks
     :issue-code (fn [authorization-url]
                   (let [url (js/URL. authorization-url)
                         parameters (js->clj (js/Object.fromEntries (.-searchParams url)) :keywordize-keys true)
                         code (crypto/randomUUID)]
                     (swap! codes assoc code parameters)
                     {:code code :state (:state parameters) :parameters parameters}))}))
