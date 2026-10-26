(ns proxx.federation.projections
  "On-demand pulls of a peer's account knowledge, as decisions over data already fetched.

  What to pull, whether a peer's last pull is still fresh, and exactly which
  projected-account rows a peer's reply turns into are pure. The edge
  (proxx.runtime.federation-projections) sequences the store reads/writes and
  the fetches."
  (:require [clojure.string :as str]
            [proxx.federation.helpers :as helpers]))

(def default-ttl-ms 60000)

(def ^:private truthy-pattern
  ;; /iu, as in the original: the `u` flag changes which code points fold to ASCII.
  #?(:cljs (js/RegExp. "^(1|true|yes|on)$" "iu")
     :clj #"(?iu)^(1|true|yes|on)$"))

(defn pull-enabled?
  "FEDERATION_ON_DEMAND_PULL_ENABLED: on unless set to something other than 1/true/yes/on."
  [raw]
  (let [v (when (string? raw) (str/trim raw))]
    (if (seq v) (boolean (re-find truthy-pattern v)) true)))

(defn pull-ttl-ms
  "FEDERATION_ON_DEMAND_PULL_TTL_MS: a non-negative integer, else the default."
  [raw]
  (let [v (when (string? raw) (str/trim raw))
        n (when (seq v) (helpers/parse-int v))]
    (if (and n (== n n) (< n ##Inf) (>= n 0)) n default-ttl-ms)))

(defn active-peer? [peer]
  (= "active" (str/lower-case (str/trim (str (get peer "status"))))))

(defn fresh?
  "Was the peer pulled less than `ttl-ms` ago? A zero ttl disables the cache."
  [last-pull-at now-ms ttl-ms]
  (let [last-ms (when (and (string? last-pull-at) (seq last-pull-at)) #?(:cljs (js/Date.parse last-pull-at) :clj ##NaN))]
    (boolean (and last-ms (== last-ms last-ms) (< last-ms ##Inf) (pos? ttl-ms) (< (- now-ms last-ms) ttl-ms)))))

(defn account-key
  "Identity of an account within a peer's reply (provider is case-insensitive)."
  [provider-id account-id]
  (str (str/lower-case (str/trim provider-id)) "\u0000" (str/trim account-id)))

(defn- invalid [message] (throw (ex-info message {:error/type :federation/invalid-remote-accounts})))

(defn- entries [remote k]
  (let [v (get remote k)]
    (if (sequential? v) v (invalid (str "remoteAccounts." k " is not iterable")))))

(defn- compact [m] (into {} (remove (comp nil? val)) m))

(defn- entry [x] (if (map? x) x (invalid "remote account entry must be an object")))

(defn- string-or-nil [x] (when (string? x) x))

(defn projection-upserts
  "Rows to upsert for one peer's reply, in order: the peer's own accounts first,
  then the accounts it projects from others (skipping its own, already seen).

  Throws before anything is written when the reply is malformed, so a bad reply
  never leaves half its rows behind."
  [peer-id owner-subject remote]
  (let [locals (mapv entry (entries remote "localAccounts"))
        projected (mapv entry (entries remote "projectedAccounts"))
        own-keys (into #{} (map #(account-key (get % "providerId") (get % "accountId"))) locals)]
    (into
     (mapv (fn [a]
             (let [oauth? (= "oauth_bearer" (get a "authType"))]
               (compact {"sourcePeerId" peer-id "ownerSubject" owner-subject
                         "providerId" (get a "providerId") "accountId" (get a "accountId")
                         "accountSubject" (get a "subject") "chatgptAccountId" (get a "chatgptAccountId")
                         "email" (get a "email") "planType" (get a "planType")
                         "availabilityState" (if oauth? "remote_route" "descriptor")
                         "metadata" (compact (cond-> {"hasCredentials" (get a "hasCredentials")
                                             "knowledgeSources" (get a "knowledgeSources")
                                             "authType" (get a "authType")
                                             "credentialMobility" (if oauth? "access_token_only" "importable")
                                             "refreshAuthority" (if oauth? "owner_only" "portable")}
                                      (number? (get a "cooldownUntilMs")) (assoc "cooldownUntilMs" (get a "cooldownUntilMs"))))})))
           locals)
     (keep (fn [a]
             (when-not (and (= peer-id (get a "sourcePeerId"))
                            (contains? own-keys (account-key (get a "providerId") (get a "accountId"))))
               (let [metadata (let [m (get a "metadata")] (if (map? m) m {}))
                     auth-type (string-or-nil (get metadata "authType"))
                     sources (when (sequential? (get metadata "knowledgeSources"))
                               (filterv string? (get metadata "knowledgeSources")))]
                 (compact {"sourcePeerId" peer-id "ownerSubject" owner-subject
                           "providerId" (get a "providerId") "accountId" (get a "accountId")
                           "accountSubject" (get a "accountSubject") "chatgptAccountId" (get a "chatgptAccountId")
                           "email" (get a "email") "planType" (get a "planType")
                           "availabilityState" (get a "availabilityState")
                           "metadata" (compact (assoc (dissoc metadata "authType" "knowledgeSources")
                                                      "authType" auth-type "knowledgeSources" sources))}))))
           projected))))
