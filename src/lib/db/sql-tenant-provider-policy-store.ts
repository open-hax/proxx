import type { Sql } from "./index.js";
import {
  CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX,
  CREATE_TENANT_PROVIDER_POLICIES_TABLE,
  SELECT_TENANT_PROVIDER_POLICIES,
  SELECT_TENANT_PROVIDER_POLICY,
  UPSERT_TENANT_PROVIDER_POLICY,
} from "./schema.js";
export const TENANT_PROVIDER_KINDS = ["local_upstream", "peer_proxx"] as const;
export type TenantProviderKind = typeof TENANT_PROVIDER_KINDS[number];

export const TENANT_PROVIDER_SHARE_MODES = ["deny", "descriptor_only", "relay_only", "warm_import", "project_credentials"] as const;
export type TenantProviderShareMode = typeof TENANT_PROVIDER_SHARE_MODES[number];

export const TENANT_PROVIDER_TRUST_TIERS = ["owned_administered", "less_trusted"] as const;
export type TenantProviderTrustTier = typeof TENANT_PROVIDER_TRUST_TIERS[number];

export interface TenantProviderPolicyRecord {
  readonly subjectDid: string;
  readonly providerId: string;
  readonly providerKind: TenantProviderKind;
  readonly ownerSubject: string;
  readonly shareMode: TenantProviderShareMode;
  readonly trustTier: TenantProviderTrustTier;
  readonly allowedModels: readonly string[];
  readonly maxRequestsPerMinute?: number;
  readonly maxConcurrentRequests?: number;
  readonly encryptedChannelRequired: boolean;
  readonly warmImportThreshold?: number;
  readonly notes?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantProviderPolicyUpsertInput {
  readonly subjectDid: string;
  readonly providerId: string;
  readonly providerKind?: TenantProviderKind;
  readonly ownerSubject: string;
  readonly shareMode?: TenantProviderShareMode;
  readonly trustTier?: TenantProviderTrustTier;
  readonly allowedModels?: readonly string[];
  readonly maxRequestsPerMinute?: number;
  readonly maxConcurrentRequests?: number;
  readonly encryptedChannelRequired?: boolean;
  readonly warmImportThreshold?: number;
  readonly notes?: string;
}

function normalizeEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, label: string): T {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`invalid ${label}: ${value}`);
  }

  return normalized;
}

export function normalizeTenantProviderKind(value: string | undefined): TenantProviderKind {
  return normalizeEnum(value, TENANT_PROVIDER_KINDS, "local_upstream", "tenant provider kind");
}

export function normalizeTenantProviderShareMode(value: string | undefined): TenantProviderShareMode {
  return normalizeEnum(value, TENANT_PROVIDER_SHARE_MODES, "deny", "tenant provider share mode");
}

export function normalizeTenantProviderTrustTier(value: string | undefined): TenantProviderTrustTier {
  return normalizeEnum(value, TENANT_PROVIDER_TRUST_TIERS, "less_trusted", "tenant provider trust tier");
}

