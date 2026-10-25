(ns proxx.routing.tenant-key
  "Tenant identifiers and API-key derivations (the decision half of
  src/lib/tenant-api-key.ts). Everything persisted — tenant ids, the visible key
  prefix, the peppered digest — is byte-for-byte what the TypeScript produced.
  Hashing is an injected `sha256-hex` fn; randomness stays at the edge."
  (:require [clojure.string :as str]))

(def default-tenant-id "default")
(def api-key-prefix "ohpk_")
(def visible-prefix-length 12)

(defn- fail [message type] (throw (ex-info message {:error/type type})))

(defn normalize-tenant-id
  "Trimmed, lower-cased tenant id. A blank id is rejected."
  [value]
  (let [normalized (str/lower-case (str/trim value))]
    (if (str/blank? normalized)
      (fail "tenant id must not be empty" ::empty-tenant-id)
      normalized)))

(defn- trimmed-token [token]
  (let [t (str/trim token)]
    (if (str/blank? t) (fail "tenant api key must not be empty" ::empty-token) t)))

(defn key-prefix
  "The first `visible-prefix-length` characters of the trimmed token: the only
  part of a key that may be displayed."
  [token]
  (let [t (trimmed-token token)]
    (subs t 0 (min visible-prefix-length (count t)))))

(defn key-hash
  "sha256 hex of `pepper` `:` trimmed-token. The pepper is used verbatim."
  [sha256-hex token pepper]
  (let [t (trimmed-token token)]
    (when (str/blank? pepper)
      (fail "tenant api key pepper must not be empty" ::empty-pepper))
    (sha256-hex (str pepper ":" t))))
