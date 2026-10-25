/**
 * Typed handle to the CLJS runtime's pure kernels.
 *
 * The runtime is loaded with a top-level await, so any module that imports
 * this one can call the kernels synchronously. The compiled artifact is
 * required: these functions are the implementation, not an optimization.
 */
import { loadCljsRuntime } from "./cljs-runtime.js";

type JsRecord = Record<string, unknown>;

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
  // key pool
  readonly loadProviderSeedSpecs: (manifestPath: string) => readonly {
    readonly providerIdEnvNames: readonly string[];
    readonly providerIdFallback: string;
    readonly keyEnvNames: readonly string[];
  }[];
  readonly createKeyPool: (config: unknown, deps: unknown) => unknown;
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
}

const loaded = await loadCljsRuntime({ required: true });
if (!loaded.loaded) {
  throw new Error(`CLJS runtime is required: ${loaded.reason}`);
}

export const kernels = loaded.runtime as unknown as CljsKernels;