function normalizeAllowedModels(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function normalizeOptionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number when present`);
  }

  const normalized = Math.floor(value);
  if (normalized <= 0) {
    throw new Error(`${label} must be a positive integer when present`);
  }

  return normalized;
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeTenantProviderPolicyInput(input: TenantProviderPolicyUpsertInput): Omit<TenantProviderPolicyRecord, "createdAt" | "updatedAt"> {
  const shareMode = normalizeTenantProviderShareMode(input.shareMode);
  return {
    subjectDid: normalizeRequiredString(input.subjectDid, "tenant provider subject DID"),
    providerId: normalizeRequiredString(input.providerId, "tenant provider providerId").toLowerCase(),
    providerKind: normalizeTenantProviderKind(input.providerKind),
    ownerSubject: normalizeRequiredString(input.ownerSubject, "tenant provider ownerSubject"),
    shareMode,
    trustTier: normalizeTenantProviderTrustTier(input.trustTier),
    allowedModels: normalizeAllowedModels(input.allowedModels),
    maxRequestsPerMinute: normalizeOptionalPositiveInteger(input.maxRequestsPerMinute, "maxRequestsPerMinute"),
    maxConcurrentRequests: normalizeOptionalPositiveInteger(input.maxConcurrentRequests, "maxConcurrentRequests"),
    encryptedChannelRequired: input.encryptedChannelRequired ?? shareMode === "project_credentials",
    warmImportThreshold: normalizeOptionalPositiveInteger(input.warmImportThreshold, "warmImportThreshold"),
    notes: typeof input.notes === "string" && input.notes.trim().length > 0 ? input.notes.trim() : undefined,
  };
}

interface TenantProviderPolicyRow {
  subject_did: string;
  provider_id: string;
  provider_kind: TenantProviderKind;
  owner_subject: string;
  share_mode: TenantProviderShareMode;
  trust_tier: TenantProviderTrustTier;
  allowed_models: string[] | string | null;
  max_requests_per_minute: number | null;
  max_concurrent_requests: number | null;
  encrypted_channel_required: boolean;
  warm_import_threshold: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function parseAllowedModels(value: string[] | string | null): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }

  return [];
}

function toPolicyRecord(row: TenantProviderPolicyRow): TenantProviderPolicyRecord {
  return {
    subjectDid: row.subject_did,
    providerId: row.provider_id,
    providerKind: row.provider_kind,
    ownerSubject: row.owner_subject,
    shareMode: row.share_mode,
    trustTier: row.trust_tier,
    allowedModels: parseAllowedModels(row.allowed_models),
    maxRequestsPerMinute: row.max_requests_per_minute ?? undefined,
    maxConcurrentRequests: row.max_concurrent_requests ?? undefined,
    encryptedChannelRequired: row.encrypted_channel_required,
    warmImportThreshold: row.warm_import_threshold ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlTenantProviderPolicyStore {
  public constructor(private readonly sql: Sql) {}

  public async init(): Promise<void> {
    await this.sql.unsafe(CREATE_TENANT_PROVIDER_POLICIES_TABLE);
    await this.sql.unsafe(CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX);
  }

  public async upsertPolicy(input: TenantProviderPolicyUpsertInput): Promise<TenantProviderPolicyRecord> {
    const normalized = normalizeTenantProviderPolicyInput(input);
    const rows = await this.sql.unsafe<TenantProviderPolicyRow[]>(UPSERT_TENANT_PROVIDER_POLICY, [
      normalized.subjectDid,
      normalized.providerId,
      normalized.providerKind,
      normalized.ownerSubject,
      normalized.shareMode,
      normalized.trustTier,
      JSON.stringify(normalized.allowedModels),
      normalized.maxRequestsPerMinute ?? null,
      normalized.maxConcurrentRequests ?? null,
      normalized.encryptedChannelRequired,
      normalized.warmImportThreshold ?? null,
      normalized.notes ?? null,
    ]);

    const row = rows[0];
    if (!row) {
      throw new Error("failed to upsert tenant provider policy");
    }

    return toPolicyRecord(row);
  }

  public async getPolicy(subjectDid: string, providerId: string): Promise<TenantProviderPolicyRecord | undefined> {
    const normalized = normalizeTenantProviderPolicyInput({
      subjectDid,
      providerId,
      ownerSubject: "placeholder",
    });

    const rows = await this.sql.unsafe<TenantProviderPolicyRow[]>(SELECT_TENANT_PROVIDER_POLICY, [
      normalized.subjectDid,
      normalized.providerId,
    ]);

    return rows[0] ? toPolicyRecord(rows[0]) : undefined;
  }

  public async listPolicies(filters: {
    readonly subjectDid?: string;
    readonly ownerSubject?: string;
  } = {}): Promise<TenantProviderPolicyRecord[]> {
    const clauses: string[] = [];
    const values: string[] = [];

    if (typeof filters.subjectDid === "string" && filters.subjectDid.trim().length > 0) {
      values.push(filters.subjectDid.trim());
      clauses.push(`subject_did = $${values.length}`);
    }

    if (typeof filters.ownerSubject === "string" && filters.ownerSubject.trim().length > 0) {
      values.push(filters.ownerSubject.trim());
      clauses.push(`owner_subject = $${values.length}`);
    }

    const query = clauses.length > 0
      ? `${SELECT_TENANT_PROVIDER_POLICIES.replace(/;$/, "")} WHERE ${clauses.join(" AND ")} ORDER BY owner_subject, subject_did, provider_id`
      : SELECT_TENANT_PROVIDER_POLICIES;

    const rows = await this.sql.unsafe<TenantProviderPolicyRow[]>(query, values);
    return rows.map(toPolicyRecord);
  }
}
