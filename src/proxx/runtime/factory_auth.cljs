(ns proxx.runtime.factory-auth
  "File, crypto and HTTP edge of Factory auth (`src/lib/factory-auth.ts`):
  the auth.v2 envelope decision logic is `proxx.oauth.factory`; this namespace
  reads the key and data files, runs AES-256-GCM, and talks to WorkOS.

  Secrets never reach a log line: warnings carry paths and error messages only."
  (:require ["node:crypto" :as crypto]
            ["node:fs/promises" :as fsp]
            ["node:os" :as os]
            ["node:path" :as path]
            [clojure.string :as str]
            [proxx.oauth.factory :as factory]
            [proxx.runtime.oauth :as oauth]))

(defn- env-or [name default-fn]
  (let [v (aget js/process.env name)]
    (if (some? v) v (default-fn))))

(defn- auth-file-path [] (env-or "FACTORY_AUTH_V2_FILE" #(.join path (.homedir os) ".factory" "auth.v2.file")))
(defn- auth-key-path [] (env-or "FACTORY_AUTH_V2_KEY" #(.join path (.homedir os) ".factory" "auth.v2.key")))

(defn- as-js-error
  "Domain failures are `ex-info`; callers of the TS API expect plain Errors."
  [e]
  (if (ex-data e) (js/Error. (ex-message e)) e))

(defn- credentials->js [{:keys [access-token refresh-token]}]
  #js {"accessToken" access-token "refreshToken" refresh-token})

(defn decrypt-auth-v2-js [key-base64 encrypted-content]
  (try
    (let [key (js/Buffer.from (str/trim key-base64) "base64")
          [iv tag ciphertext] (map #(js/Buffer.from % "base64") (factory/split-auth-v2 encrypted-content))
          ^js decipher (.createDecipheriv crypto "aes-256-gcm" key iv)]
      (.setAuthTag decipher tag)
      (let [decrypted (js/Buffer.concat #js [(.update decipher ciphertext) (.final decipher)])]
        (credentials->js (factory/auth-v2-credentials (js->clj (js/JSON.parse (.toString decrypted "utf-8")))))))
    (catch :default e (throw (as-js-error e)))))

(defn encrypt-auth-v2-js [key-base64 data]
  (let [key (js/Buffer.from (str/trim key-base64) "base64")
        iv (.randomBytes crypto 16)
        ^js cipher (.createCipheriv crypto "aes-256-gcm" key iv)
        ciphertext (js/Buffer.concat #js [(.update cipher (js/JSON.stringify data) "utf-8") (.final cipher)])
        tag (.getAuthTag cipher)]
    (str (.toString iv "base64") ":" (.toString tag "base64") ":" (.toString ciphertext "base64"))))

(defn- message-of [e] (if (instance? js/Error e) (.-message e) (str e)))

(defn ^:async load-factory-auth-v2-js []
  (let [file (auth-file-path) key-file (auth-key-path)]
    (try
      (let [[key-content encrypted] (await (js/Promise.all #js [(.readFile fsp key-file "utf-8") (.readFile fsp file "utf-8")]))]
        (decrypt-auth-v2-js key-content encrypted))
      (catch :default e
        (when-not (and (instance? js/Error e) (= "ENOENT" (.-code ^js e)))
          (js/console.warn (str "[factory-auth] Failed to load Factory OAuth credentials from " file ": " (message-of e))))
        nil))))

(defn ^:async persist-factory-auth-v2-js [access-token refresh-token]
  (let [file (auth-file-path) key-file (auth-key-path)]
    (try
      (let [key-content (await (.readFile fsp key-file "utf-8"))
            encrypted (encrypt-auth-v2-js (str/trim key-content)
                                          #js {"access_token" access-token "refresh_token" refresh-token})]
        (await (.writeFile fsp file encrypted "utf-8")))
      (catch :default e
        (js/console.warn (str "[factory-auth] Failed to persist refreshed tokens to " file ": " (message-of e)))))))

(defn parse-jwt-expiry-js [token]
  (factory/jwt-expiry-ms (oauth/jwt-claims token)))

(defn factory-credential-needs-refresh-js [^js credential]
  (factory/needs-refresh? {:provider-id (.-providerId credential)
                           :auth-type (.-authType credential)
                           :refresh-token (.-refreshToken credential)
                           :expires-at (.-expiresAt credential)}
                          (parse-jwt-expiry-js (.-token credential))
                          (js/Date.now)))

(defn ^:async refresh-factory-oauth-token-js [refresh-token fetch-fn]
  (let [^js response (await (fetch-fn factory/authenticate-url
                                      #js {"method" "POST"
                                           "headers" #js {"content-type" "application/x-www-form-urlencoded"}
                                           "body" (.toString (js/URLSearchParams. (clj->js (factory/refresh-params refresh-token))))}))]
    (when-not (.-ok response)
      (throw (js/Error. (str "WorkOS token refresh failed: " (.-status response) " " (await (.text response))))))
    (try
      (let [{:keys [access-token refresh-token]} (factory/refreshed-tokens (js->clj (await (.json response))))
            o #js {"accessToken" access-token "refreshToken" refresh-token}
            expires (parse-jwt-expiry-js access-token)]
        (when (some? expires) (aset o "expiresAt" expires))
        o)
      (catch :default e (throw (as-js-error e))))))
