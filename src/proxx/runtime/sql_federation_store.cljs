(ns proxx.runtime.sql-federation-store
  "The Postgres federation store: peers, the diff-event log, projected accounts
  and peer sync state (formerly SqlFederationStore). Record mapping, limits and
  conflict detection are proxx.credentials.federation (via proxx.runtime.sql);
  the statements below are persisted contracts kept byte-for-byte."
  (:require ["node:crypto" :as crypto]
            [proxx.jsval :as j]
            [proxx.runtime.federation :as federation]
            [proxx.runtime.sql :as rows]
            [proxx.runtime.sql-tag :as tag]))

(def ^:private ddl-peers
  "
CREATE TABLE IF NOT EXISTS federation_peers (
  id TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  peer_did TEXT,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  control_base_url TEXT,
  auth_mode TEXT NOT NULL,
  auth_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (base_url)
);
")

(def ^:private ddl-peers-owner
  "
CREATE INDEX IF NOT EXISTS idx_federation_peers_owner_subject ON federation_peers(owner_subject);
")

(def ^:private ddl-diff
  "
CREATE TABLE IF NOT EXISTS federation_diff_events (
  seq BIGSERIAL PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
")

(def ^:private ddl-diff-owner
  "
CREATE INDEX IF NOT EXISTS idx_federation_diff_events_owner_seq ON federation_diff_events(owner_subject, seq);
")

(def ^:private ddl-sync
  "
CREATE TABLE IF NOT EXISTS federation_peer_sync_state (
  peer_id TEXT PRIMARY KEY REFERENCES federation_peers(id) ON DELETE CASCADE,
  last_pulled_seq BIGINT NOT NULL DEFAULT 0,
  last_pushed_seq BIGINT NOT NULL DEFAULT 0,
  last_pull_at TIMESTAMPTZ,
  last_push_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
")

(def ^:private ddl-projected
  "
CREATE TABLE IF NOT EXISTS federation_projected_accounts (
  source_peer_id TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_subject TEXT,
  chatgpt_account_id TEXT,
  email TEXT,
  plan_type TEXT,
  availability_state TEXT NOT NULL DEFAULT 'descriptor',
  warm_request_count BIGINT NOT NULL DEFAULT 0,
  last_routed_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_peer_id, provider_id, account_id)
);
")

(def ^:private ddl-projected-owner
  "
CREATE INDEX IF NOT EXISTS idx_federation_projected_accounts_owner ON federation_projected_accounts(owner_subject, provider_id, availability_state);
")

(def ^:private q-upsert-peer
  "INSERT INTO federation_peers (
           id, owner_subject, peer_did, label, base_url, control_base_url, auth_mode, auth_json, status, capabilities, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET
           owner_subject = EXCLUDED.owner_subject,
           peer_did = EXCLUDED.peer_did,
           label = EXCLUDED.label,
           base_url = EXCLUDED.base_url,
           control_base_url = EXCLUDED.control_base_url,
           auth_mode = EXCLUDED.auth_mode,
           auth_json = EXCLUDED.auth_json,
           status = EXCLUDED.status,
           capabilities = EXCLUDED.capabilities,
           updated_at = NOW()
         RETURNING *")

(def ^:private q-append-diff
  "INSERT INTO federation_diff_events (owner_subject, entity_type, entity_key, op, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *")

(def ^:private q-list-diff
  "SELECT * FROM federation_diff_events
       WHERE owner_subject = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3")

(def ^:private q-get-projected
  "SELECT * FROM federation_projected_accounts
       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3
       LIMIT 1")

(def ^:private q-note-routed
  "UPDATE federation_projected_accounts
       SET warm_request_count = warm_request_count + 1,
           last_routed_at = NOW(),
           availability_state = CASE
             WHEN availability_state = 'imported' THEN availability_state
             ELSE 'remote_route'
           END,
           updated_at = NOW()
       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3
       RETURNING *")

(def ^:private q-mark-imported
  "UPDATE federation_projected_accounts
       SET availability_state = 'imported',
           imported_at = COALESCE(imported_at, NOW()),
           updated_at = NOW()
       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3
       RETURNING *")

(def ^:private q-projected-for-owner
  "SELECT * FROM federation_projected_accounts
       WHERE owner_subject = $1
       ORDER BY provider_id, account_id")

(def ^:private q-list-projected-owner
  "SELECT * FROM federation_projected_accounts
           WHERE owner_subject = $1
           ORDER BY owner_subject, provider_id, account_id")

(def ^:private q-list-projected-all
  "SELECT * FROM federation_projected_accounts
           ORDER BY owner_subject, provider_id, account_id")

(def ^:private q-get-sync
  "SELECT * FROM federation_peer_sync_state WHERE peer_id = $1 LIMIT 1")

(def ^:private q-upsert-sync
  "INSERT INTO federation_peer_sync_state (
         peer_id, last_pulled_seq, last_pushed_seq, last_pull_at, last_push_at, last_error, updated_at
       ) VALUES (
         $1,
         COALESCE($2, 0),
         COALESCE($3, 0),
         CASE WHEN $4 THEN NOW() ELSE NULL END,
         CASE WHEN $5 THEN NOW() ELSE NULL END,
         CASE WHEN $7 THEN $6 ELSE NULL END,
         NOW()
       )
       ON CONFLICT (peer_id) DO UPDATE SET
         last_pulled_seq = COALESCE($2, federation_peer_sync_state.last_pulled_seq),
         last_pushed_seq = COALESCE($3, federation_peer_sync_state.last_pushed_seq),
         last_pull_at = CASE WHEN $4 THEN NOW() ELSE federation_peer_sync_state.last_pull_at END,
         last_push_at = CASE WHEN $5 THEN NOW() ELSE federation_peer_sync_state.last_push_at END,
         last_error = CASE WHEN $7 THEN $6 ELSE federation_peer_sync_state.last_error END,
         updated_at = NOW()
       RETURNING *")

(def ^:private q-upsert-projected
  ["
      INSERT INTO federation_projected_accounts (
        source_peer_id, owner_subject, provider_id, account_id, account_subject, chatgpt_account_id, email, plan_type, availability_state, metadata, updated_at
      ) VALUES (
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        "
   ",
        NOW()
      )
      ON CONFLICT (source_peer_id, provider_id, account_id) DO UPDATE SET
        owner_subject = EXCLUDED.owner_subject,
        account_subject = EXCLUDED.account_subject,
        chatgpt_account_id = EXCLUDED.chatgpt_account_id,
        email = EXCLUDED.email,
        plan_type = EXCLUDED.plan_type,
        availability_state = EXCLUDED.availability_state,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    "])


(defn- or* [a b] (if (j/truthy? a) a b))
(defn- ?? [a b] (if (nil? a) b a))
(defn- first-row [rs] (aget rs 0))
(defn- undef-or [row f] (if row (f row) js/undefined))

(defn- normalize-url [value]
  (let [url (js/URL. (rows/federation-peer-base-url-input-js value))]
    (.replace (.toString url) (js/RegExp. "/+$") "")))

(defn- trim-lower [s] (.toLowerCase (.trim s)))

(defn create-sql-federation-store-js
  "A store over the postgres.js handle `sql`."
  [^js sql]
  (let [exec (fn [executor text params] (.unsafe ^js executor text params))
        get-peer (fn ^:async get-peer [id executor]
                   (let [rs (await (exec (or executor sql) "SELECT * FROM federation_peers WHERE id = $1 LIMIT 1" #js [(.trim id)]))]
                     (undef-or (first-row rs) rows/federation-peer-record-js)))
        key-params (fn [^js input] #js [(.trim (.-sourcePeerId input)) (trim-lower (.-providerId input)) (.trim (.-accountId input))])
        get-projected (fn ^:async get-projected [input executor]
                        (let [rs (await (exec (or executor sql) q-get-projected (key-params input)))]
                          (undef-or (first-row rs) rows/federation-projected-account-record-js)))]
    #js {:init (fn ^:async init []
                 (doseq [ddl [ddl-peers ddl-peers-owner ddl-diff ddl-diff-owner ddl-sync ddl-projected ddl-projected-owner]]
                   (await (.unsafe sql ddl)))
                 js/undefined)
         :upsertPeer
         (fn ^:async upsert-peer [^js input]
           (let [credential (federation/parse-federation-owner-credential-js (.-ownerCredential input))
                 _ (when-not credential (throw (js/Error. "owner credential must not be empty")))
                 raw-id (some-> (.-id input) .trim)
                 id (or* raw-id (.randomUUID crypto))
                 existing (if (j/truthy? raw-id) (await (get-peer id nil)) js/undefined)
                 ^js existing (when-not (undefined? existing) existing)
                 peer-did (let [v (some-> (.-peerDid input) trim-lower)] (if (j/truthy? v) v nil))
                 label (.trim (.-label input))
                 _ (when (zero? (.-length label)) (throw (js/Error. "federation peer label must not be empty")))
                 base-url (normalize-url (.-baseUrl input))
                 control (.-controlBaseUrl input)
                 control-base-url (if-not (undefined? control)
                                    (if (j/truthy? control) (normalize-url control) nil)
                                    (?? (when existing (.-controlBaseUrl existing)) nil))
                 status* (.-status input)
                 status (if-not (undefined? status*)
                          (or* (.trim status*) "active")
                          (?? (when existing (.-status existing)) "active"))
                 auth (?? (.-auth input) (?? (when existing (.-auth existing)) #js {"credential" (.-value ^js credential)}))
                 capabilities (?? (.-capabilities input) (?? (when existing (.-capabilities existing)) #js {}))
                 rs (try
                      (await (.unsafe sql q-upsert-peer
                                      #js [id (.-ownerSubject ^js credential) peer-did label base-url control-base-url
                                           (.-kind ^js credential) (js/JSON.stringify auth) status (js/JSON.stringify capabilities)]))
                      (catch :default error
                        (if (rows/federation-base-url-conflict-js error)
                          (throw (js/Error. (str "federation peer base_url already in use: " base-url)))
                          (throw error))))]
             (rows/federation-peer-record-js (aget rs 0))))
         :listPeers
         (fn ^:async list-peers [owner-subject]
           (let [rs (if (j/truthy? owner-subject)
                      (await (.unsafe sql "SELECT * FROM federation_peers WHERE owner_subject = $1 ORDER BY label, id" #js [owner-subject]))
                      (await (.unsafe sql "SELECT * FROM federation_peers ORDER BY owner_subject, label, id" #js [])))]
             (.map rs (fn [row] (rows/federation-peer-record-js row)))))
         :getPeer get-peer
         :appendDiffEvent
         (fn ^:async append-diff-event [^js input]
           (let [owner (.trim (.-ownerSubject input)) entity-type (.trim (.-entityType input))
                 entity-key (.trim (.-entityKey input)) op (.trim (.-op input))]
             (when-not (and (j/truthy? owner) (j/truthy? entity-type) (j/truthy? entity-key) (j/truthy? op))
               (throw (js/Error. "diff event owner/entity/op fields must not be empty")))
             (let [rs (await (.unsafe sql q-append-diff #js [owner entity-type entity-key op (js/JSON.stringify (?? (.-payload input) #js {}))]))]
               (rows/federation-diff-event-record-js (aget rs 0)))))
         :listDiffEvents
         (fn ^:async list-diff-events [^js input]
           (let [owner (.trim (.-ownerSubject input))
                 _ (when-not (j/truthy? owner) (throw (js/Error. "owner subject must not be empty")))
                 after (.-afterSeq input)
                 after-seq (if (and (number? after) (js/Number.isFinite after)) (js/Math.max 0 (js/Math.floor after)) 0)
                 limit (rows/federation-sanitize-limit-js (.-limit input) 200)
                 rs (await (.unsafe sql q-list-diff #js [owner after-seq limit]))]
             (.map rs (fn [row] (rows/federation-diff-event-record-js row)))))
         :upsertProjectedAccount
         (fn ^:async upsert-projected [^js input]
           (let [existing (await (get-projected #js {"sourcePeerId" (.-sourcePeerId input) "providerId" (.-providerId input)
                                                     "accountId" (.-accountId input)} nil))
                 ^js existing (when-not (undefined? existing) existing)
                 metadata (?? (.-metadata input) (?? (when existing (.-metadata existing)) #js {}))
                 field (fn [v existing-v f]
                         (if-not (undefined? v) (let [t (f v)] (if (j/truthy? t) t nil)) (?? existing-v nil)))
                 rs (await (tag/exec sql q-upsert-projected
                                     (.trim (.-sourcePeerId input)) (.trim (.-ownerSubject input))
                                     (trim-lower (.-providerId input)) (.trim (.-accountId input))
                                     (field (.-accountSubject input) (when existing (.-accountSubject existing)) #(.trim %))
                                     (field (.-chatgptAccountId input) (when existing (.-chatgptAccountId existing)) #(.trim %))
                                     (field (.-email input) (when existing (.-email existing)) trim-lower)
                                     (field (.-planType input) (when existing (.-planType existing)) trim-lower)
                                     (?? (.-availabilityState input) (?? (when existing (.-availabilityState existing)) "descriptor"))
                                     (.json sql metadata)))]
             (rows/federation-projected-account-record-js (aget rs 0))))
         :getProjectedAccount get-projected
         :withProjectedAccountImportLock
         (fn ^:async with-lock [^js input f]
           (let [lock-key (str (.trim (.-sourcePeerId input)) "|" (trim-lower (.-providerId input)) "|" (.trim (.-accountId input)))]
             (await (.begin sql (fn ^:async tx-body [^js tx]
                                  (let [rs (await (.unsafe tx "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked" #js [lock-key]))
                                        row (aget rs 0)]
                                    (if-not (and row (.-locked ^js row))
                                      js/undefined
                                      (await (f tx)))))))))
         :noteProjectedAccountRouted
         (fn ^:async note-routed [input]
           (undef-or (first-row (await (.unsafe sql q-note-routed (key-params input))))
                     rows/federation-projected-account-record-js))
         :markProjectedAccountImported
         (fn ^:async mark-imported [input executor]
           (undef-or (first-row (await (exec (or executor sql) q-mark-imported (key-params input))))
                     rows/federation-projected-account-record-js))
         :getProjectedAccountsForOwner
         (fn ^:async for-owner [owner-subject]
           (let [rs (await (.unsafe sql q-projected-for-owner #js [(.trim owner-subject)]))]
             (.map rs (fn [row] (rows/federation-projected-account-record-js row)))))
         :listProjectedAccounts
         (fn ^:async list-projected [owner-subject]
           (let [rs (if (and (j/truthy? owner-subject) (pos? (.-length (.trim owner-subject))))
                      (await (.unsafe sql q-list-projected-owner #js [(.trim owner-subject)]))
                      (await (.unsafe sql q-list-projected-all #js [])))]
             (.map rs (fn [row] (rows/federation-projected-account-record-js row)))))
         :getSyncState
         (fn ^:async get-sync-state [peer-id]
           (undef-or (first-row (await (.unsafe sql q-get-sync #js [(.trim peer-id)])))
                     rows/federation-sync-state-record-js))
         :upsertSyncState
         (fn ^:async upsert-sync-state [^js input]
           (let [rs (await (.unsafe sql q-upsert-sync
                                    #js [(.trim (.-peerId input)) (?? (.-lastPulledSeq input) nil) (?? (.-lastPushedSeq input) nil)
                                         (true? (.-lastPullAt input)) (true? (.-lastPushAt input))
                                         (?? (.-lastError input) nil) (not (undefined? (.-lastError input)))]))]
             (rows/federation-sync-state-record-js (aget rs 0))))}))
