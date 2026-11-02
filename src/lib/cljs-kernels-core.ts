/** Application, request and provider-shape kernels (a slice of `CljsKernels`; see cljs-kernels.ts). */


type JsRecord = Record<string, unknown>;

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

export interface CljsKernelsCore {
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
  readonly queueErrorResponse: (error: unknown) => {
    readonly statusCode: number;
    readonly message: string;
    readonly type: string;
    readonly code: string;
    readonly retryAfterSeconds?: number;
  } | undefined;
  readonly strategyForId: (id: string) => import("./provider-strategy/shared.js").ProviderStrategy;
  readonly allStrategies: () => import("./provider-strategy/shared.js").ProviderStrategy[];
  readonly allStrategyInfos: (manifestPath?: string) => Array<{ readonly mode: string; readonly isLocal: boolean; readonly priority: number }>;
  readonly selectionFacts: (context: unknown, policyPreferredMode?: string) => StrategySelectionFacts;
  readonly executionProvider: (providerIds: readonly string[]) => string | undefined;
  // request facts (proxx.http.request-facts)
  readonly extractPromptCacheKey: (body: JsRecord) => string | undefined;
  readonly hashPromptCacheKey: (promptCacheKey: string) => string;
  readonly appendCsvHeaderValue: (headers: Headers, name: string, value: string) => void;
  readonly shouldEnableInterleavedThinkingHeader: (upstreamPayload: JsRecord) => boolean;
  readonly summarizeResponsesRequestBody: (body: JsRecord) => JsRecord;
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
  readonly fetchOllamaModelContextLength: (
    manifestPath: string,
    baseUrl: string,
    model: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<number | null>;
  readonly ensureOllamaContextFits: (
    manifestPath: string,
    kind: "chat" | "nativeChat" | "embed",
    baseUrl: string,
    requestBody: JsRecord,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<{
    readonly model: string;
    readonly contextLength: number;
    readonly estimatedInputTokens: number;
    readonly requestedOutputTokens: number;
    readonly requiredContextTokens: number;
    readonly availableContextTokens: number;
    readonly recommendedNumCtx: number;
  } | null | undefined>;
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
}
