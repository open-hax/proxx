/**
 * Typed handle to the CLJS runtime's pure kernels.
 *
 * The runtime is loaded with a top-level await, so any module that imports
 * this one can call the kernels synchronously. The compiled artifact is
 * required: these functions are the implementation, not an optimization.
 */
import { loadCljsRuntime } from "./cljs-runtime.js";
import type { CredentialStoreLike } from "./credential-store.js";
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

type JsRecord = Record<string, unknown>;

/** Method bag returned by the CLJS OAuth manager factories (typed per manager by its TS class). */
export type OAuthManagerFacade = Record<string, (...args: never[]) => unknown>;

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
  // key pool
  readonly loadProviderSeedSpecs: (manifestPath: string) => readonly {
    readonly providerIdEnvNames: readonly string[];
    readonly providerIdFallback: string;
    readonly keyEnvNames: readonly string[];
  }[];
  readonly createKeyPool: (config: unknown, deps: unknown) => unknown;
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
