(ns proxx.routing.account-identity
  "OAuth account identity: what a token's claims say about an account, and
  whether two identities are the same account (the pure half of
  src/lib/account-identity.ts). These values are persisted and compared across
  re-authentication, so the normalisation is exactly the TypeScript one:
  `email`/`plan` lower-cased, everything trimmed, blanks absent."
  (:require [clojure.string :as str]))

(def ^:private profile-claim "https://api.openai.com/profile")
(def ^:private auth-claim "https://api.openai.com/auth")

(defn- first-string
  "The first argument that is a string (even an empty one: `a ?? b` stops there)."
  [& xs]
  (some #(when (string? %) %) xs))

(defn- present
  "A trimmed string, or nil when it is nil or blank."
  [s]
  (when (some? s)
    (let [t (str/trim s)] (when-not (str/blank? t) t))))

(defn derive-oauth-metadata
  "{:email :subject :chatgpt-account-id :plan-type} from decoded JWT claims;
  keys with no usable value are absent. Non-map claims yield {}."
  [claims]
  (let [profile (get claims profile-claim)
        auth (get claims auth-claim)
        email (some-> (first-string (get claims "email") (get profile "email")) str/trim str/lower-case present)
        subject (some-> (first-string (get claims "sub")) present)
        workspace (some-> (first-string (get claims "chatgpt_account_id") (get auth "chatgpt_account_id")) present)
        plan (some-> (first-string (get auth "chatgpt_plan_type")) str/trim str/lower-case present)]
    (into {} (filter val)
          {:email email :subject subject :chatgpt-account-id workspace :plan-type plan})))

(defn display-name
  "email, else workspace id, else the account id (first one that is not nil)."
  [{:keys [email chatgpt-account-id id]}]
  (first (filter some? [email chatgpt-account-id id])))

(defn- clean [x] (when (string? x) (present x)))

(defn reauth-identity-matches?
  "Same account when subjects match, else when emails match (case-insensitively),
  else when workspaces match and the target carries neither a subject nor an email."
  [target resolved]
  (let [t-sub (clean (:subject target)) r-sub (clean (:subject resolved))
        t-email (some-> (clean (:email target)) str/lower-case)
        r-email (some-> (clean (:email resolved)) str/lower-case)
        t-ws (clean (:chatgpt-account-id target)) r-ws (clean (:chatgpt-account-id resolved))]
    (boolean (or (and t-sub r-sub (= t-sub r-sub))
                 (and t-email r-email (= t-email r-email))
                 (and t-ws r-ws (= t-ws r-ws) (not t-sub) (not t-email))))))
