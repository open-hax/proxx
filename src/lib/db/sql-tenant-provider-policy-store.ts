import type { Sql } from "./index.js";
import {
  CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX,
  CREATE_TENANT_PROVIDER_POLICIES_TABLE,
  SELECT_TENANT_PROVIDER_POLICIES,
  SELECT_TENANT_PROVIDER_POLICY,
  UPSERT_TENANT_PROVIDER_POLICY,
} from "./schema.js";
import {
  normalizeTenantProviderPolicyInput,
  type TenantProviderKind,
  type TenantProviderPolicyRecord,
  type TenantProviderPolicyUpsertInput,
  type TenantProviderShareMode,
  type TenantProviderTrustTier,
} from "../tenant-provider-policy.js";

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
