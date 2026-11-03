(ns proxx.credentials.federation-sql
  "The SQL half of the federation store that is not row mapping: statement
  texts (persisted contracts, byte-for-byte what the TypeScript issued) and the
  decisions that turn a call's input (and, when the call merges, the existing
  record) into statement parameters.

  Inputs are shallow string-keyed maps in which `undefined` is absent and `null`
  is present (`contains?` tells them apart); values such as `auth`,
  `capabilities` and `metadata` are host objects and stay opaque. Records are the
  maps `proxx.credentials.federation` produces. JSON serialization and URL
  parsing are injected (`write-json`, `normalize-url`)."
  (:require [clojure.string :as str]
            [proxx.credentials.federation :as fed]
            [proxx.oauth.flow :as flow]))

;; ---------------------------------------------------------------------------
;; Statement texts
;; ---------------------------------------------------------------------------

(def create-peers
  "\nCREATE TABLE IF NOT EXISTS federation_peers (\n  id TEXT PRIMARY KEY,\n  owner_subject TEXT NOT NULL,\n  peer_did TEXT,\n  label TEXT NOT NULL,\n  base_url TEXT NOT NULL,\n  control_base_url TEXT,\n  auth_mode TEXT NOT NULL,\n  auth_json JSONB NOT NULL DEFAULT '{}'::jsonb,\n  status TEXT NOT NULL DEFAULT 'active',\n  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,\n  last_seen_at TIMESTAMPTZ,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  UNIQUE (base_url)\n);\n")

(def create-peers-owner-index
  "\nCREATE INDEX IF NOT EXISTS idx_federation_peers_owner_subject ON federation_peers(owner_subject);\n")

(def create-diff-events
  "\nCREATE TABLE IF NOT EXISTS federation_diff_events (\n  seq BIGSERIAL PRIMARY KEY,\n  owner_subject TEXT NOT NULL,\n  entity_type TEXT NOT NULL,\n  entity_key TEXT NOT NULL,\n  op TEXT NOT NULL,\n  payload JSONB NOT NULL DEFAULT '{}'::jsonb,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);\n")

(def create-diff-events-owner-seq-index
  "\nCREATE INDEX IF NOT EXISTS idx_federation_diff_events_owner_seq ON federation_diff_events(owner_subject, seq);\n")

(def create-sync-state
  "\nCREATE TABLE IF NOT EXISTS federation_peer_sync_state (\n  peer_id TEXT PRIMARY KEY REFERENCES federation_peers(id) ON DELETE CASCADE,\n  last_pulled_seq BIGINT NOT NULL DEFAULT 0,\n  last_pushed_seq BIGINT NOT NULL DEFAULT 0,\n  last_pull_at TIMESTAMPTZ,\n  last_push_at TIMESTAMPTZ,\n  last_error TEXT,\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);\n")

(def create-projected-accounts
  "\nCREATE TABLE IF NOT EXISTS federation_projected_accounts (\n  source_peer_id TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,\n  owner_subject TEXT NOT NULL,\n  provider_id TEXT NOT NULL,\n  account_id TEXT NOT NULL,\n  account_subject TEXT,\n  chatgpt_account_id TEXT,\n  email TEXT,\n  plan_type TEXT,\n  availability_state TEXT NOT NULL DEFAULT 'descriptor',\n  warm_request_count BIGINT NOT NULL DEFAULT 0,\n  last_routed_at TIMESTAMPTZ,\n  imported_at TIMESTAMPTZ,\n  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  PRIMARY KEY (source_peer_id, provider_id, account_id)\n);\n")

(def create-projected-accounts-owner-index
  "\nCREATE INDEX IF NOT EXISTS idx_federation_projected_accounts_owner ON federation_projected_accounts(owner_subject, provider_id, availability_state);\n")

(def upsert-peer-text
  "INSERT INTO federation_peers (\n           id, owner_subject, peer_did, label, base_url, control_base_url, auth_mode, auth_json, status, capabilities, updated_at\n         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, NOW())\n         ON CONFLICT (id) DO UPDATE SET\n           owner_subject = EXCLUDED.owner_subject,\n           peer_did = EXCLUDED.peer_did,\n           label = EXCLUDED.label,\n           base_url = EXCLUDED.base_url,\n           control_base_url = EXCLUDED.control_base_url,\n           auth_mode = EXCLUDED.auth_mode,\n           auth_json = EXCLUDED.auth_json,\n           status = EXCLUDED.status,\n           capabilities = EXCLUDED.capabilities,\n           updated_at = NOW()\n         RETURNING *")

(def insert-diff-event-text
  "INSERT INTO federation_diff_events (owner_subject, entity_type, entity_key, op, payload)\n       VALUES ($1, $2, $3, $4, $5::jsonb)\n       RETURNING *")

