import type { IncomingHttpHeaders } from "node:http";

import type { FastifyReply } from "fastify";

import type { ProxyConfig } from "../config.js";
import type { ProviderCredential } from "../key-pool.js";
import type { Factory4xxDiagnostics, RequestLogStore } from "../request-log-store.js";
import type { ResolvedRequestAuth } from "../request-auth.js";
import { estimateRequestCost } from "../model-pricing.js";
import { kernels } from "../cljs-kernels.js";
import { normalizeReasoningRequestWithCljs, resolveModelAliasWithCljs } from "../cljs-runtime.js";
import {
  isGlmModel,
  applyGlmThinking,
} from "../glm-compat.js";
import { joinUrl } from "../http/index.js";

/*
 * Decisions in this module (usage extraction, diagnostics fingerprints, service
 * tier selection, credential ordering and judgement) are pure CLJS kernels
 * (proxx.strategy.*); what remains is context plumbing and effects.
 */

function dedupePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function transientRetryDelayMs(context: StrategyRequestContext, retryIndex: number): number {
  return context.config.upstreamTransientRetryBackoffMs * (retryIndex + 1);
}

function shouldRetrySameCredentialForServerError(status: number, manifestPath?: string): boolean {
  return kernels.shouldRetrySameCredentialForServerError(status, manifestPath);
}

function shouldCooldownCredentialOnAuthFailure(providerId: string, status: number, manifestPath?: string): boolean {
  return kernels.shouldCooldownCredentialOnAuthFailure(providerId, status, manifestPath);
}

/**
 * For static API keys, 402/403 means the key was disabled (permanent); the
 * per-provider exceptions and the cooldown are declared in
 * 77-upstream-attempt-policy.edn. OAuth accounts are excluded (they refresh).
 */
const PERMANENT_DISABLE_COOLDOWN_MS = kernels.permanentDisableCooldownMs();

function shouldPermanentlyDisableCredential(credential: ProviderCredential, status: number, manifestPath?: string): boolean {
  return kernels.shouldPermanentlyDisableCredential(credential, status, manifestPath);
}

function reorderCandidatesForAffinity<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: PreferredAffinity | undefined,
): T[] {
  return reorderCandidatesForAffinities(candidates, preferred ? [preferred] : []);
}

export function reorderCandidatesForAffinities<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: readonly { readonly providerId: string; readonly accountId: string }[],
): T[] {
  const order = kernels.candidateOrderForAffinities(
    candidates.map((candidate) => [candidate.providerId, candidate.account.accountId] as const),
    preferred.map((entry) => [entry.providerId, entry.accountId] as const),
  );
  return order.map((index) => candidates[index]!);
}

type UpstreamMode =
  | "chat_completions"
  | "responses"
  | "responses_passthrough"
  | "openai_responses_passthrough"
  | "images"
  | "gemini_chat"
  | "messages"
  | "openai_chat_completions"
  | "openai_responses"
  | "ollama_chat"
  | "local_ollama_chat"
  | "embeddings"
  | "hf_embeddings"
  | "tei_embeddings"
  | "ovm_embeddings";

interface StrategyRequestContext {
  /** Provider id for which we're selecting an upstream strategy. */
  readonly routeProviderId?: string;
  readonly config: ProxyConfig;
  readonly clientHeaders: IncomingHttpHeaders;
  readonly requestBody: Record<string, unknown>;
  readonly requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">;
  readonly requestedModelInput: string;
  readonly routingModelInput: string;
  readonly routedModel: string;
  readonly explicitOllama: boolean;
  readonly openAiPrefixed: boolean;
  readonly factoryPrefixed: boolean;
  readonly localOllama: boolean;
  readonly clientWantsStream: boolean;
  readonly needsReasoningTrace: boolean;
  readonly upstreamAttemptTimeoutMs: number;
  readonly responsesPassthrough?: boolean;
  readonly imagesPassthrough?: boolean;
  readonly embeddingsPassthrough?: boolean;
  /** Strategy mode selected by the authoritative declarative policy, when available. */
  readonly policyPreferredStrategyMode?: UpstreamMode;
  /** Strategy modes selected by policy per provider route. */
  readonly policyPreferredStrategyModeByProvider?: Readonly<Record<string, UpstreamMode>>;
  /** Per-provider path overrides from CLJS contract routes, keyed by path kind (chat-completions, messages, responses, images-generations). */
  readonly providerPaths?: Readonly<Record<string, string>>;
}

