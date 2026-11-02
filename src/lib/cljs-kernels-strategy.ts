/** Provider-strategy, route-surface and store-edge kernels (a slice of `CljsKernels`; see cljs-kernels.ts). */
import type { ProviderCredential } from "./key-pool.js";
import type { StrategySelectionFacts } from "./cljs-kernels-core.js";

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

export interface CljsKernelsStrategy {
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
  // w2-routing kernels (aco)
  readonly rankProviderRoutesWithAco: (manifestPath: string, input: object) => Promise<{
    readonly orderedRoutes: object[];
    readonly signals: readonly object[];
  }>;
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
  // w6 stores (stateful edges; each returns the facade its TS class forwards to)
  readonly createProviderRoutePheromoneStore: (filePath: string, persistIntervalMs: number) => unknown;
  readonly createSqlAuthPersistence: (sql: unknown) => unknown;
  readonly createSqlTenantProviderPolicyStore: (sql: unknown) => unknown;
  readonly createSqlRequestUsageStore: (sql: unknown) => unknown;
  readonly createSqlFederationStore: (sql: unknown) => unknown;
  readonly createSqlCredentialStore: (sql: unknown, options: object) => unknown;
  readonly createEventStore: (sql: unknown, flushIntervalMs: number, maxBufferSize: number) => unknown;
  // w7 leftovers: strategy ordering and auto-model glue (proxx.runtime.strategy-routes)
  readonly reorderCandidatesForAffinities: <T extends { readonly providerId: string; readonly account: { readonly accountId: string } }>(
    candidates: readonly T[], preferred: readonly { readonly providerId: string; readonly accountId: string }[],
  ) => T[];
  readonly providerAccountsForRequest: <T extends { readonly planType?: string }>(accounts: readonly T[], providerId: string, routedModel: string) => T[];
  readonly reorderAccountsForLatency: <T extends { readonly accountId: string; readonly planType?: string }>(
    requestLogStore: unknown, providerId: string, accounts: readonly T[], routedModel: string, upstreamMode: string,
  ) => T[];
  readonly resolveAutoModelWith: (model: string, select: (model: string) => string | null) => string;
  readonly autoModelCandidatesWith: (model: string, rank: (model: string) => readonly string[]) => string[];
  readonly resolveCephalonAutoModelWith: (
    model: string, availableModels: readonly string[] | undefined,
    rank: (innerModel: string, candidates: readonly string[]) => readonly string[],
  ) => string | null;
  readonly cephalonModelCandidatesWith: (
    model: string, availableModels: readonly string[] | undefined,
    rank: (innerModel: string, candidates: readonly string[]) => readonly string[],
  ) => string[];
  readonly visionModelCandidatesFor: (model: string, availableModels: readonly string[]) => string[];
  readonly reorderVisionProviderRoutes: <T extends { readonly providerId: string }>(routes: readonly T[], routedModel: string) => T[];
  readonly getDeclaredProviderRoutes: (policyManifestPath: string, configOrManifestPath: object | string | undefined) => object[];
  readonly filterDeclaredProviderRoutes: (manifestPath: string | undefined, input: object) => {
    readonly providerRoutes: object[];
    readonly strategyMode?: string;
    readonly strategyModeByProvider?: Readonly<Record<string, string>>;
    readonly catalog?: { readonly disabled?: boolean; readonly rejected?: boolean };
  };
  readonly sendOpenAiError: (reply: unknown, statusCode: number, message: string, type: string, code?: string) => void;
  readonly sendQueueError: (reply: unknown, error: unknown) => boolean;
  readonly shouldAdvanceModelCandidate: (kind: "auto" | "vision" | "cephalon", model: string, hasMore: boolean, summary: object) => boolean;
}
