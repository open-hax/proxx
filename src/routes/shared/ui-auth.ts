import type { ResolvedRequestAuth } from "../../lib/request-auth.js";
import { normalizeTenantId } from "../../lib/tenant-api-key.js";

export function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function parseOptionalRequestsPerMinute(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? Math.floor(value) : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0 || normalized === "null" || normalized === "none" || normalized === "off") {
      return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function parseOptionalProviderIds(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )];

  return normalized.length > 0 ? normalized : null;
}

export function parseOptionalModelIds(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )];

  return normalized.length > 0 ? normalized : null;
}

export function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? Math.floor(value) : undefined;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

export function getResolvedAuth(request: { readonly openHaxAuth?: ResolvedRequestAuth | null }): ResolvedRequestAuth | undefined {
  const auth = request.openHaxAuth;
  return typeof auth === "object" && auth !== null ? auth : undefined;
}

export function readCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) {
      continue;
    }

    const rawValue = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}

export function toVisibleTenants(
  auth: ResolvedRequestAuth,
  fallbackTenants: readonly { id: string; name: string; status: string }[] = [],
): readonly { id: string; name: string; status: string }[] {
  if (auth.kind === "legacy_admin") {
    return fallbackTenants;
  }

  return (auth.memberships ?? []).map((membership) => ({
    id: membership.tenantId,
    name: membership.tenantName ?? membership.tenantId,
    status: membership.tenantStatus ?? "active",
  }));
}

function getMembershipForTenant(auth: ResolvedRequestAuth | undefined, tenantId: string) {
  if (!auth) {
    return undefined;
  }

  const normalizedTenantId = normalizeTenantId(tenantId);
  return auth.memberships?.find((membership) => membership.tenantId === normalizedTenantId);
}

export function authCanViewTenant(auth: ResolvedRequestAuth | undefined, tenantId: string): boolean {
  if (!auth) {
    return false;
  }

  if (auth.kind === "legacy_admin") {
    return true;
  }

  return Boolean(getMembershipForTenant(auth, tenantId) ?? (auth.tenantId === normalizeTenantId(tenantId)));
}

export function authCanManageTenantKeys(auth: ResolvedRequestAuth | undefined, tenantId: string): boolean {
  if (!auth) {
    return false;
  }

  if (auth.kind === "legacy_admin") {
    return true;
  }

  const membership = getMembershipForTenant(auth, tenantId);
  return membership?.role === "owner" || membership?.role === "admin";
}

export function authCanManageFederation(auth: ResolvedRequestAuth | undefined): boolean {
  if (!auth) {
    return false;
  }

  if (auth.kind === "legacy_admin") {
    return true;
  }

  return auth.kind === "ui_session" && (auth.role === "owner" || auth.role === "admin");
}