interface ProviderAttemptContext extends StrategyRequestContext {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly account: ProviderCredential;
  readonly hasMoreCandidates: boolean;
  readonly attempt: number;
}

interface LocalAttemptContext extends StrategyRequestContext {
  readonly baseUrl: string;
}

interface ProviderAttemptOutcomeHandled {
  readonly kind: "handled";
}

interface ProviderAttemptOutcomeContinue {
  readonly kind: "continue";
  readonly rateLimit?: boolean;
  readonly requestError?: boolean;
  readonly upstreamServerError?: boolean;
  readonly upstreamInvalidRequest?: boolean;
  readonly upstreamErrorBody?: string;
  readonly modelNotFound?: boolean;
  readonly modelNotSupportedForAccount?: boolean;
  readonly upstreamAuthError?: {
    readonly status: number;
    readonly message?: string;
  };
}

type ProviderAttemptOutcome = ProviderAttemptOutcomeHandled | ProviderAttemptOutcomeContinue;

interface RoutingAccumulator {
  sawRateLimit: boolean;
  sawRequestError: boolean;
  sawUpstreamServerError: boolean;
  sawUpstreamInvalidRequest: boolean;
  lastUpstreamError?: { status: number; body: string; providerId?: string };
  sawModelNotFound: boolean;
  sawModelNotSupportedForAccount: boolean;
  attempts: number;
  lastUpstreamAuthError?: {
    readonly status: number;
    readonly message?: string;
  };
}

export interface ProviderRoutingExecutionResult {
  readonly handled: boolean;
  readonly candidateCount: number;
  readonly summary: RoutingAccumulator;
}

interface PreferredAffinity {
  readonly providerId: string;
  readonly accountId: string;
}

export interface ProviderAvailabilitySummary {
  readonly sawConfiguredProvider: boolean;
  readonly sawOnlyDisabledProviders: boolean;
  readonly prompt_cache_key?: string;
}

interface BuildPayloadResult {
  readonly upstreamPayload: Record<string, unknown>;
  readonly bodyText: string;
  readonly serviceTier?: string;
  readonly serviceTierSource: "fast_mode" | "explicit" | "none";
}

function providerAccountsForRequest(
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
): ProviderCredential[] {
  return kernels
    .accountOrderForRequest(providerId, routedModel, accounts.map((account) => account.planType))
    .map((index) => accounts[index]!);
}

function reorderAccountsForLatency(
  requestLogStore: RequestLogStore,
  providerId: string,
  accounts: readonly ProviderCredential[],
  routedModel: string,
  upstreamMode: string,
): ProviderCredential[] {
  const facts = accounts.map((account) => {
    const perf = requestLogStore.getPerfSummary(providerId, account.accountId, routedModel, upstreamMode);
    return { planType: account.planType, ttft: perf?.ewmaTtftMs ?? undefined, tps: perf?.ewmaTps ?? undefined };
  });
  return kernels.accountOrderForLatency(facts).map((index) => accounts[index]!);
}

export interface UsageCounts {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
}

interface ProviderStrategy {
  readonly mode: UpstreamMode;
  readonly isLocal: boolean;
  matches(context: StrategyRequestContext): boolean;
  getUpstreamPath(context: StrategyRequestContext): string;
  buildPayload(context: StrategyRequestContext): BuildPayloadResult;
  applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void;
  handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome>;
  handleLocalAttempt(reply: FastifyReply, response: Response, context: LocalAttemptContext): Promise<void>;
}

/**
 * Optional interface for strategies that want to bypass the standard HTTP fetch
 * and handle the upstream request directly (e.g., using an SDK).
 */
