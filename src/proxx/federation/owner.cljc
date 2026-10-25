(ns proxx.federation.owner
  "Federation owner identity: AT-protocol DIDs and the legacy admin-key owner.

  The owner subject is persisted identity (peers, projected accounts and
  bridge sessions are keyed by it), so DID normalization and the admin-key
  fingerprint keep their exact TypeScript semantics. Hashing is injected."
  (:require [clojure.string :as str]))

;; JS's `u` flag matters: under /iu the case-insensitive classes also admit the
;; two non-ASCII code points that fold to ASCII (U+017F, U+212A), which the
;; TypeScript patterns (and therefore every stored owner subject) accept.
(def ^:private did-plc-pattern
  #?(:cljs (js/RegExp. "^did:plc:[a-z2-7]{24}$" "iu")
     :clj #"(?iu)^did:plc:[a-z2-7]{24}$"))

(def ^:private did-web-pattern
  #?(:cljs (js/RegExp. "^did:web:[a-z0-9.-]+(?:[:/][A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$" "iu")
     :clj #"(?iu)^did:web:[a-z0-9.-]+(?:[:/][A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$"))

(defn at-did?
  "True when the trimmed value is a did:plc or did:web identifier."
  [value]
  (let [v (when (string? value) (str/trim value))]
    (boolean (and (seq v) (or (re-find did-plc-pattern v) (re-find did-web-pattern v))))))

(defn normalize-at-did
  "Canonical DID: did:plc lower-cased; did:web with only the host lower-cased
  (the path is case-sensitive). Throws on a non-DID."
  [value]
  (let [v (str/trim value)]
    (when-not (at-did? v)
      (throw (ex-info (str "invalid at did: " value) {:error/type :federation/invalid-at-did})))
    (if (str/starts-with? (str/lower-case v) "did:web:")
      (let [identifier (subs v (count "did:web:"))
            separator (->> [(str/index-of identifier "/") (str/index-of identifier ":")]
                           (remove nil?)
                           (reduce min ##Inf))
            cut (when-not (= separator ##Inf) separator)]
        (str "did:web:" (str/lower-case (if cut (subs identifier 0 cut) identifier))
             (if cut (subs identifier cut) "")))
      (str/lower-case v))))

(defn fingerprint-admin-key
  "First 32 hex characters of the key's SHA-256; `sha256-hex` is injected."
  [sha256-hex value]
  (subs (sha256-hex value) 0 32))

(defn parse-owner-credential
  "{\"kind\" \"value\" \"ownerSubject\"} for a DID or an admin key, nil for blank input."
  [sha256-hex raw]
  (let [value (when (string? raw) (str/trim raw))]
    (cond
      (not (seq value)) nil
      (at-did? value) (let [did (normalize-at-did value)]
                        {"kind" "at_did" "value" did "ownerSubject" did})
      :else {"kind" "admin_key" "value" value
             "ownerSubject" (str "legacy_admin_key:" (fingerprint-admin-key sha256-hex value))})))
