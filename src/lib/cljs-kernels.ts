/**
 * Typed handle to the CLJS runtime's pure kernels.
 *
 * The runtime is loaded with a top-level await, so any module that imports
 * this one can call the kernels synchronously. The compiled artifact is
 * required: these functions are the implementation, not an optimization.
 */
import type { ServerResponse } from "node:http";

import { loadCljsRuntime } from "./cljs-runtime.js";
import type { CredentialStoreLike } from "./credential-store.js";
import type { ProxyConfig } from "./config.js";
import type { Sql } from "./db/index.js";
import type { EnsureFreshAccountsDeps, FactoryRefreshDeps, OpenAiRefreshDeps, TokenRefreshDeps, TokenRefreshRuntime } from "./token-refresh-handlers.js";
import type {
  Logger as TokenRefreshLogger,
  RefreshFn,
  TokenRefreshManagerApi,
  TokenRefreshManagerConfig,
} from "./token-refresh-manager.js";
import type { TelemetryClient } from "./telemetry/otel.js";
import type { ProxySettingsStoreApi } from "./proxy-settings-store.js";
import type { HostDashboardRouteSummary, HostDashboardSnapshot, HostDashboardTarget } from "./host-dashboard.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import type {
  QuotaCooldownController,
  QuotaMonitorApi,
  QuotaMonitorConfig,
  QuotaMonitorLogger,
} from "./quota-monitor.js";
import type {
  OpenAiAccountProbeResult,
  OpenAiProbeOptions,
  OpenAiQuotaFetchOptions,
  OpenAiQuotaSnapshotResponse,
} from "./openai-quota.js";
import type {
  ModelPricing,
  ModelPricingIndexStatus,
  ModelPricingRefreshHandle,
  ModelPricingRefreshOptions,
  ModelPricingRefreshSchedulerOptions,
  ModelsDevPricingSnapshot,
  RequestCostEstimate,
} from "./model-pricing.js";
import type { BridgeSendChannel } from "./federation/bridge-send-channel.js";
import type { FederationBridgeAgentOptions } from "./federation/bridge-agent.js";
import type { BridgeMessage } from "./federation/bridge-protocol.js";
import type { BridgeLeaseAccountSummary, BridgeLeaseExportedAccount } from "../routes/federation/bridge-lease-parsers.js";
import type { ProviderCredential } from "./key-pool.js";
import type { FederationOwnerCredential } from "./federation/owner-credential.js";

type JsRecord = Record<string, unknown>;

/** A `continue` attempt outcome (see proxx.strategy.attempt). */
export interface StrategyContinueOutcome {
  readonly kind: "continue";
  readonly rateLimit?: boolean;
  readonly requestError?: boolean;
  readonly upstreamServerError?: boolean;
  readonly upstreamInvalidRequest?: boolean;
  readonly upstreamErrorBody?: string;
  readonly modelNotFound?: boolean;
  readonly modelNotSupportedForAccount?: boolean;
  readonly upstreamAuthError?: { readonly status: number; readonly message?: string };
}

export interface RoutingErrorDescriptor {
  readonly status: number;
  readonly message: string;
  readonly type: string;
  readonly code: string;
}

/** Opaque immutable state of the routing state machine (proxx.strategy.executor). */
export type ExecutorState = { readonly __executorState: never };

/** Request facts the strategy registry's predicates read (proxx.strategy.select). */
export interface StrategySelectionFacts {
  readonly routeProviderId?: string;
  readonly responsesPassthrough?: boolean;
  readonly imagesPassthrough?: boolean;
  readonly embeddingsPassthrough?: boolean;
  readonly explicitOllama?: boolean;
  readonly localOllama?: boolean;
  readonly openAiPrefixed?: boolean;
  readonly factoryPrefixed?: boolean;
  readonly policyPreferredMode?: string;
  readonly factoryModelType?: string;
  readonly clientHeaders?: unknown;
  readonly requestBody?: unknown;
}

/** Method bag returned by the CLJS OAuth manager factories (typed per manager by its TS class). */
export type OAuthManagerFacade = Record<string, (...args: never[]) => unknown>;

type RequestAuthLike = { readonly kind?: string; readonly subject?: string; readonly tenantId?: string } | undefined;

/** Decisions behind bridge and federated routing (proxx.federation.routing). */
export interface FederationRoutingKernel {
  readonly bridgeTenantId: (requestAuth: RequestAuthLike) => string | undefined;
  readonly subjectDid: (requestAuth: RequestAuthLike) => string | undefined;
  readonly hopLimitExceeded: (hopCount: number) => boolean;
  readonly normalizedPath: (upstreamPath: string) => string;
  readonly allowedProviderIds: (providerIds: readonly string[]) => string[];
  readonly sessionEligible: (session: object, ownerSubject: string, tenantId: string) => boolean;
  readonly capabilityAdmissible: (capability: object, allowedProviderIds: readonly string[]) => boolean;
  readonly eventStreamContentType: (contentType: unknown) => boolean;
  readonly jsonContentType: (contentType: unknown) => boolean;
  readonly responseContentType: (headers: Readonly<Record<string, string>>) => string;
  readonly routedPeerLabel: (clusterId: string, agentId: string) => string;
  readonly bridgePathAllowed: (path: string) => boolean;
  readonly bridgeForbiddenBody: () => Record<string, unknown>;
  readonly bridgeRequestHeaders: (input: {
    readonly accept?: string;
    readonly contentType?: string;
    readonly ownerSubject: string;
    readonly tenantId?: string;
  }) => Record<string, string>;
  readonly utf8ChunkEncoding: (contentType: string | undefined) => boolean;
  readonly localProviderIds: (providerIds: readonly string[]) => string[];
  readonly localAccountKey: (providerId: string, accountId: string) => string;
  readonly isActivePeer: (peer: object) => boolean;
  readonly forwardedRequestOverrides: (credential: string, hopCount: number, ownerSubject: string, projectedAccount: object) => Record<string, string>;
  readonly copyableResponseHeader: (name: string) => boolean;
  readonly routedResponseHeaders: (ownerSubject: string, peerId: string, projectedAccount: object, imported: boolean) => Record<string, string>;
  readonly warmImportAllowed: (policyPresent: boolean, policyAuthorizes: boolean) => boolean;
  readonly exportUrls: (peer: object) => [string, string];
  readonly routedDiffEvent: (projectedAccount: object, imported: boolean) => {
    readonly ownerSubject: string;
    readonly entityType: string;
    readonly entityKey: string;
    readonly op: string;
    readonly payload: Record<string, unknown>;
  };
}