export interface DirectExecutionProviderStrategy extends ProviderStrategy {
  executeDirect(
    reply: FastifyReply,
    context: ProviderAttemptContext,
    payload: Record<string, unknown>,
  ): Promise<ProviderAttemptOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function buildFactory4xxDiagnostics(
  upstreamPayload: Record<string, unknown>,
  promptCacheKey?: string,
): Factory4xxDiagnostics {
  return kernels.buildFactory4xxDiagnostics(upstreamPayload, promptCacheKey) as unknown as Factory4xxDiagnostics;
}

function updateFailedAttemptDiagnostics(
  requestLogStore: RequestLogStore,
  entryId: string,
  response: Response,
  providerId: string,
  upstreamPayload: Record<string, unknown>,
  promptCacheKey?: string,
): Promise<void> {
  return kernels.updateFailedAttemptDiagnostics(requestLogStore, entryId, response, providerId, upstreamPayload, promptCacheKey);
}

function stripTrailingAssistantPrefill(payload: Record<string, unknown>): void {
  const stripped = kernels.stripTrailingAssistantPrefill(payload);
  if (stripped !== payload) {
    payload["input"] = stripped["input"];
  }
}

function resolveLoggedServiceTier(
  upstreamPayload: Record<string, unknown>,
  context?: StrategyRequestContext,
): { readonly serviceTier?: string; readonly serviceTierSource: "fast_mode" | "explicit" | "none" } {
  return kernels.loggedServiceTier(upstreamPayload, context?.requestBody, context?.clientHeaders);
}

function buildPayloadResult(upstreamPayload: Record<string, unknown>, context?: StrategyRequestContext): BuildPayloadResult {
  const { serviceTier, serviceTierSource } = resolveLoggedServiceTier(upstreamPayload, context);

  return {
    upstreamPayload,
    bodyText: JSON.stringify(upstreamPayload),
    serviceTier,
    serviceTierSource,
  };
}

function applyProviderModelAliasToPayload(
  payload: BuildPayloadResult,
  context: StrategyRequestContext,
  providerId: string,
): BuildPayloadResult {
  const currentModel = payload.upstreamPayload.model;
  if (typeof currentModel !== "string" || currentModel.length === 0) {
    return payload;
  }

  const alias = resolveModelAliasWithCljs({
    manifestPath: context.config.cljsPolicyManifestPath,
    modelId: context.routedModel,
    providerId,
  });
  if (!alias || alias === currentModel) {
    return payload;
  }

  const upstreamPayload = { ...payload.upstreamPayload, model: alias };
  return {
    ...payload,
    upstreamPayload,
    bodyText: JSON.stringify(upstreamPayload),
  };
}

function buildRequestBodyForUpstream(context: StrategyRequestContext): Record<string, unknown> {
  const rawUpstreamBody = kernels.prepareUpstreamBody(context.requestBody, context.routedModel, context.requestedModelInput);

  const upstreamBody = normalizeReasoningRequestWithCljs({
    manifestPath: context.config.cljsPolicyManifestPath,
    requestBody: rawUpstreamBody,
    modelId: context.routedModel,
    providerId: context.routeProviderId,
  });

  if (isGlmModel(context.routedModel)) {
    return applyGlmThinking(upstreamBody, context.routedModel);
  }

  return upstreamBody;
}

function ensureChatCompletionsUsageInStream(upstreamBody: Record<string, unknown>): void {
  if (upstreamBody["stream"] !== true) {
    return;
  }
  upstreamBody["stream_options"] = (kernels.ensureUsageInStream(upstreamBody)["stream_options"]);
}

function readHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return typeof value === "string" ? value : undefined;
}