(def list-diff-events-text
  "SELECT * FROM federation_diff_events\n       WHERE owner_subject = $1 AND seq > $2\n       ORDER BY seq ASC\n       LIMIT $3")

(def upsert-projected-account-strings
  ["\n      INSERT INTO federation_projected_accounts (\n        source_peer_id, owner_subject, provider_id, account_id, account_subject, chatgpt_account_id, email, plan_type, availability_state, metadata, updated_at\n      ) VALUES (\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        "
   ",\n        NOW()\n      )\n      ON CONFLICT (source_peer_id, provider_id, account_id) DO UPDATE SET\n        owner_subject = EXCLUDED.owner_subject,\n        account_subject = EXCLUDED.account_subject,\n        chatgpt_account_id = EXCLUDED.chatgpt_account_id,\n        email = EXCLUDED.email,\n        plan_type = EXCLUDED.plan_type,\n        availability_state = EXCLUDED.availability_state,\n        metadata = EXCLUDED.metadata,\n        updated_at = NOW()\n      RETURNING *\n    "])

(def get-projected-account-text
  "SELECT * FROM federation_projected_accounts\n       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3\n       LIMIT 1")

(def note-routed-text
  "UPDATE federation_projected_accounts\n       SET warm_request_count = warm_request_count + 1,\n           last_routed_at = NOW(),\n           availability_state = CASE\n             WHEN availability_state = 'imported' THEN availability_state\n             ELSE 'remote_route'\n           END,\n           updated_at = NOW()\n       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3\n       RETURNING *")

(def mark-imported-text
  "UPDATE federation_projected_accounts\n       SET availability_state = 'imported',\n           imported_at = COALESCE(imported_at, NOW()),\n           updated_at = NOW()\n       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3\n       RETURNING *")

(def projected-for-owner-text
  "SELECT * FROM federation_projected_accounts\n       WHERE owner_subject = $1\n       ORDER BY provider_id, account_id")

(def list-projected-owner-text
  "SELECT * FROM federation_projected_accounts\n           WHERE owner_subject = $1\n           ORDER BY owner_subject, provider_id, account_id")

(def list-projected-all-text
  "SELECT * FROM federation_projected_accounts\n           ORDER BY owner_subject, provider_id, account_id")

(def get-sync-state-text
  "SELECT * FROM federation_peer_sync_state WHERE peer_id = $1 LIMIT 1")

(def upsert-sync-state-text
  "INSERT INTO federation_peer_sync_state (\n         peer_id, last_pulled_seq, last_pushed_seq, last_pull_at, last_push_at, last_error, updated_at\n       ) VALUES (\n         $1,\n         COALESCE($2, 0),\n         COALESCE($3, 0),\n         CASE WHEN $4 THEN NOW() ELSE NULL END,\n         CASE WHEN $5 THEN NOW() ELSE NULL END,\n         CASE WHEN $7 THEN $6 ELSE NULL END,\n         NOW()\n       )\n       ON CONFLICT (peer_id) DO UPDATE SET\n         last_pulled_seq = COALESCE($2, federation_peer_sync_state.last_pulled_seq),\n         last_pushed_seq = COALESCE($3, federation_peer_sync_state.last_pushed_seq),\n         last_pull_at = CASE WHEN $4 THEN NOW() ELSE federation_peer_sync_state.last_pull_at END,\n         last_push_at = CASE WHEN $5 THEN NOW() ELSE federation_peer_sync_state.last_push_at END,\n         last_error = CASE WHEN $7 THEN $6 ELSE federation_peer_sync_state.last_error END,\n         updated_at = NOW()\n       RETURNING *")

(def ddl
  "Statements `init` issues, in order."
  [create-peers create-peers-owner-index create-diff-events create-diff-events-owner-seq-index
   create-sync-state create-projected-accounts create-projected-accounts-owner-index])

(def list-peers-for-owner-text "SELECT * FROM federation_peers WHERE owner_subject = $1 ORDER BY label, id")
(def list-peers-text "SELECT * FROM federation_peers ORDER BY owner_subject, label, id")
(def get-peer-text "SELECT * FROM federation_peers WHERE id = $1 LIMIT 1")
(def advisory-lock-text "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked")

;; ---------------------------------------------------------------------------
;; Decisions
;; ---------------------------------------------------------------------------

(defn- fail [message type] (throw (ex-info message {:error/type type})))

