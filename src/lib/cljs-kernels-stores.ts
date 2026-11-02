/** Analytics, auth, storage, pricing, quota, federation and routing kernels (a slice of `CljsKernels`; see cljs-kernels.ts). */
import type { ServerResponse } from "node:http";
import type { CredentialStoreLike } from "./credential-store.js";
import type { ProxyConfig } from "./config.js";
import type { Sql } from "./db/index.js";
import type { EnsureFreshAccountsDeps, FactoryRefreshDeps, OpenAiRefreshDeps, TokenRefreshDeps } from "./token-refresh-handlers.js";
import type { Logger as TokenRefreshLogger, RefreshFn, TokenRefreshManagerApi, TokenRefreshManagerConfig } from "./token-refresh-manager.js";
import type { TelemetryClient } from "./telemetry/otel.js";
import type { ProxySettingsStoreApi } from "./proxy-settings-store.js";
import type { HostDashboardRouteSummary, HostDashboardSnapshot, HostDashboardTarget } from "./host-dashboard.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import type { QuotaCooldownController, QuotaMonitorApi, QuotaMonitorConfig, QuotaMonitorLogger } from "./quota-monitor.js";
import type { OpenAiAccountProbeResult, OpenAiProbeOptions, OpenAiQuotaFetchOptions, OpenAiQuotaSnapshotResponse } from "./openai-quota.js";
import type { ModelPricing, ModelPricingIndexStatus, ModelPricingRefreshHandle, ModelPricingRefreshOptions, ModelPricingRefreshSchedulerOptions, ModelsDevPricingSnapshot, RequestCostEstimate } from "./model-pricing.js";
import type { BridgeSendChannel } from "./federation/bridge-send-channel.js";
import type { FederationBridgeAgentOptions } from "./federation/bridge-agent.js";
import type { BridgeMessage } from "./federation/bridge-protocol.js";
import type { BridgeRequestHandlerResult } from "./federation/bridge-agent.js";
import type { LightMyRequestResponse } from "fastify";
import type { BridgeLeaseAccountSummary, BridgeLeaseExportedAccount } from "../routes/federation/bridge-lease-parsers.js";
import type { FederationOwnerCredential } from "./federation/owner-credential.js";

/** Method bag returned by the CLJS OAuth manager factories (typed per manager by its TS class). */
export type OAuthManagerFacade = Record<string, (...args: never[]) => unknown>;

export interface ChromaSearchRow {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageId: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly createdAt: number;
  readonly distance: number;
}

export interface RequestLogFanout {
  readonly subscribe: (id: string, identity: object, subscription: object) => void;
  readonly unsubscribe: (id: string) => void;
  readonly recipients: (entry: object) => string[];
  readonly size: () => number;
  readonly clear: () => void;
  readonly eventType: (type: string) => string;
}

