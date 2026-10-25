import type { Sql } from "./index.js";
import { kernels } from "../cljs-kernels.js";
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

export function normalizeTenantProviderKind(value: string | undefined): TenantProviderKind {
  return kernels.tenantPolicyKind(value) as TenantProviderKind;
}

export function normalizeTenantProviderShareMode(value: string | undefined): TenantProviderShareMode {
  return kernels.tenantPolicyShareMode(value) as TenantProviderShareMode;
}

export function normalizeTenantProviderTrustTier(value: string | undefined): TenantProviderTrustTier {
  return kernels.tenantPolicyTrustTier(value) as TenantProviderTrustTier;
}

function normalizeTenantProviderPolicyInput(input: TenantProviderPolicyUpsertInput): Omit<TenantProviderPolicyRecord, "createdAt" | "updatedAt"> {
  return kernels.tenantPolicyNormalizeInput(input) as unknown as Omit<TenantProviderPolicyRecord, "createdAt" | "updatedAt">;
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

function toPolicyRecord(row: TenantProviderPolicyRow): TenantProviderPolicyRecord {
  return kernels.tenantPolicyRecord(row) as unknown as TenantProviderPolicyRecord;
}

export class SqlTenantProviderPolicyStore {
  public constructor(private readonly sql: Sql) {}

  public async init(): Promise<void> {
    await this.sql.unsafe(CREATE_TENANT_PROVIDER_POLICIES_TABLE);
    await this.sql.unsafe(CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX);
  }

  public async upsertPolicy(input: TenantProviderPolicyUpsertInput): Promise<TenantProviderPolicyRecord> {
    const normalized = normalizeTenantProviderPolicyInput(input);
    const params = kernels.tenantPolicyUpsertParams(normalized);
    params[6] = JSON.stringify(normalized.allowedModels);
    const rows = await this.sql.unsafe<TenantProviderPolicyRow[]>(UPSERT_TENANT_PROVIDER_POLICY, params as never[]);

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
    const { clauses, values } = kernels.tenantPolicyListFilters(filters);

    const query = clauses.length > 0
      ? `${SELECT_TENANT_PROVIDER_POLICIES.replace(/;$/, "")} WHERE ${clauses.join(" AND ")} ORDER BY owner_subject, subject_did, provider_id`
      : SELECT_TENANT_PROVIDER_POLICIES;

    const rows = await this.sql.unsafe<TenantProviderPolicyRow[]>(query, values);
    return rows.map(toPolicyRecord);
  }
}
