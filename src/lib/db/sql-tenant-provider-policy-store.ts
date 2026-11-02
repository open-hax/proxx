import type { Sql } from "./index.js";
import { kernels } from "../cljs-kernels.js";
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

/**
 * Tenant provider policies in Postgres. Normalization, statement parameters and
 * the listing query are proxx.credentials.tenant-policy; the statements run in
 * proxx.runtime.tenant-policy-store. This class keeps the names and types
 * callers already use.
 */
export class SqlTenantProviderPolicyStore {
  private readonly impl: SqlTenantProviderPolicyStoreKernel;

  public constructor(sql: Sql) {
    this.impl = kernels.createSqlTenantProviderPolicyStore(sql) as SqlTenantProviderPolicyStoreKernel;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public upsertPolicy(input: TenantProviderPolicyUpsertInput): Promise<TenantProviderPolicyRecord> {
    return this.impl.upsertPolicy(input);
  }

  public getPolicy(subjectDid: string, providerId: string): Promise<TenantProviderPolicyRecord | undefined> {
    return this.impl.getPolicy(subjectDid, providerId);
  }

  public listPolicies(filters: {
    readonly subjectDid?: string;
    readonly ownerSubject?: string;
  } = {}): Promise<TenantProviderPolicyRecord[]> {
    return this.impl.listPolicies(filters);
  }
}

interface SqlTenantProviderPolicyStoreKernel {
  init(): Promise<void>;
  upsertPolicy(input: TenantProviderPolicyUpsertInput): Promise<TenantProviderPolicyRecord>;
  getPolicy(subjectDid: string, providerId: string): Promise<TenantProviderPolicyRecord | undefined>;
  listPolicies(filters: { readonly subjectDid?: string; readonly ownerSubject?: string }): Promise<TenantProviderPolicyRecord[]>;
}
