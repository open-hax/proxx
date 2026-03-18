import { DEFAULT_TENANT_ID } from "./tenant-api-key.js";

export interface TenantApiKeyAuthMatch {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
}

export interface ResolvedRequestAuth {
  readonly kind: "legacy_admin" | "tenant_api_key" | "unauthenticated";
  readonly tenantId?: string;
  readonly role?: "owner" | "admin" | "member" | "viewer";
  readonly source: "bearer" | "cookie" | "none";
  readonly subject?: string;
  readonly keyId?: string;
  readonly scopes?: readonly string[];
}

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const trimmed = authorization.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }

  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : undefined;
}

export async function resolveRequestAuth(input: {
  readonly allowUnauthenticated: boolean;
  readonly proxyAuthToken?: string;
  readonly authorization?: string;
  readonly cookieToken?: string;
  readonly resolveTenantApiKey?: (token: string) => Promise<TenantApiKeyAuthMatch | undefined>;
}): Promise<ResolvedRequestAuth | undefined> {
  const bearerToken = extractBearerToken(input.authorization);
  const cookieToken = typeof input.cookieToken === "string" && input.cookieToken.trim().length > 0
    ? input.cookieToken.trim()
    : undefined;

  if (input.proxyAuthToken) {
    if (bearerToken === input.proxyAuthToken) {
      return {
        kind: "legacy_admin",
        tenantId: DEFAULT_TENANT_ID,
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }

    if (cookieToken === input.proxyAuthToken) {
      return {
        kind: "legacy_admin",
        tenantId: DEFAULT_TENANT_ID,
        role: "owner",
        source: "cookie",
        subject: "legacy:proxy-auth-token",
      };
    }
  }

  if (bearerToken && input.resolveTenantApiKey) {
    const match = await input.resolveTenantApiKey(bearerToken);
    if (match) {
      return {
        kind: "tenant_api_key",
        tenantId: match.tenantId,
        role: "member",
        source: "bearer",
        subject: `tenant_api_key:${match.id}`,
        keyId: match.id,
        scopes: match.scopes,
      };
    }
  }

  if (input.allowUnauthenticated) {
    return {
      kind: "unauthenticated",
      source: "none",
    };
  }

  return undefined;
}
