import type { ProxyConfig } from "../lib/config.js";
import type { CredentialStoreLike } from "../lib/credential-store.js";
import type { KeyPool } from "../lib/key-pool.js";
import type { RequestLogStore } from "../lib/request-log-store.js";
import type { ProxySettingsStore } from "../lib/proxy-settings-store.js";
import type { EventStore } from "../lib/db/event-store.js";
import type { SqlCredentialStore } from "../lib/db/sql-credential-store.js";
import type { SqlFederationStore } from "../lib/db/sql-federation-store.js";
import type { SqlTenantProviderPolicyStore } from "../lib/db/sql-tenant-provider-policy-store.js";
import type { SqlRequestUsageStore } from "../lib/db/sql-request-usage-store.js";
import type { SqlAuthPersistence } from "../lib/auth/sql-persistence.js";

/**
 * Shared dependency bag for control-plane route registration.
 *
 * Kept here so route modules are not forced to import their shared types from
 * the legacy `src/lib/ui-routes.ts` monolith during the migration to
 * canonical `/api/v1/*` control-plane routes.
 */
export interface UiRouteDependencies {
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly requestLogStore: RequestLogStore;
  readonly credentialStore: CredentialStoreLike;
  readonly sqlCredentialStore?: SqlCredentialStore;
  readonly sqlFederationStore?: SqlFederationStore;
  readonly sqlTenantProviderPolicyStore?: SqlTenantProviderPolicyStore;
  readonly sqlRequestUsageStore?: SqlRequestUsageStore;
  readonly authPersistence?: SqlAuthPersistence;
  readonly proxySettingsStore: ProxySettingsStore;
  readonly eventStore?: EventStore;
  readonly refreshOpenAiOauthAccounts?: (accountId?: string) => Promise<{
    readonly totalAccounts: number;
    readonly refreshedCount: number;
    readonly failedCount: number;
  }>;
}

export interface PrefixedRouteOptions {
  readonly prefix: string;
}

export function joinRoutePath(prefix: string, suffix: string): string {
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${normalizedPrefix}${normalizedSuffix}`;
}
