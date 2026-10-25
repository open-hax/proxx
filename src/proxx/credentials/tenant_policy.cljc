(ns proxx.credentials.tenant-policy
  "Normalization and row mapping of tenant provider policies (the persisted
  records the federation policy engine reads). Input and output are
  string-keyed camelCase data; invalid enum values and non-positive limits are
  errors, never silently coerced."
  (:require [clojure.string :as str]
            [proxx.oauth.flow :as flow]))

(def provider-kinds ["local_upstream" "peer_proxx"])
(def share-modes ["deny" "descriptor_only" "relay_only" "warm_import" "project_credentials"])
(def trust-tiers ["owned_administered" "less_trusted"])

(defn- fail [message type] (throw (ex-info message {:error/type type})))

(defn- normalize-enum [value allowed fallback label]
  (if (or (not (string? value)) (empty? (str/trim value)))
    fallback
    (let [normalized (str/lower-case (str/trim value))]
      (if (some #{normalized} allowed)
        normalized
        (fail (str "invalid " label ": " value) :tenant-policy/invalid-enum)))))

(defn normalize-kind [v] (normalize-enum v provider-kinds "local_upstream" "tenant provider kind"))
(defn normalize-share-mode [v] (normalize-enum v share-modes "deny" "tenant provider share mode"))
(defn normalize-trust-tier [v] (normalize-enum v trust-tiers "less_trusted" "tenant provider trust tier"))

(defn- allowed-models [value]
  (if (sequential? value)
    (vec (distinct (->> value (filter string?) (map str/trim) (remove empty?))))
    []))

(defn- optional-positive-int [value label]
  (when (some? value)
    (when-not (flow/finite-number? value)
      (fail (str label " must be a finite number when present") :tenant-policy/invalid-limit))
    (let [n (Math/floor value)]
      (when (<= n 0)
        (fail (str label " must be a positive integer when present") :tenant-policy/invalid-limit))
      n)))

(defn- required-string [value label]
  (let [t (str/trim value)]
    (when (empty? t) (fail (str label " must not be empty") :tenant-policy/empty-field))
    t))

(defn normalize-input
  "The normalized upsert input (absent optionals omitted). Fields are validated
  in the order the legacy store did, so the first error is the same."
  [input]
  (let [share-mode (normalize-share-mode (get input "shareMode"))
        subject (required-string (get input "subjectDid") "tenant provider subject DID")
        provider (str/lower-case (required-string (get input "providerId") "tenant provider providerId"))
        kind (normalize-kind (get input "providerKind"))
        owner (required-string (get input "ownerSubject") "tenant provider ownerSubject")
        tier (normalize-trust-tier (get input "trustTier"))
        models (allowed-models (get input "allowedModels"))
        rpm (optional-positive-int (get input "maxRequestsPerMinute") "maxRequestsPerMinute")
        concurrent (optional-positive-int (get input "maxConcurrentRequests") "maxConcurrentRequests")
        encrypted (let [v (get input "encryptedChannelRequired")] (if (some? v) v (= share-mode "project_credentials")))
        warm (optional-positive-int (get input "warmImportThreshold") "warmImportThreshold")
        notes (let [n (get input "notes")] (when (and (string? n) (seq (str/trim n))) (str/trim n)))]
    (cond-> {"subjectDid" subject "providerId" provider "providerKind" kind "ownerSubject" owner
             "shareMode" share-mode "trustTier" tier "allowedModels" models "encryptedChannelRequired" encrypted}
      rpm (assoc "maxRequestsPerMinute" rpm)
      concurrent (assoc "maxConcurrentRequests" concurrent)
      warm (assoc "warmImportThreshold" warm)
      notes (assoc "notes" notes))))

(defn upsert-params
  "The parameters of UPSERT_TENANT_PROVIDER_POLICY for a normalized input."
  [n]
  [(get n "subjectDid") (get n "providerId") (get n "providerKind") (get n "ownerSubject") (get n "shareMode")
   (get n "trustTier") (get n "allowedModels") (get n "maxRequestsPerMinute") (get n "maxConcurrentRequests")
   (get n "encryptedChannelRequired") (get n "warmImportThreshold") (get n "notes")])

(defn parse-allowed-models [value parse]
  (cond
    (sequential? value) (vec (filter string? value))
    (string? value) (let [p (parse value)] (if (sequential? p) (vec (filter string? p)) []))
    :else []))

(defn policy-record [row parse]
  (letfn [(some-key [m k v] (if (some? v) (assoc m k v) m))]
    (-> {"subjectDid" (get row "subject_did") "providerId" (get row "provider_id")
         "providerKind" (get row "provider_kind") "ownerSubject" (get row "owner_subject")
         "shareMode" (get row "share_mode") "trustTier" (get row "trust_tier")
         "allowedModels" (parse-allowed-models (get row "allowed_models") parse)
         "encryptedChannelRequired" (get row "encrypted_channel_required")
         "createdAt" (get row "created_at") "updatedAt" (get row "updated_at")}
        (some-key "maxRequestsPerMinute" (get row "max_requests_per_minute"))
        (some-key "maxConcurrentRequests" (get row "max_concurrent_requests"))
        (some-key "warmImportThreshold" (get row "warm_import_threshold"))
        (some-key "notes" (get row "notes")))))

(defn list-filters
  "[clauses values] for the optional subject/owner filters (trimmed, non-blank)."
  [filters]
  (reduce (fn [[clauses values] [k column]]
            (let [v (get filters k)]
              (if (and (string? v) (seq (str/trim v)))
                (let [values (conj values (str/trim v))]
                  [(conj clauses (str column " = $" (count values))) values])
                [clauses values])))
          [[] []]
          [["subjectDid" "subject_did"] ["ownerSubject" "owner_subject"]]))
