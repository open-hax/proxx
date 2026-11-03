(ns proxx.runtime.account-identity
  "JS edge for src/lib/account-identity.ts: base64url + JSON decoding of the JWT
  payload live here, the identity rules in proxx.routing.account-identity."
  (:require [proxx.runtime.interop :as interop]
            [proxx.routing.account-identity :as identity]))

(defn- jwt-claims
  "The decoded JWT payload as a JS value, or nil when the token is not a
  three-part JWT whose payload is a JSON object (arrays count as objects,
  exactly as the TypeScript treated them)."
  [token]
  (let [parts (.split (str token) ".")]
    (when (= 3 (.-length parts))
      (try
        (let [parsed (js/JSON.parse (.toString (.from js/Buffer (aget parts 1) "base64url") "utf8"))]
          (when (and (some? parsed) (= "object" (js* "typeof ~{}" parsed))) parsed))
        (catch :default _ nil)))))

(defn derive-oauth-metadata-from-token-js [token]
  (if-let [claims (jwt-claims token)]
    (let [{:keys [email subject chatgpt-account-id plan-type]} (identity/derive-oauth-metadata (interop/js->data claims))
          o #js {}]
      (doseq [[k v] [["email" email] ["subject" subject] ["chatgptAccountId" chatgpt-account-id] ["planType" plan-type]]]
        (aset o k (if (some? v) v js/undefined)))
      o)
    #js {}))

(defn account-display-name-js [^js account]
  (identity/display-name {:email (.-email account) :chatgpt-account-id (.-chatgptAccountId account) :id (.-id account)}))

(defn- identity->clj [^js id]
  {:email (.-email id) :subject (.-subject id) :chatgpt-account-id (.-chatgptAccountId id)})

(defn open-ai-reauth-identity-matches-js [target resolved]
  (identity/reauth-identity-matches? (identity->clj target) (identity->clj resolved)))
