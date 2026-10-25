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
}

const loaded = await loadCljsRuntime({ required: true });
if (!loaded.loaded) {
  throw new Error(`CLJS runtime is required: ${loaded.reason}`);
}

export const kernels = loaded.runtime as unknown as CljsKernels;
