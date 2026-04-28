import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProxyConfig } from "./config.js";
import type { KeyPool, ProviderCredential } from "./key-pool.js";
import type { CredentialStore } from "./credential-store.js";
import type { RuntimeCredentialStore } from "./runtime-credential-store.js";
import type { SqlCredentialStore } from "./db/sql-credential-store.js";
import type { SqlFederationStore } from "./db/sql-federation-store.js";
import type { SqlTenantProviderPolicyStore } from "./db/sql-tenant-provider-policy-store.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import type { EventStore } from "./db/event-store.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { PromptAffinityStore } from "./prompt-affinity-store.js";
import type { ProviderRoutePheromoneStore } from "./provider-route-pheromone-store.js";
import type { ProxySettingsStore } from "./proxy-settings-store.js";
import type { PolicyEngine } from "./policy/index.js";
import type { ProviderCatalogStore } from "./provider-catalog.js";
import type { TokenRefreshManager } from "./token-refresh-manager.js";
import type { FederationBridgeRelay } from "./federation/bridge-relay.js";
import type { QuotaMonitor } from "./quota-monitor.js";
import type { ProviderRoute } from "./provider-routing.js";

export interface ExecuteFederatedRequestFallbackInput {
  readonly requestHeaders: Record<string, unknown>;
  readonly requestBody: Record<string, unknown>;
  readonly requestAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string; readonly tenantId?: string };
  readonly providerRoutes: readonly ProviderRoute[];
  readonly upstreamPath: string;
  readonly reply: FastifyReply;
  readonly timeoutMs: number;
}

export interface InjectNativeBridgeResult {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string | null;
}

export interface AppDeps {
  readonly app: FastifyInstance;
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly credentialStore: CredentialStore;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly sqlCredentialStore: SqlCredentialStore | undefined;
  readonly sqlFederationStore: SqlFederationStore | undefined;
  readonly sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;
  readonly accountHealthStore: AccountHealthStore | undefined;
  readonly eventStore: EventStore | undefined;
  readonly requestLogStore: RequestLogStore;
  readonly promptAffinityStore: PromptAffinityStore;
  readonly providerRoutePheromoneStore: ProviderRoutePheromoneStore;
  readonly proxySettingsStore: ProxySettingsStore;
  readonly policyEngine: PolicyEngine;
  readonly providerCatalogStore: ProviderCatalogStore;
  readonly tokenRefreshManager: TokenRefreshManager;
  readonly dynamicProviderBaseUrlGetter: (providerId: string) => Promise<string | undefined>;
  readonly bridgeRelay: FederationBridgeRelay | undefined;
  readonly quotaMonitor: QuotaMonitor;
  readonly refreshFactoryAccount: (credential: ProviderCredential) => Promise<ProviderCredential | null>;
  readonly ensureFreshAccounts: (providerId: string) => Promise<void>;
  readonly refreshExpiredOAuthAccount: (credential: ProviderCredential) => Promise<ProviderCredential | null>;
  readonly getMergedModelIds: (forceRefresh?: boolean) => Promise<string[]>;
  readonly executeFederatedRequestFallback: (input: ExecuteFederatedRequestFallbackInput) => Promise<boolean>;
  readonly injectNativeBridge: (url: string, payload: Record<string, unknown>, requestHeaders: Record<string, unknown>) => Promise<InjectNativeBridgeResult>;
}
