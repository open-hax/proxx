import crypto from "node:crypto";

import type { Sql } from "./index.js";
import { parseFederationOwnerCredential, type FederationOwnerCredential } from "../federation/owner-credential.js";

export type FederationPeerAuthMode = "admin_key" | "at_did";
export type FederationProjectedAccountState = "descriptor" | "remote_route" | "imported";

export interface FederationPeerRecord {
  readonly id: string;
  readonly ownerSubject: string;
  readonly peerDid?: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly controlBaseUrl?: string;
  readonly authMode: FederationPeerAuthMode;
  readonly auth: Record<string, unknown>;
  readonly status: string;
  readonly capabilities: Record<string, unknown>;
  readonly lastSeenAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FederationDiffEventRecord {
  readonly seq: number;
  readonly ownerSubject: string;
  readonly entityType: string;
  readonly entityKey: string;
  readonly op: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface FederationProjectedAccountRecord {
  readonly sourcePeerId: string;
  readonly ownerSubject: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly accountSubject?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly planType?: string;
  readonly availabilityState: FederationProjectedAccountState;
  readonly warmRequestCount: number;
  readonly lastRoutedAt?: string;
  readonly importedAt?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FederationPeerRow {
  id: string;
  owner_subject: string;
  peer_did: string | null;
  label: string;
  base_url: string;
  control_base_url: string | null;
  auth_mode: FederationPeerAuthMode;
  auth_json: string | Record<string, unknown> | null;
  status: string;
  capabilities: string | Record<string, unknown> | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FederationDiffEventRow {
  seq: string | number;
  owner_subject: string;
  entity_type: string;
  entity_key: string;
  op: string;
  payload: string | Record<string, unknown> | null;
  created_at: string;
}

interface FederationProjectedAccountRow {
  source_peer_id: string;
  owner_subject: string;
  provider_id: string;
  account_id: string;
  account_subject: string | null;
  chatgpt_account_id: string | null;
  email: string | null;
  plan_type: string | null;
  availability_state: FederationProjectedAccountState;
  warm_request_count: string | number;
  last_routed_at: string | null;
  imported_at: string | null;
  metadata: string | Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const CREATE_FEDERATION_PEERS_TABLE = `
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
`;

const CREATE_FEDERATION_PEERS_OWNER_INDEX = `
CREATE INDEX IF NOT EXISTS idx_federation_peers_owner_subject ON federation_peers(owner_subject);
`;

const CREATE_FEDERATION_DIFF_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS federation_diff_events (
  seq BIGSERIAL PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const CREATE_FEDERATION_DIFF_EVENTS_OWNER_SEQ_INDEX = `
CREATE INDEX IF NOT EXISTS idx_federation_diff_events_owner_seq ON federation_diff_events(owner_subject, seq);
`;

const CREATE_FEDERATION_SYNC_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS federation_peer_sync_state (
  peer_id TEXT PRIMARY KEY REFERENCES federation_peers(id) ON DELETE CASCADE,
  last_pulled_seq BIGINT NOT NULL DEFAULT 0,
  last_pushed_seq BIGINT NOT NULL DEFAULT 0,
  last_pull_at TIMESTAMPTZ,
  last_push_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const CREATE_FEDERATION_PROJECTED_ACCOUNTS_TABLE = `
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
`;

const CREATE_FEDERATION_PROJECTED_ACCOUNTS_OWNER_INDEX = `
CREATE INDEX IF NOT EXISTS idx_federation_projected_accounts_owner ON federation_projected_accounts(owner_subject, provider_id, availability_state);
`;

const MAX_DIFF_PAGE_SIZE = 500;
export const WARM_IMPORT_REQUEST_THRESHOLD = 3;

function parseJsonObject(raw: string | Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  return raw;
}

function normalizeUrl(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("federation peer baseUrl must not be empty");
  }

  const url = new URL(normalized);
  return url.toString().replace(/\/+$/, "");
}

function toPeerRecord(row: FederationPeerRow): FederationPeerRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    peerDid: row.peer_did ?? undefined,
    label: row.label,
    baseUrl: row.base_url,
    controlBaseUrl: row.control_base_url ?? undefined,
    authMode: row.auth_mode,
    auth: parseJsonObject(row.auth_json),
    status: row.status,
    capabilities: parseJsonObject(row.capabilities),
    lastSeenAt: row.last_seen_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDiffEventRecord(row: FederationDiffEventRow): FederationDiffEventRecord {
  return {
    seq: Number(row.seq),
    ownerSubject: row.owner_subject,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    op: row.op,
    payload: parseJsonObject(row.payload),
    createdAt: row.created_at,
  };
}

function toProjectedAccountRecord(row: FederationProjectedAccountRow): FederationProjectedAccountRecord {
  return {
    sourcePeerId: row.source_peer_id,
    ownerSubject: row.owner_subject,
    providerId: row.provider_id,
    accountId: row.account_id,
    accountSubject: row.account_subject ?? undefined,
    chatgptAccountId: row.chatgpt_account_id ?? undefined,
    email: row.email ?? undefined,
    planType: row.plan_type ?? undefined,
    availabilityState: row.availability_state,
    warmRequestCount: Number(row.warm_request_count),
    lastRoutedAt: row.last_routed_at ?? undefined,
    importedAt: row.imported_at ?? undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return fallback;
  }
  return Math.min(normalized, MAX_DIFF_PAGE_SIZE);
}

export function shouldWarmImportProjectedAccount(warmRequestCount: number, threshold = WARM_IMPORT_REQUEST_THRESHOLD): boolean {
  return Number.isFinite(warmRequestCount) && warmRequestCount >= threshold;
}

export class SqlFederationStore {
  public constructor(private readonly sql: Sql) {}

  public async init(): Promise<void> {
    await this.sql.unsafe(CREATE_FEDERATION_PEERS_TABLE);
    await this.sql.unsafe(CREATE_FEDERATION_PEERS_OWNER_INDEX);
    await this.sql.unsafe(CREATE_FEDERATION_DIFF_EVENTS_TABLE);
    await this.sql.unsafe(CREATE_FEDERATION_DIFF_EVENTS_OWNER_SEQ_INDEX);
    await this.sql.unsafe(CREATE_FEDERATION_SYNC_STATE_TABLE);
    await this.sql.unsafe(CREATE_FEDERATION_PROJECTED_ACCOUNTS_TABLE);
    await this.sql.unsafe(CREATE_FEDERATION_PROJECTED_ACCOUNTS_OWNER_INDEX);
  }

  public async upsertPeer(input: {
    readonly id?: string;
    readonly ownerCredential: string;
    readonly peerDid?: string;
    readonly label: string;
    readonly baseUrl: string;
    readonly controlBaseUrl?: string;
    readonly auth?: Record<string, unknown>;
    readonly capabilities?: Record<string, unknown>;
    readonly status?: string;
  }): Promise<FederationPeerRecord> {
    const credential = parseFederationOwnerCredential(input.ownerCredential);
    if (!credential) {
      throw new Error("owner credential must not be empty");
    }

    const id = input.id?.trim() || crypto.randomUUID();
    const peerDid = input.peerDid?.trim().toLowerCase() || null;
    const label = input.label.trim();
    if (label.length === 0) {
      throw new Error("federation peer label must not be empty");
    }

    const baseUrl = normalizeUrl(input.baseUrl);
    const controlBaseUrl = input.controlBaseUrl ? normalizeUrl(input.controlBaseUrl) : null;
    const status = input.status?.trim() || "active";
    const auth = input.auth ?? { credential: credential.value };
    const rows = await this.sql.unsafe<FederationPeerRow[]>(
      `INSERT INTO federation_peers (
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
       RETURNING *`,
      [
        id,
        credential.ownerSubject,
        peerDid,
        label,
        baseUrl,
        controlBaseUrl,
        credential.kind,
        JSON.stringify(auth),
        status,
        JSON.stringify(input.capabilities ?? {}),
      ],
    );

    return toPeerRecord(rows[0]!);
  }

  public async listPeers(ownerSubject?: string): Promise<FederationPeerRecord[]> {
    const rows = ownerSubject
      ? await this.sql.unsafe<FederationPeerRow[]>(
          "SELECT * FROM federation_peers WHERE owner_subject = $1 ORDER BY label, id",
          [ownerSubject],
        )
      : await this.sql.unsafe<FederationPeerRow[]>(
          "SELECT * FROM federation_peers ORDER BY owner_subject, label, id",
          [],
        );

    return rows.map(toPeerRecord);
  }

  public async appendDiffEvent(input: {
    readonly ownerSubject: string;
    readonly entityType: string;
    readonly entityKey: string;
    readonly op: string;
    readonly payload?: Record<string, unknown>;
  }): Promise<FederationDiffEventRecord> {
    const ownerSubject = input.ownerSubject.trim();
    const entityType = input.entityType.trim();
    const entityKey = input.entityKey.trim();
    const op = input.op.trim();
    if (!ownerSubject || !entityType || !entityKey || !op) {
      throw new Error("diff event owner/entity/op fields must not be empty");
    }

    const rows = await this.sql.unsafe<FederationDiffEventRow[]>(
      `INSERT INTO federation_diff_events (owner_subject, entity_type, entity_key, op, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [ownerSubject, entityType, entityKey, op, JSON.stringify(input.payload ?? {})],
    );
    return toDiffEventRecord(rows[0]!);
  }

  public async listDiffEvents(input: {
    readonly ownerSubject: string;
    readonly afterSeq?: number;
    readonly limit?: number;
  }): Promise<FederationDiffEventRecord[]> {
    const ownerSubject = input.ownerSubject.trim();
    if (!ownerSubject) {
      throw new Error("owner subject must not be empty");
    }

    const afterSeq = typeof input.afterSeq === "number" && Number.isFinite(input.afterSeq)
      ? Math.max(0, Math.floor(input.afterSeq))
      : 0;
    const limit = sanitizeLimit(input.limit, 200);

    const rows = await this.sql.unsafe<FederationDiffEventRow[]>(
      `SELECT * FROM federation_diff_events
       WHERE owner_subject = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [ownerSubject, afterSeq, limit],
    );

    return rows.map(toDiffEventRecord);
  }

  public async upsertProjectedAccount(input: {
    readonly sourcePeerId: string;
    readonly ownerSubject: string;
    readonly providerId: string;
    readonly accountId: string;
    readonly accountSubject?: string;
    readonly chatgptAccountId?: string;
    readonly email?: string;
    readonly planType?: string;
    readonly availabilityState?: FederationProjectedAccountState;
    readonly metadata?: Record<string, unknown>;
  }): Promise<FederationProjectedAccountRecord> {
    const rows = await this.sql.unsafe<FederationProjectedAccountRow[]>(
      `INSERT INTO federation_projected_accounts (
         source_peer_id, owner_subject, provider_id, account_id, account_subject, chatgpt_account_id, email, plan_type, availability_state, metadata, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
       ON CONFLICT (source_peer_id, provider_id, account_id) DO UPDATE SET
         owner_subject = EXCLUDED.owner_subject,
         account_subject = EXCLUDED.account_subject,
         chatgpt_account_id = EXCLUDED.chatgpt_account_id,
         email = EXCLUDED.email,
         plan_type = EXCLUDED.plan_type,
         availability_state = EXCLUDED.availability_state,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        input.sourcePeerId.trim(),
        input.ownerSubject.trim(),
        input.providerId.trim().toLowerCase(),
        input.accountId.trim(),
        input.accountSubject?.trim() || null,
        input.chatgptAccountId?.trim() || null,
        input.email?.trim().toLowerCase() || null,
        input.planType?.trim().toLowerCase() || null,
        input.availabilityState ?? "descriptor",
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return toProjectedAccountRecord(rows[0]!);
  }

  public async noteProjectedAccountRouted(input: {
    readonly sourcePeerId: string;
    readonly providerId: string;
    readonly accountId: string;
  }): Promise<FederationProjectedAccountRecord | undefined> {
    const rows = await this.sql.unsafe<FederationProjectedAccountRow[]>(
      `UPDATE federation_projected_accounts
       SET warm_request_count = warm_request_count + 1,
           last_routed_at = NOW(),
           availability_state = CASE
             WHEN availability_state = 'imported' THEN availability_state
             ELSE 'remote_route'
           END,
           updated_at = NOW()
       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3
       RETURNING *`,
      [input.sourcePeerId.trim(), input.providerId.trim().toLowerCase(), input.accountId.trim()],
    );

    return rows[0] ? toProjectedAccountRecord(rows[0]) : undefined;
  }

  public async markProjectedAccountImported(input: {
    readonly sourcePeerId: string;
    readonly providerId: string;
    readonly accountId: string;
  }): Promise<FederationProjectedAccountRecord | undefined> {
    const rows = await this.sql.unsafe<FederationProjectedAccountRow[]>(
      `UPDATE federation_projected_accounts
       SET availability_state = 'imported',
           imported_at = COALESCE(imported_at, NOW()),
           updated_at = NOW()
       WHERE source_peer_id = $1 AND provider_id = $2 AND account_id = $3
       RETURNING *`,
      [input.sourcePeerId.trim(), input.providerId.trim().toLowerCase(), input.accountId.trim()],
    );

    return rows[0] ? toProjectedAccountRecord(rows[0]) : undefined;
  }

  public async getProjectedAccountsForOwner(ownerSubject: string): Promise<FederationProjectedAccountRecord[]> {
    const rows = await this.sql.unsafe<FederationProjectedAccountRow[]>(
      `SELECT * FROM federation_projected_accounts
       WHERE owner_subject = $1
       ORDER BY provider_id, account_id`,
      [ownerSubject.trim()],
    );

    return rows.map(toProjectedAccountRecord);
  }
}
