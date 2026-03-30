export const TENANT_PROVIDER_KINDS = ["local_upstream", "peer_proxx"] as const;
export type TenantProviderKind = typeof TENANT_PROVIDER_KINDS[number];

export const TENANT_PROVIDER_SHARE_MODES = [
  "deny",
  "descriptor_only",
  "relay_only",
  "warm_import",
  "project_credentials",
] as const;
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

function normalizeEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
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

export function normalizeTenantProviderSubjectDid(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("tenant provider subject DID must not be empty");
  }
  return normalized;
}

export function normalizeTenantProviderId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("tenant provider providerId must not be empty");
  }
  return normalized;
}

export function normalizeTenantProviderOwnerSubject(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("tenant provider ownerSubject must not be empty");
  }
  return normalized;
}

export function normalizeAllowedModels(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )];
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

export function shareModeAllowsRelay(mode: TenantProviderShareMode): boolean {
  return mode === "relay_only" || mode === "warm_import" || mode === "project_credentials";
}

export function shareModeAllowsWarmImport(mode: TenantProviderShareMode): boolean {
  return mode === "warm_import" || mode === "project_credentials";
}

export function shareModeAllowsCredentialProjection(mode: TenantProviderShareMode): boolean {
  return mode === "project_credentials";
}

export function tenantProviderPolicyAllowsUse(
  policy: TenantProviderPolicyRecord | undefined,
  input: {
    readonly ownerSubject: string;
    readonly providerKind: TenantProviderKind;
    readonly requestedModel?: string;
    readonly requiredShareMode?: "relay" | "warm_import" | "project_credentials";
  },
): boolean {
  if (!policy) {
    return false;
  }

  if (policy.ownerSubject !== input.ownerSubject) {
    return false;
  }

  if (policy.providerKind !== input.providerKind) {
    return false;
  }

  const requestedModel = typeof input.requestedModel === "string" ? input.requestedModel.trim() : "";
  if (requestedModel.length > 0 && policy.allowedModels.length > 0 && !policy.allowedModels.includes(requestedModel)) {
    return false;
  }

  switch (input.requiredShareMode) {
    case "project_credentials":
      return shareModeAllowsCredentialProjection(policy.shareMode);
    case "warm_import":
      return shareModeAllowsWarmImport(policy.shareMode);
    case "relay":
    default:
      return shareModeAllowsRelay(policy.shareMode);
  }
}

export function normalizeTenantProviderPolicyInput(input: TenantProviderPolicyUpsertInput): Omit<TenantProviderPolicyRecord, "createdAt" | "updatedAt"> {
  const shareMode = normalizeTenantProviderShareMode(input.shareMode);
  const encryptedChannelRequired = input.encryptedChannelRequired ?? shareMode === "project_credentials";

  return {
    subjectDid: normalizeTenantProviderSubjectDid(input.subjectDid),
    providerId: normalizeTenantProviderId(input.providerId),
    providerKind: normalizeTenantProviderKind(input.providerKind),
    ownerSubject: normalizeTenantProviderOwnerSubject(input.ownerSubject),
    shareMode,
    trustTier: normalizeTenantProviderTrustTier(input.trustTier),
    allowedModels: normalizeAllowedModels(input.allowedModels),
    maxRequestsPerMinute: normalizeOptionalPositiveInteger(input.maxRequestsPerMinute, "maxRequestsPerMinute"),
    maxConcurrentRequests: normalizeOptionalPositiveInteger(input.maxConcurrentRequests, "maxConcurrentRequests"),
    encryptedChannelRequired,
    warmImportThreshold: normalizeOptionalPositiveInteger(input.warmImportThreshold, "warmImportThreshold"),
    notes: typeof input.notes === "string" && input.notes.trim().length > 0 ? input.notes.trim() : undefined,
  };
}