function parseBooleanHeader(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function resolveRequestedServiceTier(context: StrategyRequestContext): string | undefined {
  return kernels.requestedServiceTier(context.requestBody, context.clientHeaders);
}

function applyRequestedServiceTier(upstreamPayload: Record<string, unknown>, context: StrategyRequestContext): void {
  if (upstreamPayload["service_tier"] !== undefined) {
    return;
  }

  const serviceTier = resolveRequestedServiceTier(context);
  if (serviceTier) {
    upstreamPayload["service_tier"] = serviceTier;
  }
}

function recordAttempt(
  requestLogStore: RequestLogStore,
  context: ProviderAttemptContext | LocalAttemptContext,
  values: {
    readonly providerId: string;
    readonly accountId: string;
    readonly authType: "api_key" | "oauth_bearer" | "local";
    readonly upstreamPath: string;
    readonly status: number;
    readonly latencyMs: number;
    readonly serviceTier?: string;
    readonly serviceTierSource?: "fast_mode" | "explicit" | "none";
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
    readonly promptCacheKeyUsed?: boolean;
    readonly imageCount?: number;
    readonly imageCostUsd?: number;
    readonly factoryDiagnostics?: Factory4xxDiagnostics;
    readonly error?: string;
  },
  mode: UpstreamMode
): string {
  const cost = estimateRequestCost(
    values.providerId,
    context.routedModel,
    values.promptTokens ?? 0,
    values.completionTokens ?? 0,
  );

  const attribution = kernels.resolveUsageAttribution(context.requestAuth);

  const entry = requestLogStore.record({
    tenantId: attribution.tenantId,
    issuer: attribution.issuer,
    keyId: attribution.keyId,
    providerId: values.providerId,
    accountId: values.accountId,
    authType: values.authType,
    model: context.routedModel,
    upstreamMode: mode,
    upstreamPath: values.upstreamPath,
    status: values.status,
    latencyMs: values.latencyMs,
    serviceTier: values.serviceTier,
    serviceTierSource: values.serviceTierSource,
    promptTokens: values.promptTokens,
    completionTokens: values.completionTokens,
    totalTokens: values.totalTokens,
    imageCount: values.imageCount,
    imageCostUsd: values.imageCostUsd,
    promptCacheKeyHash: kernels.promptCacheKeyHash(context.requestBody),
    promptCacheKeyUsed: values.promptCacheKeyUsed,
    ttftMs: values.latencyMs,
    factoryDiagnostics: values.factoryDiagnostics,
    error: values.error,
    costUsd: cost.costUsd,
    energyJoules: cost.energyJoules,
    waterEvaporatedMl: cost.waterEvaporatedMl,
  });

  return entry.id;
}

export function extractUsageCountsFromSseText(
  streamText: string,
  mode: UpstreamMode,
  routedModel: string,
): UsageCounts {
  return kernels.extractUsageCountsFromSseText(streamText, mode, routedModel);
}

function responseLooksLikeEventStream(response: Response, mode: UpstreamMode): boolean {
  return kernels.responseLooksLikeEventStream(response, mode);
}

function updateUsageCountsFromResponse(
  requestLogStore: RequestLogStore,
  entryId: string,
  response: Response,
  mode: UpstreamMode,
  routedModel: string,
  providerId: string,
  config: ProxyConfig,
  attemptStartedAt: number,
): Promise<void> {
  return kernels.updateUsageCountsFromResponse(
    requestLogStore, entryId, response, mode, routedModel, providerId, config, attemptStartedAt, estimateRequestCost,
  );
}

function buildCodexResponsesImagesBody(imagesBody: Record<string, unknown>): string {
  return kernels.buildCodexResponsesImagesBody(imagesBody);
}

function extractImagesFromCodexResponse(responseBody: string): Record<string, unknown> | undefined {
  return kernels.extractImagesFromCodexResponse(responseBody);
}

function extractImagesFromCodexEventStream(streamText: string): Record<string, unknown> | undefined {
  return kernels.extractImagesFromCodexEventStream(streamText);
}

function extractImagesFromResponsesOutput(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return kernels.extractImagesFromResponsesOutput(data);
}

function openAiContentToText(content: unknown): string {
  return kernels.openAiContentToText(content);
}

export type {
  UpstreamMode,
  StrategyRequestContext,
  ProviderAttemptContext,
  LocalAttemptContext,
  ProviderAttemptOutcome,
  RoutingAccumulator,
  PreferredAffinity,
  BuildPayloadResult,
  ProviderStrategy,
}
export {
  PERMANENT_DISABLE_COOLDOWN_MS,
  joinUrl,
  dedupePaths,
  sleep,
  transientRetryDelayMs,
  shouldRetrySameCredentialForServerError,
  shouldCooldownCredentialOnAuthFailure,
  shouldPermanentlyDisableCredential,
  reorderCandidatesForAffinity,
  providerAccountsForRequest,
  reorderAccountsForLatency,
  isRecord,
  asNumber,
  asString,
  asBoolean,
  updateFailedAttemptDiagnostics,
  stripTrailingAssistantPrefill,
  buildPayloadResult,
  applyProviderModelAliasToPayload,
  buildRequestBodyForUpstream,
  ensureChatCompletionsUsageInStream,
  readHeaderValue,
  parseBooleanHeader,
  resolveRequestedServiceTier,
  applyRequestedServiceTier,
  recordAttempt,
  responseLooksLikeEventStream,
  updateUsageCountsFromResponse,
  buildCodexResponsesImagesBody,
  extractImagesFromCodexResponse,
  extractImagesFromCodexEventStream,
  extractImagesFromResponsesOutput,
  openAiContentToText,
}
