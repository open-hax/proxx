import type { ResolvedRequestAuth } from "../../lib/request-auth.js";
import { kernels } from "../../lib/cljs-kernels.js";

/**
 * Route authorization decisions and request-value parsers. The decisions are
 * pure CLJS predicates over the resolved identity (`proxx.http.ui-auth`).
 */
export const parseBoolean = (value: unknown): boolean => kernels.parseBoolean(value);

export const parseOptionalRequestsPerMinute = (value: unknown): number | null | undefined =>
  kernels.parseOptionalRequestsPerMinute(value);

export const parseOptionalProviderIds = (value: unknown): readonly string[] | null | undefined =>
  kernels.parseOptionalProviderIds(value);

export const parseOptionalModelIds = (value: unknown): readonly string[] | null | undefined =>
  kernels.parseOptionalModelIds(value);

export const parseOptionalPositiveInteger = (value: unknown): number | undefined =>
  kernels.parseOptionalPositiveInteger(value);

export function getResolvedAuth(request: { readonly openHaxAuth?: ResolvedRequestAuth | null }): ResolvedRequestAuth | undefined {
  const auth = request.openHaxAuth;
  return typeof auth === "object" && auth !== null ? auth : undefined;
}

export const readCookieValue = (cookieHeader: string | undefined, name: string): string | undefined =>
  kernels.readCookieToken(cookieHeader, name) ?? undefined;

export const toVisibleTenants = (
  auth: ResolvedRequestAuth,
  fallbackTenants: readonly { id: string; name: string; status: string }[] = [],
): readonly { id: string; name: string; status: string }[] => kernels.toVisibleTenants(auth, fallbackTenants);

export const authCanViewTenant = (auth: ResolvedRequestAuth | undefined, tenantId: string): boolean =>
  kernels.authCanViewTenant(auth, tenantId);

export const authCanManageTenantKeys = (auth: ResolvedRequestAuth | undefined, tenantId: string): boolean =>
  kernels.authCanManageTenantKeys(auth, tenantId);

export const authCanManageFederation = (auth: ResolvedRequestAuth | undefined): boolean =>
  kernels.authCanManageFederation(auth);