export interface CljsKernelsStores {
  // w2-analytics
  readonly createRequestLogFanout: () => RequestLogFanout;
  readonly ollamaBatchVectors: (payload: unknown, expectedCount: number) => number[][];
  readonly ollamaLegacyVector: (payload: unknown) => number[];
  readonly ollamaValidateConfig: (config: Record<string, unknown>) => void;
  readonly ollamaBuildConfig: (config: Record<string, unknown>) => { readonly url: string; readonly model: string };
  readonly chromaConnectionOptions: (url: URL) => { readonly host: string; readonly ssl: boolean; readonly port?: number };
  readonly chromaSearchResults: (
    ids: readonly unknown[],
    docs: readonly unknown[],
    metas: readonly unknown[],
    distances: readonly unknown[],
    now: number,
  ) => ChromaSearchRow[];
  readonly ollamaGenerate: (baseUrl: string, model: string, texts: readonly string[]) => Promise<number[][]>;
  readonly createChromaSessionIndex: (
    config: { readonly url: string; readonly collectionName: string },
    deps: { readonly ChromaClient: unknown; readonly IncludeEnum: unknown; readonly embeddingFunction: unknown },
  ) => {
    readonly indexMessage: (message: object) => Promise<void>;
    readonly search: (query: string, limit: number) => Promise<ChromaSearchRow[]>;
  };
  readonly eventLabelerApplies: (id: string, event: object) => boolean;
  readonly eventLabelerLabel: (id: string, event: object) => string[];
  readonly eventDdl: () => string[];
  readonly eventBuildQuery: (filters: object) => { readonly text: string; readonly values: unknown[] };
  readonly eventBuildCount: (filters: object) => { readonly text: string; readonly values: unknown[] };
  readonly eventCountByTagQuery: (since: Date | undefined) => { readonly text: string; readonly values: unknown[] };
  readonly eventParseRow: (row: object) => unknown;
  readonly eventSanitizePayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  readonly usageDdl: () => string[];
  readonly usageToEntry: (row: object) => unknown;
  readonly usageCoverage: (row: object | undefined) => {
    readonly earliestEntryAtMs: number | null;
    readonly retainedEntryCount: number;
    readonly maxRetainedEntries: number;
  };
  readonly usageUpsert: (entry: object) => { readonly strings: TemplateStringsArray; readonly values: unknown[] };
  readonly usageListQuery: (filters: object, cursor: { timestampMs: number; id: string } | undefined) => { readonly text: string; readonly values: unknown[] };
  readonly usageListSinceQuery: (
    sinceMs: number,
    filters: object,
    limit: number | undefined,
    after: { timestampMs: number; id: string } | undefined,
  ) => { readonly text: string; readonly values: unknown[] };
  readonly usageCoverageQuery: (filters: object) => { readonly text: string; readonly values: unknown[] };
  readonly usageCursorQuery: () => string;
  readonly usageToCursor: (row: object) => { readonly timestampMs: number; readonly id: string };
  readonly createRequestLogStore: (opts: object) => unknown;
  readonly createRequestLogCore: (maxEntries: number, deps?: { now?: () => number; uuid?: () => string }) => unknown;
  readonly usageToWindow: (value: unknown) => string;
  readonly usageToSafeLimit: (value: unknown, fallback: number, max: number) => number;
  readonly usageWindowConfig: (window: string, now: number) => {
    readonly bucketMs: number;
    readonly bucketCount: number;
    readonly bucketWindowStart: number;
    readonly entryWindowStart: number;
  };
  readonly usageOverviewFromEntries: (entries: object[], ctx: object) => unknown;
  readonly usageOverviewFromRollups: (input: object) => unknown;
  readonly usageAnalyticsFromEntries: (entries: object[], ctx: object) => unknown;
  readonly usageAnalyticsFromRollups: (input: object) => unknown;
  readonly usageScopeActive: (scope: object | undefined) => boolean;
  readonly usageFilterEntries: <T extends object>(entries: T[], scope: object | undefined) => T[];
  readonly usageSummarizeRouting: (entries: object[]) => unknown;
  readonly createSessionStore: (filePath: string, deps?: { now?: () => number; uuid?: () => string }) => unknown;
  // w2 auth/oauth: openai + factory oauth
  readonly createOpenAiOAuthManager: (options: unknown, deps: unknown) => OAuthManagerFacade;
  readonly resolveOpenAiCallbackPort: (raw: string | undefined) => string;
  readonly isTerminalOpenAiRefreshErrorFacts: (facts: {
    readonly status: number;
    readonly code?: string;
    readonly type?: string;
    readonly message: string;
    readonly responseBody?: string;
  }) => boolean;
  readonly createFactoryOAuthManager: (options: unknown, deps: unknown) => OAuthManagerFacade;
  readonly decryptAuthV2: (keyBase64: string, encryptedContent: string) => { readonly accessToken: string; readonly refreshToken: string };
  readonly encryptAuthV2: (keyBase64: string, data: { readonly access_token: string; readonly refresh_token: string }) => string;
  readonly loadFactoryAuthV2: () => Promise<{ readonly accessToken: string; readonly refreshToken: string } | null>;
  readonly persistFactoryAuthV2: (accessToken: string, refreshToken: string) => Promise<void>;
  readonly parseJwtExpiry: (token: string) => number | null;
  readonly factoryCredentialNeedsRefresh: (credential: unknown) => boolean;
  readonly refreshFactoryOAuthToken: (
    refreshToken: string,
    fetchFn: typeof fetch,
  ) => Promise<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number | undefined }>;
  readonly factoryRefreshBufferMs: number;
  // w2 credentials: file-backed credential store
  // w2 request auth
  readonly resolveRequestAuth: (input: unknown, defaultTenantId: string) => Promise<unknown>;
  // w2 sql credential store mapping (rows in, views/params out; SQL text stays in db/schema.ts)
  readonly normalizeAuthTypeSql: (raw: string) => "api_key" | "oauth_bearer";
  readonly sqlProviderCredential: (row: unknown, authType: string) => Record<string, unknown>;
  readonly legacyOpenAiDuplicateIds: (rows: readonly unknown[]) => string[];
  readonly sqlUserView: (row: unknown) => Record<string, unknown>;
  readonly sqlMembershipView: (row: unknown) => Record<string, unknown>;
  readonly sqlUserUpsertParams: (newUuid: () => string, input: unknown) => unknown[];
  readonly sqlResolveUiSession: (user: unknown, memberships: readonly unknown[], activeTenantId: string | undefined, defaultTenantId: string) => Record<string, unknown> | null;
  readonly sqlBootstrapRole: (existing: readonly unknown[], defaultTenantId: string, countRow: unknown) => { readonly role: string; readonly create: boolean };
  readonly sqlApiKeyScopes: (scopes: readonly unknown[]) => string[];
  readonly sqlNormalizedApiKeyLabel: (label: string) => string;
  readonly sqlTenantApiKeyView: (row: unknown) => Record<string, unknown>;
  readonly sqlTenantApiKeyMatch: (row: unknown) => Record<string, unknown>;
  readonly sqlCredentialProviderViews: (providerRows: readonly unknown[], accountRows: readonly unknown[], reveal: boolean, derive: (token: string) => unknown) => unknown[];
  readonly sqlCooldownEntries: (rows: readonly unknown[]) => Array<[string, string, number]>;
  // w2 account health
  readonly createAccountHealthStore: (sql: unknown, flushIntervalMs: number, selectAllSql: string) => unknown;
  // w2 sql federation store mapping
  readonly federationPeerRecord: (row: unknown) => Record<string, unknown>;
  readonly federationDiffEventRecord: (row: unknown) => Record<string, unknown>;
  readonly federationProjectedAccountRecord: (row: unknown) => Record<string, unknown>;
  readonly federationSyncStateRecord: (row: unknown) => Record<string, unknown>;
  readonly federationWarmImportThreshold: (raw: string | undefined) => number;
  readonly federationShouldWarmImport: (count: number, threshold: number) => boolean;
  readonly federationSanitizeLimit: (limit: number | undefined, fallback: number) => number;
  readonly federationPeerBaseUrlInput: (value: string) => string;
  readonly federationBaseUrlConflict: (error: unknown) => boolean;
  // w2 sql tenant provider policy store
  readonly tenantPolicyKind: (value: string | undefined) => string;
  readonly tenantPolicyShareMode: (value: string | undefined) => string;
  readonly tenantPolicyTrustTier: (value: string | undefined) => string;
  readonly tenantPolicyNormalizeInput: (input: unknown) => Record<string, unknown>;
  readonly tenantPolicyUpsertParams: (normalized: unknown) => unknown[];
  readonly tenantPolicyRecord: (row: unknown) => Record<string, unknown>;
  readonly tenantPolicyListFilters: (filters: unknown) => { readonly clauses: string[]; readonly values: string[] };
  // w2 github login routes
  readonly githubOAuthConstants: () => {
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly userUrl: string;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlSeconds: number;
    readonly clientId: string;
  };
  readonly createGithubPendingStore: () => {
    add(state: string, redirectUri: string, nowMs: number): void;
    take(state: string, nowMs: number): {
      readonly redirectUri?: string;
      readonly rejection?: { readonly status: number; readonly body: Record<string, unknown> };
    };
  };
  readonly githubAuthorizeQuery: (clientId: string, redirectUri: string, state: string) => string;
  readonly githubCallbackRejection: (query: Record<string, unknown>) => { readonly status: number; readonly body: Record<string, unknown> } | null;
  readonly githubRefreshPlan: (found: boolean, expiresAt: number | undefined, nowSeconds: number) => "missing" | "expired" | "rotate";
  readonly githubAdminAccountView: (credential: unknown) => Record<string, unknown>;
  readonly githubNormalizeLogin: (login: string) => string;
  readonly githubCookieValue: (header: string | undefined, name: string, decode: (value: string) => string) => string | null;
  readonly githubSetCookieHeader: (name: string, value: string, expires: string) => string;
  readonly githubClearCookieHeader: (name: string) => string;
  readonly githubBearer: (authorization: string | undefined) => string | null;
  readonly authTokenView: (row: unknown) => Record<string, unknown>;
  readonly authSessionView: (row: unknown) => Record<string, unknown>;
  readonly authClientView: (row: unknown) => Record<string, unknown>;
  readonly createPromptAffinityStore: (sql: unknown, statements: unknown) => unknown;
  readonly createCredentialStore: (filePath: string, defaultProviderId: string, deps: unknown) => unknown;
  // pricing (model-pricing)
  readonly getModelPricing: (manifestPath: string, providerId: string, model: string) => ModelPricing;
  readonly estimateRequestCost: (
    manifestPath: string,
    providerId: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
    waterMlPerKwh: number,
  ) => RequestCostEstimate;
  readonly setPolicyModelPricingOverrides: (overrides: unknown) => void;
  readonly getModelPricingIndexStatus: (manifestPath: string) => ModelPricingIndexStatus;
  readonly getModelsDevPricingSnapshot: (manifestPath: string) => ModelsDevPricingSnapshot;
  readonly refreshModelsDevPricingIndex: (manifestPath: string, options: ModelPricingRefreshOptions) => Promise<ModelPricingIndexStatus>;
  readonly startModelsDevPricingRefresh: (
    manifestPath: string,
    options: ModelPricingRefreshSchedulerOptions,
  ) => ModelPricingRefreshHandle;
  // quota (openai-quota)
  readonly fetchOpenAiQuotaSnapshots: (
    manifestPath: string,
    credentialStore: CredentialStoreLike,
    options: OpenAiQuotaFetchOptions,
  ) => Promise<OpenAiQuotaSnapshotResponse>;
  readonly probeOpenAiAccount: (
    manifestPath: string,
    credentialStore: CredentialStoreLike,
    options: OpenAiProbeOptions,
  ) => Promise<OpenAiAccountProbeResult>;
  readonly createQuotaMonitor: (
    manifestPath: string,
    credentialStore: CredentialStoreLike,
    logger: QuotaMonitorLogger,
    config: Partial<QuotaMonitorConfig>,
    healthStore: AccountHealthStore | undefined,
    cooldownController: QuotaCooldownController | undefined,
  ) => QuotaMonitorApi;
  readonly quotaMonitorDefaultConfig: () => QuotaMonitorConfig;
  // config
  readonly loadConfig: (env: NodeJS.ProcessEnv, cwd: string, manifestPath: string) => ProxyConfig;
  readonly defaultModels: (manifestPath: string) => readonly string[];
  // token refresh
  readonly tokenRefreshDefaultConfig: () => TokenRefreshManagerConfig;
  readonly createTokenRefreshManager: (
    doRefresh: RefreshFn,
    logger: TokenRefreshLogger,
    config: Partial<TokenRefreshManagerConfig>,
  ) => TokenRefreshManagerApi;
  readonly createOpenAiRefreshHandler: (deps: OpenAiRefreshDeps, hooks: unknown) => RefreshFn;
  readonly createFactoryRefreshHandler: (deps: FactoryRefreshDeps, hooks: unknown) => RefreshFn;
  readonly createRefreshDispatcher: (deps: TokenRefreshDeps, hooks: unknown) => RefreshFn;
  readonly createEnsureFreshAccounts: (deps: EnsureFreshAccountsDeps, hooks: unknown) => (providerId: string) => Promise<void>;
  // telemetry
  readonly initTelemetry: (env: NodeJS.ProcessEnv) => TelemetryClient;
  readonly getTelemetry: () => TelemetryClient;
  readonly shutdownTelemetry: () => Promise<void>;
  // proxy settings
  readonly createProxySettingsStore: (filePath: string, sql?: Sql) => ProxySettingsStoreApi;
  // host dashboard
  readonly loadHostDashboardTargetsFromEnv: (env: NodeJS.ProcessEnv) => readonly HostDashboardTarget[];
  readonly resolveHostDashboardTargetToken: (target: HostDashboardTarget, env: NodeJS.ProcessEnv) => string | undefined;
  readonly inferSelfHostDashboardTargetId: (input: {
    readonly targets: readonly HostDashboardTarget[];
    readonly explicitSelfId?: string;
    readonly requestBaseUrl?: string;
    readonly requestHost?: string;
  }) => string | undefined;
  readonly parseCaddyRoutes: (source: string) => readonly HostDashboardRouteSummary[];
  readonly collectLocalHostDashboardSnapshot: (input: {
    readonly target: HostDashboardTarget;
    readonly dockerSocketPath?: string;
    readonly runtimeRoot?: string;
  }) => Promise<HostDashboardSnapshot>;
  readonly fetchRemoteHostDashboardSnapshot: (input: {
    readonly target: HostDashboardTarget;
    readonly authToken?: string;
    readonly timeoutMs: number;
  }) => Promise<HostDashboardSnapshot>;
  // w2-routing kernels
  readonly bridgeCapabilitySupportsPath: (manifestPath: string, capability: object, normalizedPath: string) => boolean;
  readonly bridgeCapabilitySupportsModel: (capability: object, requestedModel: string | undefined) => boolean;
  readonly tenantApiKeyConstants: () => { readonly defaultTenantId: string; readonly apiKeyPrefix: string; readonly visiblePrefixLength: number };
  readonly normalizeTenantId: (value: string) => string;
  readonly generateTenantApiKey: () => string;
  readonly buildTenantApiKeyPrefix: (token: string) => string;
  readonly hashTenantApiKey: (token: string, pepper: string) => string;
  readonly extractResponseTextAndUrlCitations: (payload: unknown) => {
    readonly text: string;
    readonly citations: Array<{ readonly url: string; readonly title?: string }>;
    readonly responseId?: string;
  };
  readonly extractMarkdownLinks: (text: string) => Array<{ readonly url: string; readonly title?: string }>;
  readonly deriveOAuthMetadataFromToken: (token: string) => object;
  readonly accountDisplayName: (account: object) => string;
  readonly openAiReauthIdentityMatches: (target: object, resolved: object) => boolean;
  readonly loadModels: (modelsFilePath: string, fallback: readonly string[]) => Promise<string[]>;
  readonly loadDeclaredModels: (modelsFilePath: string) => Promise<string[]>;
  readonly loadModelPreferences: (modelsFilePath: string, fallbackPreferred: readonly string[]) => Promise<{
    readonly preferred: readonly string[];
    readonly disabled: readonly string[];
    readonly aliases: Readonly<Record<string, string>>;
  }>;
  readonly toOpenAiModel: (modelId: string) => { readonly id: string; readonly object: "model"; readonly created: number; readonly owned_by: string };
  readonly providerRoutesFromRaw: (raw: unknown) => object[] | undefined;
  readonly declaredProviderRoutes: (manifestPath: string, result: unknown, config: unknown) => object[];
  readonly filteredProviderRoutes: (result: unknown, inputRoutes: readonly object[]) => object[];
  readonly applyProviderRouteDecision: (preview: unknown, filteredRoutes: readonly object[], upstreamModes: readonly string[]) => {
    readonly providerRoutes: object[];
    readonly strategyMode?: string;
    readonly strategyModeByProvider?: Readonly<Record<string, string>>;
  };
  readonly looksLikeHostedOpenAiFamily: (manifestPath: string, model: string) => boolean;
  readonly stripModelPrefix: (model: string, prefixes: readonly string[]) => string;
  readonly hasModelPrefix: (model: string, prefixes: readonly string[]) => boolean;
  readonly shouldUseLocalOllama: (manifestPath: string, model: string, patterns: readonly string[]) => boolean;
  readonly resolveRequestRoutingState: (manifestPath: string, config: object, requestedModel: string) => {
    readonly explicitOllama: boolean;
    readonly openAiPrefixed: boolean;
    readonly factoryPrefixed: boolean;
    readonly localOllama: boolean;
    readonly routedModel: string;
  };
  readonly dedupeModelIds: (modelIds: readonly string[]) => string[];
  readonly parseModelIdsFromCatalogPayload: (payload: unknown) => string[];
  readonly buildLargestModelAliases: (modelIds: readonly string[]) => Record<string, string>;
  readonly buildOllamaCatalogRoutes: (manifestPath: string, config: object) => object[];
  readonly providerSupportsResponsesApi: (manifestPath: string, providerId: string, openAiProviderId?: string) => boolean;
  readonly providerSupportsImagesApi: (manifestPath: string, providerId: string, openAiProviderId?: string) => boolean;
  readonly filterResponsesApiRoutes: <T extends { readonly providerId: string }>(manifestPath: string, routes: readonly T[], openAiProviderId?: string) => T[];
  readonly filterImagesApiRoutes: <T extends { readonly providerId: string }>(manifestPath: string, routes: readonly T[], openAiProviderId?: string) => T[];
  readonly minMsUntilAnyProviderKeyReady: (keyPool: object, routes: readonly { readonly providerId: string }[]) => Promise<number>;
  readonly createDynamicProviderBaseUrlGetter: (store: object | undefined) => ((providerId: string) => Promise<string | null | undefined>) | undefined;
  // federation (bridge protocol, routing, relay, agent)
  readonly bridgeProtocolVersion: string;
  readonly parseBridgeMessage: (value: unknown) => BridgeMessage;
  readonly parseBridgeMessageJson: (jsonText: string) => BridgeMessage;
  readonly isAtDid: (value: string | undefined) => boolean;
  readonly normalizeAtDid: (value: string) => string;
  readonly fingerprintAdminKey: (value: string) => string;
  readonly parseFederationOwnerCredential: (raw: string | undefined) => FederationOwnerCredential | undefined;
  readonly extractPeerCredential: (auth: Record<string, unknown>) => string | undefined;
  readonly resolveFederationHopCount: (headers: Record<string, unknown>) => number;
  readonly resolveFederationOwnerSubject: (
    input: {
      readonly headers: Record<string, unknown>;
      readonly requestAuth?: { readonly kind?: string; readonly subject?: string; readonly tenantId?: string };
      readonly hopCount?: number;
    },
    defaultOwnerSubject: string | undefined,
  ) => string | undefined;
  readonly federationJsonRequestHeaders: (credential: string | undefined) => Record<string, string>;
  readonly federationFailureMessage: (parsed: unknown, status: number) => string;
  readonly forwardableBridgeResponseHeaders: (
    headers: Readonly<Record<string, string>>,
    hideUpstreamAccount: boolean,
  ) => [string, string][];
  readonly parseBridgeLeaseAccounts: (payload: unknown, fallbackProviderId: string) => BridgeLeaseAccountSummary[];
  readonly parseBridgeLeaseExport: (payload: unknown) => BridgeLeaseExportedAccount | undefined;
  readonly createBridgeRelay: () => unknown;
  readonly createSseBridgeSendChannel: (res: ServerResponse) => BridgeSendChannel;
  readonly formatSseEvent: (event: string, data: unknown) => string;
  readonly createBridgeAgent: (options: unknown) => unknown;
  readonly ensureFederationProjectedAccountsFresh: (input: unknown, deps: unknown) => Promise<{ readonly pulledPeerIds: readonly string[] } | undefined>;
  readonly resolveOnDemandPullTtlMs: (raw: string | undefined) => number;
  /** Bridged and federated request routing (proxx.runtime.federation-routing); `deps` are the host stores, relay and app. */
  readonly executeBridgeRequestRouting: (deps: Record<string, unknown>, input: Record<string, unknown>) => Promise<boolean>;
  readonly handleBridgeRequest: (deps: Record<string, unknown>, input: Record<string, unknown>) => Promise<BridgeRequestHandlerResult>;
  readonly injectNativeBridge: (
    deps: Record<string, unknown>,
    url: string,
    payload: Record<string, unknown>,
    requestHeaders: Record<string, unknown>,
  ) => Promise<LightMyRequestResponse>;
  readonly executeFederatedRequestRouting: (
    deps: Record<string, unknown>,
    input: Record<string, unknown>,
    collaborators: { readonly resolveFederationRoutePath: (suffix: string, options?: { readonly prefix: string }) => string },
  ) => Promise<boolean>;
  readonly fetchFederationJson: (input: {
    readonly url: string;
    readonly credential?: string;
    readonly timeoutMs: number;
    readonly method?: "GET" | "POST";
    readonly body?: Record<string, unknown>;
  }) => Promise<unknown>;
  readonly createEnvFederationBridgeAgentOptions: (deps: unknown) => FederationBridgeAgentOptions | undefined;
}