export interface CljsKernels {
  // errors/classification
  readonly extractErrorMessage: (payload: unknown) => string | null;
  readonly truncateForLog: (value: string, maxLength?: number) => string;
  readonly messageIndicatesQuotaError: (message: string) => boolean;
  readonly payloadLooksLikeError: (payload: unknown) => boolean;
  readonly streamPayloadIndicatesQuotaError: (payload: string) => boolean;
  readonly responseIndicatesQuotaError: (response: Response) => Promise<boolean>;
  readonly responseIndicatesMissingModel: (response: Response, requestedModel: string) => Promise<boolean>;
  readonly responseIndicatesModelNotSupportedForAccount: (response: Response, requestedModel: string) => Promise<boolean>;
  readonly summarizeUpstreamError: (response: Response) => Promise<{
    readonly upstreamErrorCode?: string;
    readonly upstreamErrorType?: string;
    readonly upstreamErrorMessage?: string;
  }>;
  // sse
  readonly extractSseDataLines: (payload: string) => string[];
  readonly stripSseCommentLines: (payload: string) => string;
  readonly chatCompletionHasReasoningContent: (completion: JsRecord) => boolean;
  readonly streamPayloadHasReasoningTrace: (payload: string) => boolean;
  readonly streamPayloadHasSubstantiveChunks: (payload: string) => boolean;
  // messages compat
  readonly shouldUseMessagesUpstream: (model: unknown, prefixes: readonly string[]) => boolean;
  readonly normalizeMessagesThinkingBudget: (payload: JsRecord) => JsRecord;
  readonly chatRequestToMessagesRequest: (body: JsRecord) => JsRecord;
  readonly messagesToChatCompletion: (body: unknown, fallbackModel: string) => JsRecord;
  // responses compat
  readonly shouldUseResponsesUpstream: (model: unknown, prefixes: readonly string[]) => boolean;
  readonly chatRequestToResponsesRequest: (body: JsRecord) => JsRecord;
  readonly responsesRequestToChatRequest: (body: JsRecord) => JsRecord;
  readonly chatCompletionToResponsesResponse: (completion: unknown) => JsRecord;
  readonly responsesToChatCompletion: (response: unknown, fallbackModel: string) => JsRecord;
  readonly responsesOutputHasReasoning: (response: unknown) => boolean;
  readonly responsesEventStreamToErrorPayload: (streamText: string) => JsRecord | undefined;
  readonly extractTerminalResponseFromEventStream: (streamText: string) => JsRecord | undefined;
  readonly responsesEventStreamToChatCompletion: (streamText: string, fallbackModel: string) => JsRecord;
  readonly chatCompletionEventStreamToResponsesEventStream: (streamText: string, fallbackModel: string) => string;
  readonly chatCompletionEventStreamToResponsesResponse: (streamText: string, fallbackModel: string) => JsRecord;
  readonly chatCompletionToSse: (completion: JsRecord) => string;
  readonly writeInterleavedResponsesSse: (
    responseBody: JsRecord,
    fallbackModel: string,
    writeFn: (data: string) => void,
  ) => Promise<void>;
  readonly streamResponsesSseToChatCompletionChunks: (
    body: ReadableStream<Uint8Array>,
    options: { readonly fallbackModel: string; readonly writeFn: (data: string) => void },
  ) => Promise<{ terminalResponse: JsRecord | null; sawError: JsRecord | null }>;
  // glm
  readonly isGlmModel: (model: string) => boolean;
  readonly applyGlmThinking: (body: JsRecord, model?: string) => JsRecord;
  // factory
  readonly getFactoryModelType: (manifestPath: string, model: string) => string;
  readonly getFactoryApiProvider: (manifestPath: string, model: string) => string;
  readonly getFactoryEndpointPath: (manifestPath: string, modelType: string) => string;
  readonly buildFactoryCommonHeaders: (manifestPath: string, model: string) => Record<string, string>;
  readonly buildFactoryAnthropicHeaders: (
    manifestPath: string,
    model: string,
    payload: JsRecord,
    interleavedThinkingBeta?: string,
  ) => Record<string, string>;
  readonly inlineSystemPrompt: (payload: JsRecord) => JsRecord;
  readonly sanitizeFactorySystemPrompt: (manifestPath: string, systemText: string) => string;
  readonly isFkKey: (manifestPath: string, credential: unknown) => boolean;
  // auto model
  readonly isAutoModel: (model: string) => boolean;
  readonly parseAutoModelType: (model: string) => string | null | undefined;
  readonly rankAutoModels: (
    manifestPath: string,
    model: string,
    requestBody: unknown,
    availableModels: readonly string[] | undefined,
    providerId: string,
    requestLogStore: unknown,
    accountHealthStore: unknown,
    getModelPricing: unknown,
  ) => unknown[];
  readonly selectAutoModel: (
    manifestPath: string,
    model: string,
    requestBody: unknown,
    availableModels: readonly string[] | undefined,
    providerId: string,
    requestLogStore: unknown,
    accountHealthStore: unknown,
    getModelPricing: unknown,
  ) => string | null;
  // http helpers
  readonly readCookieToken: (cookieHeader: string | undefined, name: string) => string | undefined | null;
  readonly parseJsonIfPossible: (body: string) => unknown;
  readonly readSingleHeader: (headers: Record<string, unknown>, name: string) => string | undefined | null;
  readonly escapeHtml: (value: string) => string;
  readonly normalizeRequestedModel: (value: unknown) => string | undefined | null;
  readonly isTrustedLocalBridgeAddress: (remoteAddress: string | undefined) => boolean;
  readonly hasBearerToken: (header: string | undefined, expectedToken: string) => boolean;
  // ollama
  readonly shouldUseOllamaUpstream: (model: unknown, prefixes: readonly string[]) => boolean;
  readonly chatRequestToOllamaRequest: (body: JsRecord, modelPrefixes: readonly string[]) => JsRecord;
  readonly requestHasExplicitNumCtx: (body: JsRecord) => boolean;
  readonly ollamaToChatCompletion: (body: unknown, fallbackModel: string) => JsRecord;
  readonly streamOllamaNdjsonToChatCompletionSse: (
    body: ReadableStream<Uint8Array>,
    fallbackModel: string,
    writeFn: (data: string) => void,
  ) => Promise<void>;
  readonly requestWantsReasoningTrace: (body: JsRecord) => boolean;
  readonly ollamaContextLengthFromShow: (manifestPath: string, payload: unknown) => number | null | undefined;
  readonly ollamaContextBudget: (
    kind: "chat" | "nativeChat" | "embed",
    requestBody: JsRecord,
    contextLength: number,
  ) => {
    readonly model: string;
    readonly contextLength: number;
    readonly estimatedInputTokens: number;
    readonly requestedOutputTokens: number;
    readonly requiredContextTokens: number;
    readonly availableContextTokens: number;
    readonly recommendedNumCtx: number;
  } | null | undefined;
  // requesty
  readonly requestyModelProvider: (manifestPath: string, model: string) => string;
  // http routes (Ring-style handlers registered on Fastify)
  readonly registerHealthRoutes: (
    app: unknown,
    deps: { readonly keyPool: unknown; readonly upstreamProviderId: string; readonly proxyAuthTokenConfigured: boolean },
  ) => void;
  readonly registerApiV1IndexRoute: (app: unknown) => void;
  // route authorization and request-value parsing (routes/shared/ui-auth)
  readonly parseBoolean: (value: unknown) => boolean;
  readonly parseOptionalRequestsPerMinute: (value: unknown) => number | null | undefined;
  readonly parseOptionalProviderIds: (value: unknown) => readonly string[] | null | undefined;
  readonly parseOptionalModelIds: (value: unknown) => readonly string[] | null | undefined;
  readonly parseOptionalPositiveInteger: (value: unknown) => number | undefined;
  readonly authCanViewTenant: (auth: unknown, tenantId: string) => boolean;
  readonly authCanManageTenantKeys: (auth: unknown, tenantId: string) => boolean;
  readonly authCanManageFederation: (auth: unknown) => boolean;
  readonly toVisibleTenants: (
    auth: unknown,
    fallbackTenants: readonly { id: string; name: string; status: string }[],
  ) => readonly { id: string; name: string; status: string }[];
  readonly registerSettingsRoutes: (app: unknown, deps: unknown, prefix: string) => void;
  readonly registerCredentialRoutes: (app: unknown, deps: unknown, prefix: string, sharedCallbacks: boolean) => void;
  readonly joinRoutePath: (prefix: string, suffix: string) => string;
  readonly joinUrl: (baseUrl: string, path: string) => string;
  readonly fetchWithResponseTimeout: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
  readonly getToolSeedForModel: (modelId: string) => Array<{ readonly id: string; readonly description: string; readonly enabled: boolean }>;
  readonly loadMcpSeeds: (ecosystemsDir: string) => Promise<Array<{
    readonly id: string;
    readonly script: string;
    readonly cwd?: string;
    readonly args: readonly string[];
    readonly port?: number;
    readonly sourceFile: string;
    readonly running: false;
  }>>;
  // application composition (src/app.ts)
  readonly installRequestHook: (app: unknown, deps: unknown) => void;
  readonly installErrorHandler: (app: unknown, deps: { readonly isOpenAiHttpError: (error: unknown) => boolean }) => void;
  readonly installNotFoundHandler: (app: unknown) => void;
  readonly installPublicRoutes: (app: unknown, webPort: string) => void;
  readonly createRefreshOpenAiOauthAccounts: (keyPool: unknown, refreshManager: unknown, providerId: string) => (accountId?: string) => Promise<{
    readonly totalAccounts: number;
    readonly refreshedCount: number;
    readonly failedCount: number;
  }>;
  readonly mergeModelIds: (local: readonly string[], bridged: readonly string[]) => string[];
  readonly advertisedModelIds: (sessions: readonly unknown[]) => string[];
  readonly appWiringPlan: (config: unknown) => {
    readonly database: boolean;
    readonly storeInit: readonly { readonly id: string; readonly required: boolean; readonly started: string; readonly failed?: string }[];
    readonly preferAccountStoreProviders: boolean;
    readonly tokenRefresh: {
      readonly maxConcurrency: number;
      readonly backgroundIntervalMs: number;
      readonly expiryBufferMs: number;
      readonly proactiveRefreshWindowMs: number;
      readonly maxConsecutiveFailures: number;
    };
    readonly quotaMonitor: {
      readonly checkIntervalMs: number;
      readonly providerId: string;
      readonly quotaWarningThreshold: number;
      readonly quotaCriticalThreshold: number;
    };
    readonly includeFactoryCatalogRoutes: boolean;
    readonly pheromoneFileName: string;
  };
  readonly createRuntimeCredentialStore: (fileStore: unknown, sqlStore: unknown) => {
    readonly listProviders: (revealSecrets: boolean) => Promise<unknown[]>;
    readonly upsertApiKeyAccount: (providerId: string, accountId: string, apiKey: string) => Promise<void>;
    readonly upsertOAuthAccount: (...args: unknown[]) => Promise<void>;
    readonly flush: () => Promise<void>;
    readonly removeAccount: (providerId: string, accountId: string) => Promise<boolean>;
  };
  // key pool
  readonly loadProviderSeedSpecs: (manifestPath: string) => readonly {
    readonly providerIdEnvNames: readonly string[];
    readonly providerIdFallback: string;
    readonly keyEnvNames: readonly string[];
  }[];
  readonly createKeyPool: (config: unknown, deps: unknown) => unknown;
  // w5-stores
  readonly createKeyPoolDefault: (config: unknown, rng: (() => number) | undefined) => unknown;
  readonly createTokenRefreshRuntime: (deps: TokenRefreshDeps) => TokenRefreshRuntime;
  readonly OpenAiOAuthRefreshError: new (
    status: number,
    message: string,
    details?: { readonly code?: string; readonly type?: string; readonly responseBody?: string },
  ) => Error & { readonly status: number; readonly code?: string; readonly type?: string; readonly responseBody?: string };
  readonly createOpenAiOAuthManagerDefault: (options: unknown) => OAuthManagerFacade;
  readonly isTerminalOpenAiRefreshError: (error: unknown) => boolean;
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
  readonly createOpenAiRefreshHandler: (deps: OpenAiRefreshDeps, hooks?: unknown) => RefreshFn;
  readonly createFactoryRefreshHandler: (deps: FactoryRefreshDeps, hooks?: unknown) => RefreshFn;
  readonly createRefreshDispatcher: (deps: TokenRefreshDeps, hooks?: unknown) => RefreshFn;
  readonly createEnsureFreshAccounts: (deps: EnsureFreshAccountsDeps, hooks?: unknown) => (providerId: string) => Promise<void>;
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
  readonly federationHeaders: {
    readonly hop: string;
    readonly ownerSubject: string;
    readonly bridgeTenant: string;
    readonly forcedProvider: string;
    readonly forcedAccountId: string;
    readonly routedPeer: string;
    readonly routedProvider: string;
    readonly routedAccount: string;
    readonly imported: string;
    readonly blockedResponseHeaders: readonly string[];
  };
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
  readonly federationRouting: FederationRoutingKernel;
  readonly createEnvFederationBridgeAgentOptions: (deps: unknown) => FederationBridgeAgentOptions | undefined;
  // provider-strategy (proxx.strategy.*)
  readonly normalizeGeminiReasoningEffort: (value: unknown) => string | undefined;
  readonly openAiMessagesToGeminiContents: (messages: unknown[]) => Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  readonly extractSystemInstructions: (messages: unknown[]) => string[];
  readonly buildGeminiPayload: (upstreamBody: JsRecord, routedModel: string) => JsRecord;
  readonly geminiResponseToChatCompletion: (response: unknown, routedModel: string) => JsRecord;
  readonly geminiPayloadToSdkRequest: (
    model: string,
    payload: JsRecord,
  ) => { model: string; contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>; config: JsRecord };
  readonly geminiUpstreamPath: (alias: string | undefined | null, routedModel: string) => string;
  readonly isLocalGeminiBaseUrl: (baseUrl: string) => boolean;
  readonly isGeminiSdkModel: (model: string) => boolean;
  readonly classifyGeminiSdkError: (message: string) => {
    readonly kind: "continue";
    readonly rateLimit?: boolean;
    readonly modelNotFound?: boolean;
    readonly modelNotSupportedForAccount?: boolean;
    readonly requestError?: boolean;
    readonly upstreamInvalidRequest?: boolean;
  };
  readonly createGeminiStreamAccumulator: () => {
    readonly push: (chunk: unknown) => void;
    readonly completion: (routedModel: string) => JsRecord;
  };
  readonly extractUsageCountsFromSseText: (streamText: string, mode: string, routedModel: string) => JsRecord;
  readonly usageCountsForMode: (mode: string, upstreamJson: unknown, routedModel: string) => JsRecord;
  readonly responseLooksLikeEventStream: (response: Response, mode: string) => boolean;
  readonly updateUsageCountsFromResponse: (
    requestLogStore: unknown,
    entryId: string,
    response: Response,
    mode: string,
    routedModel: string,
    providerId: string,
    config: unknown,
    attemptStartedAt: number,
    estimateCost: unknown,
  ) => Promise<void>;
  readonly buildFactory4xxDiagnostics: (payload: JsRecord, promptCacheKey?: string) => JsRecord;
  readonly promptCacheKeyHash: (requestBody: JsRecord) => string | undefined;
  readonly updateFailedAttemptDiagnostics: (
    requestLogStore: unknown,
    entryId: string,
    response: Response,
    providerId: string,
    payload: JsRecord,
    promptCacheKey?: string,
  ) => Promise<void>;
  readonly requestedServiceTier: (requestBody: JsRecord, headers: unknown) => string | undefined;
  readonly loggedServiceTier: (
    payload: JsRecord,
    requestBody: JsRecord | undefined,
    headers: unknown,
  ) => { readonly serviceTier?: string; readonly serviceTierSource: "fast_mode" | "explicit" | "none" };
  readonly stripTrailingAssistantPrefill: (payload: JsRecord) => JsRecord;
  readonly ensureUsageInStream: (payload: JsRecord) => JsRecord;
  readonly prepareUpstreamBody: (requestBody: JsRecord, routedModel: string, requestedModel: string) => JsRecord;
  readonly requestyModel: (model: string, prefix: string) => string;
  readonly buildCodexResponsesImagesBody: (imagesBody: JsRecord) => string;
  readonly extractImagesFromResponsesOutput: (response: JsRecord) => JsRecord | undefined;
  readonly extractImagesFromCodexResponse: (responseBody: string) => JsRecord | undefined;
  readonly extractImagesFromCodexEventStream: (streamText: string) => JsRecord | undefined;
  readonly openAiContentToText: (content: unknown) => string;
  readonly resolveUsageAttribution: (auth: unknown) => { readonly tenantId?: string; readonly issuer?: string; readonly keyId?: string };
  readonly shouldRetrySameCredentialForServerError: (status: number, manifestPath?: string) => boolean;
  readonly isTransientProviderRetry: (providerId: string, status: number, manifestPath?: string) => boolean;
  readonly shouldCooldownCredentialOnAuthFailure: (providerId: string, status: number, manifestPath?: string) => boolean;
  readonly shouldPermanentlyDisableCredential: (credential: unknown, status: number, manifestPath?: string) => boolean;
  readonly permanentDisableCooldownMs: (manifestPath?: string) => number;
  readonly cooldownCapMs: (kind: string, manifestPath?: string) => number;
  readonly classifyAuthError: (
    credential: unknown,
    providerId: string,
    status: number,
    configuredCooldownMs: number,
    manifestPath?: string,
  ) => { readonly classification: string; readonly cooldownMs?: number };
  readonly classifyModelNotSupported: (
    configuredCooldownMs: number,
    manifestPath?: string,
  ) => { readonly classification: string; readonly cooldownMs?: number };
  readonly clampRouteQuality: (latencyMs: number, manifestPath?: string) => number;
  readonly accountOrderForRequest: (
    providerId: string,
    routedModel: string,
    planTypes: ReadonlyArray<string | undefined>,
    manifestPath?: string,
  ) => number[];
  readonly accountOrderForLatency: (
    facts: ReadonlyArray<{ readonly planType?: string; readonly ttft?: number; readonly tps?: number }>,
    manifestPath?: string,
  ) => number[];
  readonly candidateOrderForAffinities: (
    candidates: ReadonlyArray<readonly [string, string]>,
    preferred: ReadonlyArray<readonly [string, string]>,
  ) => number[];
  readonly candidateOrderForRoutes: (
    candidates: ReadonlyArray<{ readonly providerIndex?: number; readonly ttft?: number }>,
    manifestPath?: string,
  ) => number[];
  readonly failedBodyNeeded: (status: number) => "auth-summary" | "text" | undefined;
  readonly failedAttemptOutcome: (facts: {
    readonly status: number;
    readonly missingModel?: boolean;
    readonly modelNotSupported?: boolean;
    readonly authMessage?: string;
    readonly errorBody?: string;
  }) => StrategyContinueOutcome;
  readonly isEventStreamContentType: (contentType: string | null | undefined) => boolean;
  readonly isEventStreamOrUntyped: (contentType: string | null | undefined) => boolean;
  readonly okBodyVerdict: (
    bodyText: string,
    facts: { readonly clientWantsStream?: boolean; readonly streamLike?: boolean; readonly imagesPassthrough?: boolean; readonly providerId?: string },
  ) => "empty" | "stream-like" | "invalid" | "ok";
  readonly successMode: (facts: { readonly clientWantsStream?: boolean; readonly needsReasoningTrace?: boolean }) => "reasoning-json" | "stream" | "relay";
  readonly missingReasoningSkips: (
    facts: { readonly needsReasoningTrace?: boolean; readonly hasMoreCandidates?: boolean },
    hasReasoning: boolean,
  ) => boolean;
  readonly isChatCompletionResponse: (value: unknown) => boolean;
  readonly bootstrapEventStream: (
    response: Response,
    opts: { readonly timeoutMs: number; readonly needsReasoningTrace?: boolean; readonly hasMoreCandidates?: boolean },
  ) => Promise<
    | StrategyContinueOutcome
    | { readonly kind: "ready"; readonly reader: ReadableStreamDefaultReader<Uint8Array>; readonly bufferedChunks: Uint8Array[] }
  >;
  readonly createExecutorState: (opts: { readonly reassignmentAllowed: boolean; readonly sticky: boolean }) => ExecutorState;
  readonly executorStep: (state: ExecutorState, event: JsRecord, manifestPath?: string) => {
    readonly state: ExecutorState;
    readonly effects: ReadonlyArray<readonly unknown[]>;
    readonly next?: "handled" | "retry-credential" | "next-step" | "next-candidate" | "stop-candidates" | "refresh-token";
    readonly attempts: number;
    readonly abort: boolean;
  };
  readonly executorSummary: (state: ExecutorState) => JsRecord;
  readonly throttlePlan: (cooldownMs: number, manifestPath?: string) => { readonly waitMs: number; readonly shortCooldownMs: number };
  readonly throttleRetryVerdict: (facts: { readonly rateLimited: boolean; readonly ok: boolean; readonly retryKind?: string }) => string;
  readonly quotaBaseCooldownMs: (
    facts: { readonly status: number; readonly authType: string; readonly accountProviderId: string; readonly keyCooldownMs: number },
    manifestPath?: string,
  ) => number;
  readonly transientStatus: (
    facts: { readonly status: number; readonly providerId: string; readonly hasRetryRemaining: boolean },
    manifestPath?: string,
  ) => "transient-provider" | "server-error-retry" | "server-error" | undefined;
  readonly imagesNextBase: (facts: {
    readonly status: number;
    readonly tryNextBaseOnStatuses?: readonly number[];
    readonly nextBaseDiffers: boolean;
  }) => boolean;
  readonly maxStickyTransportFailures: (manifestPath?: string) => number;
  readonly selectStrategy: (facts: StrategySelectionFacts, opts: { readonly remoteOnly?: boolean; readonly preferredMode?: string }, manifestPath?: string) => string;
  readonly selectRemoteStrategy: (
    facts: StrategySelectionFacts,
    providerId: string,
    openaiProviderId: string,
    explicitMode: string | undefined,
    modeByProvider: Readonly<Record<string, string>> | undefined,
    manifestPath?: string,
  ) => string;
  readonly isCompatEmbeddingProvider: (providerId: string, manifestPath?: string) => boolean;
  readonly buildStrategyPayload: (
    id: string,
    upstreamBody: JsRecord | undefined,
    requestBody: JsRecord | undefined,
    headers: unknown,
    opts: { readonly ollamaModelPrefixes?: readonly string[] },
    manifestPath?: string,
  ) => JsRecord;
  readonly strategyUpstreamPath: (
    id: string,
    providerPaths: Readonly<Record<string, string>> | undefined,
    config: unknown,
    model: unknown,
    manifestPath?: string,
  ) => string | undefined;
  readonly normalizeLlamacppModelName: (model: string) => string;
  readonly strategyMatches: (id: string, facts: StrategySelectionFacts, manifestPath?: string) => boolean;
  readonly maxAutoModelCandidates: (raw: string | undefined, manifestPath?: string) => number;
  readonly shouldAdvanceAutoCandidate: (
    facts: { readonly hasMore: boolean; readonly autoModel: boolean },
    summary: object,
    manifestPath?: string,
  ) => boolean;
  readonly isVisionAutoModel: (model: string) => boolean;
  readonly visionModelCandidates: (availableModels: readonly string[], manifestPath?: string) => string[];
  readonly visionRouteOrder: (model: string, providerIds: readonly string[], manifestPath?: string) => number[];
  readonly isCephalonAutoModel: (model: string) => boolean;
  readonly cephalonPlan: (
    model: string,
    availableModels: readonly string[] | undefined,
    manifestPath?: string,
  ) => { readonly innerModel: string; readonly candidates: string[] };
  readonly cephalonChoice: (model: string, ranked: readonly string[], manifestPath?: string) => string;
  readonly deriveStrategyContextFacts: (input: {
    readonly surface: string;
    readonly routing: { readonly factoryPrefixed: boolean; readonly openAiPrefixed: boolean; readonly explicitOllama: boolean; readonly localOllama: boolean };
    readonly requestBody: JsRecord;
    readonly hostedOpenAiFamily: boolean;
    readonly config: {
      readonly requestTimeoutMs: number;
      readonly streamBootstrapTimeoutMs: number;
      readonly upstreamProviderId: string;
      readonly openaiProviderId: string;
    };
  }) => {
    readonly routeProviderId: string;
    readonly clientWantsStream: boolean;
    readonly needsReasoningTrace: boolean;
    readonly upstreamAttemptTimeoutMs: number;
    readonly explicitOllama: boolean;
    readonly localOllama: boolean;
    readonly openAiPrefixed: boolean;
    readonly responsesPassthrough: boolean;
    readonly imagesPassthrough: boolean;
  };
  // w2-routing kernels (catalog, alias, outcome, pipeline)
  readonly resolvableConcreteModelIds: (catalog: object | null) => string[] | undefined;
  readonly resolvableConcreteModelIdsForProviders: (
    bundle: object | null,
    providerIds: readonly string[],
    includeDeclaredModel?: (modelId: string) => boolean,
  ) => string[] | undefined;
  readonly resolveCatalogAlias: (
    manifestPath: string,
    bundle: object,
    requested: string,
    preserveExplicitOllama: boolean | undefined,
  ) => { readonly error?: RoutingErrorDescriptor; readonly routingModelInput?: string; readonly aliasApplied?: boolean };
  readonly classifyRoutingOutcome: (execution: object, availability: object) => string;
  readonly routingOutcomeNeedsRetryHint: (outcome: string) => boolean;
  readonly routingOutcomeResponse: (
    outcome: string,
    ctx: {
      readonly routedModel: string;
      readonly logPrefix?: string;
      readonly lastUpstreamError?: object;
      readonly sawRequestError?: boolean;
    },
    retryInMs: number,
  ) => RoutingErrorDescriptor & {
    readonly retryAfterSeconds?: number;
    readonly log?: { readonly level: "warn" | "error"; readonly message: string };
    readonly withRequestError?: boolean;
  };
  readonly checkRequestedModel: (requestBody: object) => { readonly model?: string; readonly error?: RoutingErrorDescriptor };
  readonly tenantDeniesModel: (preview: unknown) => boolean;
  readonly tenantDeniedError: (model: string) => RoutingErrorDescriptor;
  readonly routingCandidateSource: (flags: { readonly cephalon: boolean; readonly vision: boolean; readonly auto: boolean }) => "cephalon" | "vision" | "auto" | "plain";
  readonly finishModelRouting: (requested: string, source: string, candidates: readonly string[]) => {
    readonly error?: RoutingErrorDescriptor;
    readonly candidates?: string[];
    readonly isAutoModel?: boolean;
    readonly candidatesHeader?: string;
  };
  readonly createProviderCatalogStore: (
    manifestPath: string,
    config: object,
    keyPool: object,
    routes: readonly object[],
    ollamaRoutes: readonly object[],
    deps: object,
  ) => {
    readonly getCatalog: (forceRefresh?: boolean) => Promise<unknown>;
    readonly isModelAvailable: (providerId: string, modelId: string) => Promise<boolean>;
  };
  // w2-routing kernels (aco, pheromone)
  readonly rankProviderRoutesWithAco: (manifestPath: string, input: object) => Promise<{
    readonly orderedRoutes: object[];
    readonly signals: readonly object[];
  }>;
  readonly pheromoneHydrateDb: (raw: unknown) => object[];
  readonly pheromoneKeyValid: (providerId: string, model: string) => boolean;
  readonly pheromoneGet: (records: readonly object[], providerId: string, model: string) => number;
  readonly pheromoneNoteSuccess: (records: readonly object[], providerId: string, model: string, quality: number) => object[];
  readonly pheromoneNoteFailure: (records: readonly object[], providerId: string, model: string) => object[];
  // w3 routes-ui
  readonly registerHostRoutes: (app: unknown, env: object, prefix: string) => void;
  readonly registerEventRoutes: (app: unknown, eventStore: object | undefined) => void;
  readonly registerSessionRoutes: (app: unknown, deps: object, prefix: string) => void;
  readonly registerObservabilityRoutes: (app: unknown, deps: object, options?: object) => void;
  readonly registerRequestLogSseRoutes: (app: unknown, deps: object, hub: object) => void;
  readonly registerBridgeSseRoutes: (app: unknown, deps: object, relay: object) => void;
  readonly registerWebSocketRoutes: (app: unknown, deps: object) => unknown;
  readonly registerFederationRoutes: (app: unknown, deps: object, prefix: string) => void;
  // w3:proxy proxy forwarding / rate-limit decisions (proxx.http.proxy)
  readonly buildForwardHeaders: (clientHeaders: object) => Record<string, string>;
  readonly buildUpstreamHeaders: (clientHeaders: object, apiKey: string) => Record<string, string>;
  readonly buildUpstreamHeadersForCredential: (
    clientHeaders: object,
    credential: { readonly token: string; readonly chatgptAccountId?: string },
    options?: { readonly useOpenAiCodexHeaderProfile?: boolean },
  ) => Record<string, string>;
  readonly forwardableResponseHeaders: (pairs: readonly (readonly [string, string])[]) => [string, string][];
  readonly parseRetryAfterMs: (value: string | null) => number | undefined;
  readonly classifyRateLimitKind: (errorBody: unknown, retryAfterMs: number | undefined, thresholdMs?: number) => "quota_exhausted" | "concurrency_throttle";
  readonly detectOllamaLimitKind: (errorBody: unknown) => "session" | "weekly" | "unknown";
  readonly parseWaitTimeFromMessage: (message: string) => number | undefined;
  readonly extractRateLimitCooldownMs: (response: Response) => Promise<number | undefined>;
  readonly openAiError: (message: string, type: string, code?: string) => {
    readonly error: { readonly message: string; readonly type: string; readonly code?: string; readonly param: null };
  };
  // w3:onative ollama native API translation (proxx.compat.ollama-native)
  readonly nativeChatToOpenAiRequest: (body: JsRecord) => JsRecord;
  readonly nativeGenerateToChatRequest: (body: JsRecord) => JsRecord;
  readonly chatCompletionToNativeChat: (response: JsRecord) => JsRecord;
  readonly chatCompletionToNativeGenerate: (response: JsRecord) => JsRecord;
  readonly nativeEmbedToOpenAiRequest: (body: JsRecord) => {
    readonly model: string;
    readonly input: string | readonly string[];
    readonly num_ctx?: number;
    readonly ollama_num_ctx?: number;
  };
  readonly nativeEmbedToOllamaRequest: (body: JsRecord, defaultNumCtx?: number) => JsRecord;
  readonly openAiEmbeddingsToNativeEmbed: (response: JsRecord) => JsRecord;
  readonly openAiEmbeddingsToNativeEmbeddings: (response: JsRecord) => JsRecord;
  readonly nativeEmbedResponseToOpenAiEmbeddings: (response: JsRecord, model: string) => JsRecord;
  readonly modelIdsToNativeTags: (modelIds: readonly string[], newDigest: () => string) => JsRecord;
  // w3:websearch websearch route (proxx.http.websearch)
  readonly registerWebsearchRoutes: (app: unknown, deps: unknown) => void;
  // w3:nativeollama ollama-native routes (proxx.http.native-ollama)
  readonly registerNativeOllamaRoutes: (app: unknown, deps: unknown) => void;
  // w3:embeddings embeddings route (proxx.http.embeddings)
  readonly registerEmbeddingsRoutes: (app: unknown, deps: unknown, collaborators: unknown) => void;
  // w3:embproviders embedding backends (proxx.embeddings.providers)
  readonly loadEmbeddingsConfig: () => object;
  readonly embedWithOllama: (cfg: object, req: object) => Promise<import("./embeddings-strategy.js").EmbeddingResponse>;
  readonly embedWithHFCloud: (cfg: object, req: object) => Promise<import("./embeddings-strategy.js").EmbeddingResponse>;
  readonly embedWithTEI: (cfg: object, req: object) => Promise<import("./embeddings-strategy.js").EmbeddingResponse>;
  readonly embedWithOvmNpu: (cfg: object, req: object) => Promise<import("./embeddings-strategy.js").EmbeddingResponse>;
  // w3:v1 inference routes (proxx.http.v1)
  readonly registerImagesRoutes: (app: unknown, deps: unknown, collaborators: unknown) => void;
  readonly registerChatRoutes: (app: unknown, deps: unknown, collaborators: unknown) => void;
  readonly registerResponsesRoutes: (app: unknown, deps: unknown, collaborators: unknown) => void;
  // w3:media media generation routes (proxx.http.media)
  readonly registerMediaRoutes: (app: unknown, deps: unknown, collaborators: unknown) => void;
  // w3:cloudprobe ollama cloud probe (proxx.ollama.cloud-probe)
  readonly probeOllamaCloudAccount: (
    credentialStore: object,
    options: { readonly providerId: string; readonly accountId: string; readonly baseUrl: string; readonly model?: string; readonly fetchFn?: typeof fetch },
  ) => Promise<import("./ollama-cloud-probe.js").CredentialAccountProbeResult>;
  // w3:candidates routing-candidate facts (proxx.strategy.candidates)
  readonly forcedCredentialSelection: (authKind: string | undefined, headers: Record<string, unknown>) => {
    readonly providerId?: string;
    readonly accountId?: string;
  };
  readonly noAuthAccount: (providerId: string) => ProviderCredential;
  readonly affinitiesFromRecord: (record: unknown) => {
    readonly preferred?: { readonly providerId: string; readonly accountId: string };
    readonly provisional?: { readonly providerId: string; readonly accountId: string };
  };
  // w4host provider replies (proxx.runtime.provider-reply): a strategy's answer to an upstream response
  readonly handleProviderAttempt: (id: string, reply: unknown, response: Response, context: unknown) => Promise<import("./provider-strategy/shared.js").ProviderAttemptOutcome>;
  readonly handleLocalAttempt: (id: string, reply: unknown, response: Response, context: unknown) => Promise<void>;
  readonly handleStandardProviderAttempt: (reply: unknown, response: Response, context: unknown) => Promise<import("./provider-strategy/shared.js").ProviderAttemptOutcome>;
  readonly handleStandardLocalAttempt: (reply: unknown, response: Response, context: unknown) => Promise<void>;
  // w4host provider routing loop (proxx.runtime.attempt-executor)
  readonly executeProviderRoutingPlan: (
    strategy: unknown, reply: unknown, requestLogStore: unknown, promptAffinityStore: unknown, pheromoneStore: unknown,
    keyPool: unknown, providerRoutes: unknown, context: unknown, payload: unknown, promptCacheKey: string | undefined,
    refreshExpiredToken: unknown, healthStore: unknown, eventStore: unknown, quotaMonitor: unknown, queueSignal: AbortSignal | undefined,
    host: {
      readonly selectRemoteStrategy: (context: unknown, providerId: string) => unknown;
      readonly estimateRequestCost: (providerId: string, model: string, promptTokens: number, completionTokens: number) => unknown;
      readonly requestyModelProvider: (model: string) => string;
    },
  ) => Promise<import("./provider-strategy/shared.js").ProviderRoutingExecutionResult>;
  readonly executeLocalStrategy: (
    strategy: unknown, reply: unknown, requestLogStore: unknown, context: unknown, payload: unknown,
    queueSignal: AbortSignal | undefined,
    host: { readonly estimateRequestCost: (providerId: string, model: string, promptTokens: number, completionTokens: number) => unknown },
  ) => Promise<void>;
  // w4host database schema as data (proxx.db.schema, resources/db/schema.edn) and the Postgres client
  readonly sqlStatement: (id: string) => string;
  readonly schemaVersion: () => number;
  readonly allMigrations: () => ReadonlyArray<{ readonly version: number; readonly sql: string }>;
  readonly pendingMigrations: (currentVersion: number) => ReadonlyArray<{ readonly version: number; readonly sql: string }>;
  readonly runMigrations: (sql: unknown) => Promise<void>;
  readonly createSqlConnection: (config: object) => unknown;
  readonly closeSqlConnection: (sql: unknown) => Promise<void>;
  readonly createGithubAllowlist: (sql: unknown) => {
    readonly init: () => Promise<void>;
    readonly allowsUser: (login: string) => Promise<boolean>;
    readonly addAllowedUser: (login: string) => Promise<void>;
    readonly removeAllowedUser: (login: string) => Promise<void>;
    readonly getAllowedUsers: () => Promise<string[]>;
  };
  // w4host application (proxx.app.main)
  readonly createApp: (config: object, host: object) => Promise<import("fastify").FastifyInstance>;
  readonly inspectProviderAvailability: (
    keyPool: unknown, providerRoutes: unknown, promptCacheKey: string | undefined,
  ) => Promise<import("./provider-strategy/shared.js").ProviderAvailabilitySummary>;
}

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

const loaded = await loadCljsRuntime({ required: true });
if (!loaded.loaded) {
  throw new Error(`CLJS runtime is required: ${loaded.reason}`);
}

export const kernels = loaded.runtime as unknown as CljsKernels;