(defn- first-some [& xs] (some #(when (some? %) %) xs))

(defn- trimmed [x] (str/trim x))

(defn- blank->nil [s] (when (seq s) s))

(defn peer-id
  "The requested peer id (trimmed), or nil when a fresh one is to be generated."
  [input]
  (blank->nil (some-> (get input "id") trimmed)))

(defn peer-upsert-params
  "Parameters of UPSERT peer for `input`, `credential` ({:value :owner-subject :kind}),
  the final `id` and the `existing` record (nil for a new peer): fields the input
  leaves out keep their existing value."
  [input credential id existing write-json normalize-url]
  (let [label (trimmed (get input "label"))
        _ (when (empty? label) (fail "federation peer label must not be empty" :federation/empty-label))
        base-url (normalize-url (get input "baseUrl"))
        control (if (contains? input "controlBaseUrl")
                  (let [v (get input "controlBaseUrl")] (if (seq v) (normalize-url v) nil))
                  (first-some (get existing "controlBaseUrl")))
        status (if (contains? input "status")
                 (or (blank->nil (trimmed (get input "status"))) "active")
                 (first-some (get existing "status") "active"))
        auth (first-some (get input "auth") (get existing "auth") {"credential" (:value credential)})
        capabilities (first-some (get input "capabilities") (get existing "capabilities") {})]
    [id (:owner-subject credential) (blank->nil (some-> (get input "peerDid") trimmed str/lower-case)) label
     base-url control (:kind credential) (write-json auth) status (write-json capabilities)]))

(defn list-peers-statement
  "{\"text\" \"values\"} for the peers of `owner-subject` (truthy) or all of them."
  [owner-subject]
  (if (seq owner-subject)
    {"text" list-peers-for-owner-text "values" [owner-subject]}
    {"text" list-peers-text "values" []}))

(defn diff-event-params
  "Parameters of the diff-event INSERT; every identifying field must be non-blank."
  [input write-json]
  (let [owner (trimmed (get input "ownerSubject"))
        entity-type (trimmed (get input "entityType"))
        entity-key (trimmed (get input "entityKey"))
        op (trimmed (get input "op"))]
    (when (or (empty? owner) (empty? entity-type) (empty? entity-key) (empty? op))
      (fail "diff event owner/entity/op fields must not be empty" :federation/empty-diff-field))
    [owner entity-type entity-key op (write-json (first-some (get input "payload") {}))]))

(defn list-diff-events-params
  "[owner after-seq limit]: `afterSeq` is a non-negative integer (default 0), the
  limit is a page size in 1..500 (default 200)."
  [input]
  (let [owner (trimmed (get input "ownerSubject"))
        _ (when (empty? owner) (fail "owner subject must not be empty" :federation/empty-owner))
        after (get input "afterSeq")
        after-seq (if (flow/finite-number? after) (max 0 (Math/floor after)) 0)]
    [owner after-seq (fed/sanitize-limit (get input "limit") 200)]))

(defn projected-account-key
  "[source-peer-id provider-id account-id], normalized as the table stores them."
  [input]
  [(trimmed (get input "sourcePeerId")) (str/lower-case (trimmed (get input "providerId")))
   (trimmed (get input "accountId"))])

(defn import-lock-key [input]
  (str/join "|" (projected-account-key input)))

(defn projected-account-upsert-values
  "Hole values of the projected-account upsert. Fields the input leaves out
  (`undefined`) keep the `existing` record's value; present-but-blank means null."
  [input existing wrap-json]
  (let [merged (fn [k existing-key normalize]
                 (if (contains? input k)
                   (blank->nil (normalize (get input k)))
                   (first-some (get existing existing-key))))]
    [(trimmed (get input "sourcePeerId")) (trimmed (get input "ownerSubject"))
     (str/lower-case (trimmed (get input "providerId"))) (trimmed (get input "accountId"))
     (merged "accountSubject" "accountSubject" trimmed)
     (merged "chatgptAccountId" "chatgptAccountId" trimmed)
     (merged "email" "email" (comp str/lower-case trimmed))
     (merged "planType" "planType" (comp str/lower-case trimmed))
     (first-some (get input "availabilityState") (get existing "availabilityState") "descriptor")
     (wrap-json (first-some (get input "metadata") (get existing "metadata") {}))]))

(defn projected-accounts-statement
  "{\"text\" \"values\"} listing projected accounts for a non-blank `owner-subject`, else all."
  [owner-subject]
  (if (and (some? owner-subject) (seq (trimmed owner-subject)))
    {"text" list-projected-owner-text "values" [(trimmed owner-subject)]}
    {"text" list-projected-all-text "values" []}))

(defn sync-state-params
  "Parameters of the sync-state upsert: sequence numbers and the error are only
  written when given; the two timestamps only when the flag is exactly `true`."
  [input]
  [(trimmed (get input "peerId"))
   (first-some (get input "lastPulledSeq")) (first-some (get input "lastPushedSeq"))
   (true? (get input "lastPullAt")) (true? (get input "lastPushAt"))
   (first-some (get input "lastError")) (contains? input "lastError")])
