import { kernels } from "./cljs-kernels.js";
import { DEFAULT_TENANT_ID } from "./tenant-api-key.js";

export interface TenantApiKeyAuthMatch {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
}

export type RequestAuthRole = "owner" | "admin" | "member" | "viewer";

export interface RequestAuthMembership {
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly tenantStatus?: string;
  readonly role: RequestAuthRole;
}

export interface UiSessionAuthMatch {
  readonly userId: string;
  readonly subject: string;
  readonly activeTenantId: string;
  readonly role: RequestAuthRole;
  readonly memberships: readonly RequestAuthMembership[];
}

export interface ResolvedRequestAuth {
  readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated";
  readonly tenantId?: string;
  readonly role?: RequestAuthRole;
  readonly source: "bearer" | "cookie" | "none";
  readonly userId?: string;
  readonly subject?: string;
  readonly keyId?: string;
  readonly scopes?: readonly string[];
  readonly memberships?: readonly RequestAuthMembership[];
}

/**
 * Resolve who is calling. The resolution order and the decisions are CLJS
 * (`proxx.auth.request`, `proxx.runtime.auth`); lookups stay callbacks.
 */
export async function resolveRequestAuth(input: {
  readonly allowUnauthenticated: boolean;
  readonly proxyAuthToken?: string;
  readonly authorization?: string;
  readonly cookieToken?: string;
  readonly oauthAccessToken?: string;
  readonly resolveTenantApiKey?: (token: string) => Promise<TenantApiKeyAuthMatch | undefined>;
  readonly resolveUiSession?: (token: string) => Promise<UiSessionAuthMatch | undefined>;
}): Promise<ResolvedRequestAuth | undefined> {
  const resolved = await kernels.resolveRequestAuth(input, DEFAULT_TENANT_ID);
  return (resolved ?? undefined) as ResolvedRequestAuth | undefined;
}
