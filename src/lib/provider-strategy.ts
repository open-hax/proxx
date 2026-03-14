import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import type { FastifyReply } from "fastify";

import type { ProxyConfig } from "./config.js";
import type { ProviderCredential } from "./key-pool.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { PromptAffinityStore } from "./prompt-affinity-store.js";
import type { PolicyEngine } from "./policy/index.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import { orderAccountsByPolicy } from "./provider-policy.js";
import {
  buildForwardHeaders,
  buildUpstreamHeadersForCredential,
  copyUpstreamHeaders,
  isRateLimitResponse,
  parseRetryAfterMs,
} from "./proxy.js";
import {
  chatRequestToResponsesRequest,
  chatCompletionToSse,
  responsesEventStreamToChatCompletion,
  responsesEventStreamToErrorPayload,
  responsesToChatCompletion,
  shouldUseResponsesUpstream,
  responsesOutputHasReasoning,
  writeInterleavedResponsesSse,
  extractTerminalResponseFromEventStream,
} from "./responses-compat.js";
import {
  chatRequestToMessagesRequest,
  messagesToChatCompletion,
  shouldUseMessagesUpstream,
} from "./messages-compat.js";
import {
  chatRequestToOllamaRequest,
  ollamaToChatCompletion,
} from "./ollama-compat.js";
import type { ProviderRoute } from "./provider-routing.js";
import {
  buildFactoryAnthropicHeaders,
  buildFactoryCommonHeaders,
  getFactoryEndpointPath,
  getFactoryModelType,
  inlineSystemPrompt,
  sanitizeFactorySystemPrompt,
} from "./factory-compat.js";
import {
  appendCsvHeaderValue,
  chatCompletionHasReasoningContent,
  fetchWithResponseTimeout,
  requestWantsReasoningTrace,
  responseIsEventStream,
  responseIndicatesMissingModel,
  responseIndicatesModelNotSupportedForAccount,
  responseIndicatesQuotaError,
  sendOpenAiError,
  shouldEnableInterleavedThinkingHeader,
  streamPayloadIndicatesQuotaError,
  streamPayloadHasReasoningTrace,
  streamPayloadHasSubstantiveChunks,
  summarizeUpstreamError,
  toErrorMessage,
} from "./provider-utils.js";
import { resolveRequestRoutingState } from "./provider-routing.js";
import { getTelemetry } from "./telemetry/otel.js";

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // Avoid accidental `/v1/v1/...` joins when the provider base URL already includes the OpenAI version segment.
  const baseLower = normalizedBase.toLowerCase();
  const pathLower = normalizedPath.toLowerCase();
  if (pathLower.startsWith("/v1/") && baseLower.endsWith("/v1")) {
    normalizedPath = normalizedPath.slice(3);
  }

  return `${normalizedBase}${normalizedPath}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function transientRetryDelayMs(context: StrategyRequestContext, retryIndex: number): number {
  return context.config.upstreamTransientRetryBackoffMs * (retryIndex + 1);
}

function shouldRetrySameCredentialForServerError(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function shouldCooldownCredentialOnAuthFailure(providerId: string, status: number): boolean {
  if (status === 401) {
    return true;
  }
  if (status === 403) {
    // Factory 403 often indicates request/prompt rejection rather than credential failure.
    return providerId !== "factory";
  }
  return false;
}

function reorderCandidatesForAffinity<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: PreferredAffinity | undefined,
): T[] {
  if (!preferred) {
    return [...candidates];
  }

  const preferredCandidates = candidates.filter(
    (candidate) => candidate.providerId === preferred.providerId && candidate.account.accountId === preferred.accountId,
  );
  if (preferredCandidates.length === 0) {
    return [...candidates];
  }

  const remaining = candidates.filter(
    (candidate) => candidate.providerId !== preferred.providerId || candidate.account.accountId !== preferred.accountId,
  );
  return [...preferredCandidates, ...remaining];
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
  | "local_ollama_chat";

interface StrategyRequestContext {
  readonly config: ProxyConfig;
  readonly clientHeaders: IncomingHttpHeaders;
  readonly requestBody: Record<string, unknown>;
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
  readonly modelNotFound?: boolean;
  readonly modelNotSupportedForAccount?: boolean;
}

type ProviderAttemptOutcome = ProviderAttemptOutcomeHandled | ProviderAttemptOutcomeContinue;

interface FallbackAccumulator {
  sawRateLimit: boolean;
  sawRequestError: boolean;
  sawUpstreamServerError: boolean;
  sawUpstreamInvalidRequest: boolean;
  sawModelNotFound: boolean;
  sawModelNotSupportedForAccount: boolean;
  attempts: number;
}

export interface ProviderFallbackExecutionResult {
  readonly handled: boolean;
  readonly candidateCount: number;
  readonly summary: FallbackAccumulator;
}

interface PreferredAffinity {
  readonly providerId: string;
  readonly accountId: string;
}

export interface ProviderAvailabilitySummary {
  readonly sawConfiguredProvider: boolean;
  readonly prompt_cache_key?: string;
}

interface BuildPayloadResult {
  readonly upstreamPayload: Record<string, unknown>;
  readonly bodyText: string;
  readonly serviceTier?: string;
  readonly serviceTierSource: "fast_mode" | "explicit" | "none";
}

function gptModelRequiresPaidPlan(routedModel: string): boolean {
  const match = routedModel.match(/^gpt-(\d+)(?:[.-]([a-z0-9]+))?/i);
  if (!match) {
    return false;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(major)) {
    return false;
  }

  if (major > 5) {
    return true;
  }

  if (major !== 5) {
    return false;
  }

  const qualifier = match[2];
  if (!qualifier) {
    return false;
  }

  if (/^\d+$/.test(qualifier)) {
    const minor = Number.parseInt(qualifier, 10);
    return Number.isFinite(minor) && minor >= 3;
  }

  // Non-numeric qualifiers like `gpt-5-mini` should be treated as paid-required.
  return true;
}

function providerAccountsForRequest(
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
): ProviderCredential[] {
  if (providerId !== "openai") {
    return [...accounts];
  }

  const isGptModel = routedModel.startsWith("gpt-");
  if (!isGptModel) {
    return [...accounts];
  }

  if (gptModelRequiresPaidPlan(routedModel)) {
    const stronglySupportedPlans = new Set(["plus", "pro", "business", "enterprise"]);

    const stronglySupportedAccounts = accounts.filter(
      (account) => stronglySupportedPlans.has(account.planType ?? ""),
    );

    const teamAccounts = accounts.filter((account) => account.planType === "team");

    const otherPaidAccounts = accounts.filter((account) => {
      const planType = account.planType ?? "unknown";
      if (planType === "free") {
        return false;
      }
      if (planType === "team") {
        return false;
      }
      if (stronglySupportedPlans.has(planType)) {
        return false;
      }
      return true;
    });

    const freeAccounts = accounts.filter((account) => account.planType === "free");

    return [
      ...stronglySupportedAccounts,
      ...teamAccounts,
      ...otherPaidAccounts,
      ...freeAccounts,
    ];
  }

  const freeAccounts = accounts.filter((account) => account.planType === "free");
  const nonFreeAccounts = accounts.filter((account) => account.planType !== "free");
  const prioritized = freeAccounts.length > 0
    ? [...freeAccounts, ...nonFreeAccounts]
    : [...accounts];

  return prioritized;
}

function providerAccountsForRequestWithPolicy(
  policy: PolicyEngine,
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
  context: {
    openAiPrefixed: boolean;
    localOllama: boolean;
    explicitOllama: boolean;
  },
): ProviderCredential[] {
  return orderAccountsByPolicy(policy, providerId, accounts, routedModel, context);
}

function providerUsesOpenAiChatCompletions(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === "openrouter" || normalized === "requesty";
}

function planCostTier(planType: string | undefined): number {
  const normalized = (planType ?? "").trim().toLowerCase();
  switch (normalized) {
    case "free":
      return 0;
    case "team":
      return 1;
    case "plus":
    case "pro":
    case "business":
    case "enterprise":
      return 2;
    case "unknown":
    default:
      return 1;
  }
}

function reorderAccountsForLatency(
  requestLogStore: RequestLogStore,
  providerId: string,
  accounts: readonly ProviderCredential[],
  routedModel: string,
  upstreamMode: string,
): ProviderCredential[] {
  const TTFT_GRACE_MS = 120;
  const WINDOW_SIZE = 6;

  const window = [...accounts.slice(0, WINDOW_SIZE)];
  const tail = accounts.slice(window.length);

  const perfFor = (account: ProviderCredential) => {
    return requestLogStore.getPerfSummary(providerId, account.accountId, routedModel, upstreamMode);
  };

  window.sort((a, b) => {
    const perfA = perfFor(a);
    const perfB = perfFor(b);

    const ttftA = perfA?.ewmaTtftMs ?? Number.POSITIVE_INFINITY;
    const ttftB = perfB?.ewmaTtftMs ?? Number.POSITIVE_INFINITY;

    const ttftDelta = Math.abs(ttftA - ttftB);
    if (ttftDelta > TTFT_GRACE_MS) {
      return ttftA - ttftB;
    }

    const costA = planCostTier(a.planType);
    const costB = planCostTier(b.planType);
    if (costA !== costB) {
      return costA - costB;
    }

    const tpsA = perfA?.ewmaTps ?? Number.NEGATIVE_INFINITY;
    const tpsB = perfB?.ewmaTps ?? Number.NEGATIVE_INFINITY;
    if (tpsA !== tpsB) {
      return tpsB - tpsA;
    }

    return 0;
  });

  return [...window, ...tail];
}

export interface UsageCounts {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
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

function hasExplicitServiceTierRequest(context: StrategyRequestContext): boolean {
  const openHax = isRecord(context.requestBody["open_hax"]) ? context.requestBody["open_hax"] : null;

  return Boolean(
    asString(context.requestBody["service_tier"])?.trim()
      || asString(openHax?.["service_tier"])?.trim()
      || asString(openHax?.["serviceTier"])?.trim()
      || readHeaderValue(context.clientHeaders, "x-open-hax-service-tier")?.trim(),
  );
}

function requestedFastMode(context: StrategyRequestContext): boolean {
  const openHax = isRecord(context.requestBody["open_hax"]) ? context.requestBody["open_hax"] : null;

  return Boolean(
    asBoolean(openHax?.["fast_mode"])
      ?? asBoolean(openHax?.["fastMode"])
      ?? parseBooleanHeader(readHeaderValue(context.clientHeaders, "x-open-hax-fast-mode")),
  );
}

function resolveLoggedServiceTier(
  upstreamPayload: Record<string, unknown>,
  context?: StrategyRequestContext,
): { readonly serviceTier?: string; readonly serviceTierSource: "fast_mode" | "explicit" | "none" } {
  const serviceTier = asString(upstreamPayload["service_tier"])?.trim();

  if (!serviceTier) {
    return {
      serviceTierSource: "none",
    };
  }

  if (!context) {
    return {
      serviceTier,
      serviceTierSource: "explicit",
    };
  }

  return {
    serviceTier,
    serviceTierSource: !hasExplicitServiceTierRequest(context) && requestedFastMode(context) && serviceTier === "priority"
      ? "fast_mode"
      : "explicit",
  };
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

function buildRequestBodyForUpstream(context: StrategyRequestContext): Record<string, unknown> {
  const upstreamBody: Record<string, unknown> = {
    ...context.requestBody,
  };

  if (context.routedModel !== context.requestedModelInput) {
    upstreamBody.model = context.routedModel;
  }

  delete upstreamBody["open_hax"];
  return upstreamBody;
}

function ensureChatCompletionsUsageInStream(upstreamBody: Record<string, unknown>): void {
  if (upstreamBody["stream"] !== true) {
    return;
  }

  const existing = isRecord(upstreamBody["stream_options"]) ? upstreamBody["stream_options"] : null;
  if (existing) {
    if (existing["include_usage"] === undefined) {
      existing["include_usage"] = true;
    }
    return;
  }

  upstreamBody["stream_options"] = { include_usage: true };
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
  const openHax = isRecord(context.requestBody["open_hax"]) ? context.requestBody["open_hax"] : null;

  const explicitServiceTier = asString(openHax?.["service_tier"]) ?? asString(openHax?.["serviceTier"]);
  if (explicitServiceTier?.trim()) {
    return explicitServiceTier.trim();
  }

  const headerServiceTier = readHeaderValue(context.clientHeaders, "x-open-hax-service-tier")?.trim();
  if (headerServiceTier) {
    return headerServiceTier;
  }

  const fastMode = asBoolean(openHax?.["fast_mode"])
    ?? asBoolean(openHax?.["fastMode"])
    ?? parseBooleanHeader(readHeaderValue(context.clientHeaders, "x-open-hax-fast-mode"));

  if (fastMode) {
    return "priority";
  }

  return undefined;
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
    readonly error?: string;
  },
  mode: UpstreamMode
): string {
  const entry = requestLogStore.record({
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
    promptCacheKeyUsed: values.promptCacheKeyUsed,
    ttftMs: values.latencyMs,
    error: values.error
  });

  return entry.id;
}

function cachedPromptTokensFromUsage(usage: Record<string, unknown>): number | undefined {
  const direct = asNumber(usage["cached_tokens"]);
  if (direct !== undefined) {
    return direct;
  }

  const promptDetails = isRecord(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : null;
  const cachedFromPromptDetails = promptDetails ? asNumber(promptDetails["cached_tokens"]) : undefined;
  if (cachedFromPromptDetails !== undefined) {
    return cachedFromPromptDetails;
  }

  const inputDetails = isRecord(usage["input_tokens_details"]) ? usage["input_tokens_details"] : null;
  const cachedFromInputDetails = inputDetails ? asNumber(inputDetails["cached_tokens"]) : undefined;
  if (cachedFromInputDetails !== undefined) {
    return cachedFromInputDetails;
  }

  return undefined;
}

function usageCountsFromCompletion(completion: Record<string, unknown>): UsageCounts {
  const usage = isRecord(completion["usage"]) ? completion["usage"] : null;
  if (!usage) {
    return {};
  }

  const promptTokens = asNumber(usage["prompt_tokens"]);
  const completionTokens = asNumber(usage["completion_tokens"]);
  const totalTokens = asNumber(usage["total_tokens"])
    ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const cachedPromptTokens = cachedPromptTokensFromUsage(usage);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
  };
}

function usageCountsFromUpstreamJson(upstreamJson: unknown, routedModel: string): UsageCounts {
  if (!isRecord(upstreamJson)) {
    return {};
  }

  try {
    return usageCountsFromCompletion(responsesToChatCompletion(upstreamJson, routedModel));
  } catch {
    try {
      return usageCountsFromCompletion(messagesToChatCompletion(upstreamJson, routedModel));
    } catch {
      try {
        return usageCountsFromCompletion(ollamaToChatCompletion(upstreamJson, routedModel));
      } catch {
        return usageCountsFromCompletion(upstreamJson);
      }
    }
  }
}

function usageCountsFromGeminiResponse(upstreamJson: Record<string, unknown>): UsageCounts {
  const usageMetadata = isRecord(upstreamJson["usageMetadata"]) ? upstreamJson["usageMetadata"] : null;
  if (!usageMetadata) {
    return {};
  }

  const promptTokens = asNumber(usageMetadata["promptTokenCount"]);
  const completionTokens = asNumber(usageMetadata["candidatesTokenCount"]);
  const totalTokens = asNumber(usageMetadata["totalTokenCount"]);

  return { promptTokens, completionTokens, totalTokens };
}

function usageCountsForMode(mode: UpstreamMode, upstreamJson: unknown, routedModel: string): UsageCounts {
  if (!isRecord(upstreamJson)) {
    return {};
  }

  if (mode === "messages") {
    return usageCountsFromCompletion(messagesToChatCompletion(upstreamJson, routedModel));
  }

  if (
    mode === "responses"
    || mode === "openai_responses"
    || mode === "responses_passthrough"
    || mode === "openai_responses_passthrough"
  ) {
    return usageCountsFromCompletion(responsesToChatCompletion(upstreamJson, routedModel));
  }

  if (mode === "gemini_chat") {
    return usageCountsFromGeminiResponse(upstreamJson);
  }

  if (mode === "ollama_chat" || mode === "local_ollama_chat") {
    return usageCountsFromCompletion(ollamaToChatCompletion(upstreamJson, routedModel));
  }

  return usageCountsFromUpstreamJson(upstreamJson, routedModel);
}

/**
 * Parse SSE stream text to extract token usage counts.
 *
 * Handles four distinct SSE wire formats:
 *
 * 1. **OpenAI Chat Completions** (`chat_completions`, `openai_chat_completions`):
 *    The final chunk before `data: [DONE]` carries a `usage` object with
 *    `prompt_tokens`, `completion_tokens`, `total_tokens` when the request
 *    included `stream_options.include_usage: true`.
 *
 * 2. **Anthropic Messages** (`messages`):
 *    `message_start` contains `message.usage.input_tokens`;
 *    `message_delta` contains `usage.output_tokens`.
 *
 * 3. **OpenAI Responses** (`responses`, `openai_responses`):
 *    `response.completed` events embed the full response object which includes
 *    `usage.input_tokens`, `usage.output_tokens`, `usage.total_tokens`.
 *
 * 4. **Ollama** (`ollama_chat`, `local_ollama_chat`):
 *    Newline-delimited JSON; the final object with `done: true` carries
 *    `prompt_eval_count` and `eval_count`.
 *
 * Returns `{}` (no usage) when the stream does not contain usage data — this
 * is the expected path for providers that omit it.  Never throws.
 */
export function extractUsageCountsFromSseText(
  streamText: string,
  mode: UpstreamMode,
  routedModel: string,
): UsageCounts {
  try {
    if (mode === "messages") {
      return extractUsageFromAnthropicSse(streamText);
    }

    if (
      mode === "responses"
      || mode === "openai_responses"
      || mode === "responses_passthrough"
      || mode === "openai_responses_passthrough"
    ) {
      return extractUsageFromResponsesSse(streamText, routedModel);
    }

    if (mode === "gemini_chat") {
      return extractUsageFromGeminiStream(streamText);
    }

    if (mode === "ollama_chat" || mode === "local_ollama_chat") {
      return extractUsageFromOllamaNdjson(streamText);
    }

    // chat_completions / openai_chat_completions — standard OpenAI SSE
    return extractUsageFromOpenAiChatSse(streamText);
  } catch {
    return {};
  }
}

function extractUsageFromGeminiStream(streamText: string): UsageCounts {
  let lastPayload: Record<string, unknown> | undefined;

  for (const line of streamText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed === "data: [DONE]" || trimmed === "[DONE]") {
      continue;
    }

    const jsonText = trimmed.startsWith("data:")
      ? trimmed.slice("data:".length).trim()
      : trimmed;

    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (isRecord(parsed)) {
        lastPayload = parsed;
      }
    } catch {
      // ignore parse errors while scanning stream
    }
  }

  return lastPayload ? usageCountsFromGeminiResponse(lastPayload) : {};
}

function extractUsageFromOpenAiChatSse(streamText: string): UsageCounts {
  const lines = streamText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("data: ") || line === "data: [DONE]") {
      continue;
    }

    try {
      const payload: unknown = JSON.parse(line.slice(6));
      if (!isRecord(payload)) continue;
      const usage = isRecord(payload["usage"]) ? payload["usage"] : null;
      if (!usage) continue;

      const promptTokens = asNumber(usage["prompt_tokens"]);
      const completionTokens = asNumber(usage["completion_tokens"]);
      const totalTokens = asNumber(usage["total_tokens"])
        ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);

      if (promptTokens !== undefined || completionTokens !== undefined) {
        return { promptTokens, completionTokens, totalTokens };
      }
    } catch {
      continue;
    }
  }

  return {};
}

function extractUsageFromAnthropicSse(streamText: string): UsageCounts {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const chunks = streamText.split("\n\n");
  for (const chunk of chunks) {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;

    try {
      const payload: unknown = JSON.parse(dataLine.slice(6));
      if (!isRecord(payload)) continue;
      const type = asString(payload["type"]);

      if (type === "message_start") {
        const message = isRecord(payload["message"]) ? payload["message"] : null;
        const usage = message && isRecord(message["usage"]) ? message["usage"] : null;
        if (usage) {
          inputTokens = asNumber(usage["input_tokens"]) ?? inputTokens;
        }
      }

      if (type === "message_delta") {
        const usage = isRecord(payload["usage"]) ? payload["usage"] : null;
        if (usage) {
          outputTokens = asNumber(usage["output_tokens"]) ?? outputTokens;
        }
      }
    } catch {
      continue;
    }
  }

  if (inputTokens === undefined && outputTokens === undefined) {
    return {};
  }

  const promptTokens = inputTokens;
  const completionTokens = outputTokens ?? 0;
  const totalTokens = (promptTokens ?? 0) + completionTokens;

  return { promptTokens, completionTokens, totalTokens };
}

function extractUsageFromResponsesSse(streamText: string, routedModel: string): UsageCounts {
  try {
    const chatCompletion = responsesEventStreamToChatCompletion(streamText, routedModel);
    return usageCountsFromCompletion(chatCompletion);
  } catch {
    return {};
  }
}

function extractUsageFromOllamaNdjson(streamText: string): UsageCounts {
  const lines = streamText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const payload: unknown = JSON.parse(line);
      if (!isRecord(payload)) continue;
      if (payload["done"] !== true) continue;

      const promptTokens = asNumber(payload["prompt_eval_count"]);
      const completionTokens = asNumber(payload["eval_count"]);
      if (promptTokens !== undefined && completionTokens !== undefined) {
        return {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        };
      }
    } catch {
      continue;
    }
  }

  return {};
}

async function extractUsageCounts(
  response: Response,
  mode: UpstreamMode,
  routedModel: string,
): Promise<UsageCounts> {
  if (!response.ok) {
    return {};
  }

  if (responseIsEventStream(response)) {
    try {
      const streamText = await response.clone().text();
      return extractUsageCountsFromSseText(streamText, mode, routedModel);
    } catch {
      return {};
    }
  }

  try {
    const upstreamJson: unknown = await response.clone().json();
    return usageCountsForMode(mode, upstreamJson, routedModel);
  } catch {
    return {};
  }
}

async function updateUsageCountsFromResponse(
  requestLogStore: RequestLogStore,
  entryId: string,
  response: Response,
  mode: UpstreamMode,
  routedModel: string,
): Promise<void> {
  const readStartedAt = Date.now();
  const usageCounts = await extractUsageCounts(response, mode, routedModel);
  const readDurationMs = Math.max(0, Date.now() - readStartedAt);

  if (
    usageCounts.promptTokens === undefined
    && usageCounts.completionTokens === undefined
    && usageCounts.totalTokens === undefined
    && usageCounts.cachedPromptTokens === undefined
  ) {
    return;
  }

  const isStream = responseIsEventStream(response);
  const tps = isStream
    && typeof usageCounts.completionTokens === "number"
    && Number.isFinite(usageCounts.completionTokens)
    && usageCounts.completionTokens > 0
    && readDurationMs > 0
      ? usageCounts.completionTokens / (readDurationMs / 1000)
      : undefined;

  requestLogStore.update(entryId, {
    ...usageCounts,
    cacheHit: typeof usageCounts.cachedPromptTokens === "number" && usageCounts.cachedPromptTokens > 0,
    tps,
  });
}

abstract class BaseProviderStrategy implements ProviderStrategy {
  public abstract readonly mode: UpstreamMode;
  public abstract readonly isLocal: boolean;

  public abstract matches(context: StrategyRequestContext): boolean;

  public abstract getUpstreamPath(context: StrategyRequestContext): string;

  public abstract buildPayload(context: StrategyRequestContext): BuildPayloadResult;

  public applyRequestHeaders(_headers: Headers, _context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    // default no-op
  }

  public async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    return this.handleStandardProviderAttempt(reply, response, context);
  }

  public async handleLocalAttempt(reply: FastifyReply, response: Response, context: LocalAttemptContext): Promise<void> {
    await this.handleStandardLocalAttempt(reply, response, context);
  }

  protected async handleStandardProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    if (upstreamResponse.ok) {
      return this.handleSuccessfulProviderAttempt(reply, upstreamResponse, context);
    }

    const isMissingModel = await responseIndicatesMissingModel(upstreamResponse, context.routedModel);
    if (isMissingModel) {
      try {
        await upstreamResponse.arrayBuffer();
      } catch {
        // Ignore body read failures while failing over.
      }

      return {
        kind: "continue",
        modelNotFound: true
      };
    }

    const modelNotSupportedForAccount = await responseIndicatesModelNotSupportedForAccount(upstreamResponse, context.routedModel);
    if (modelNotSupportedForAccount) {
      try {
        await upstreamResponse.arrayBuffer();
      } catch {
        // Ignore body read failures while failing over.
      }

      return {
        kind: "continue",
        modelNotSupportedForAccount: true,
        requestError: true
      };
    }

    if (upstreamResponse.status === 400 || upstreamResponse.status === 422) {
      try {
        await upstreamResponse.text();
      } catch {
        // Ignore body read failures while failing over.
      }
      return {
        kind: "continue",
        requestError: true,
        upstreamInvalidRequest: true
      };
    }

    try {
      await upstreamResponse.arrayBuffer();
    } catch {
      // Ignore body read failures while failing over.
    }

    return {
      kind: "continue",
      requestError: true
    };
  }

  protected async handleStandardLocalAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: LocalAttemptContext
  ): Promise<void> {
    if (!upstreamResponse.ok) {
      reply.code(upstreamResponse.status);
      copyUpstreamHeaders(reply, upstreamResponse.headers);

      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      const isEventStream = contentType.toLowerCase().includes("text/event-stream");

      if (!upstreamResponse.body) {
        const responseText = await upstreamResponse.text();
        reply.send(responseText);
        return;
      }

      if (isEventStream) {
        const stream = Readable.fromWeb(upstreamResponse.body as never);
        reply.removeHeader("content-length");
        reply.send(stream);
        return;
      }

      const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
      reply.send(bytes);
      return;
    }

    reply.code(upstreamResponse.status);
    copyUpstreamHeaders(reply, upstreamResponse.headers);

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const isEventStream = contentType.toLowerCase().includes("text/event-stream");

    if (!upstreamResponse.body) {
      const responseText = await upstreamResponse.text();
      reply.send(responseText);
      return;
    }

    if (isEventStream) {
      const stream = Readable.fromWeb(upstreamResponse.body as never);
      reply.removeHeader("content-length");
      reply.send(stream);
      return;
    }

    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    reply.send(bytes);
  }

  private async handleSuccessfulProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    if (!context.clientWantsStream && context.needsReasoningTrace) {
      let upstreamJson: unknown;
      try {
        upstreamJson = await upstreamResponse.json();
      } catch {
        return {
          kind: "continue",
          requestError: true
        };
      }

      const hasReasoning = isRecord(upstreamJson) && chatCompletionHasReasoningContent(upstreamJson);
      if (!hasReasoning && context.hasMoreCandidates) {
        return {
          kind: "continue",
          requestError: true
        };
      }

      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.code(upstreamResponse.status);
      copyUpstreamHeaders(reply, upstreamResponse.headers);
      reply.header("content-type", "application/json");
      reply.send(upstreamJson);
      return { kind: "handled" };
    }

    if (context.clientWantsStream) {
      if (!upstreamResponse.body) {
        return {
          kind: "continue",
          requestError: true
        };
      }

      const streamText = await upstreamResponse.text();
      if (streamPayloadIndicatesQuotaError(streamText) && context.hasMoreCandidates) {
        return {
          kind: "continue",
          rateLimit: true
        };
      }

      if (!streamPayloadHasSubstantiveChunks(streamText) && context.hasMoreCandidates) {
        return {
          kind: "continue",
          requestError: true
        };
      }

      if (context.needsReasoningTrace && !streamPayloadHasReasoningTrace(streamText) && context.hasMoreCandidates) {
        return {
          kind: "continue",
          requestError: true
        };
      }

      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.code(upstreamResponse.status);
      copyUpstreamHeaders(reply, upstreamResponse.headers);
      reply.removeHeader("content-length");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.hijack();
      const rawResponse = reply.raw;
      rawResponse.statusCode = upstreamResponse.status;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          rawResponse.setHeader(name, value as never);
        }
      }
      rawResponse.flushHeaders();
      rawResponse.write(streamText);
      rawResponse.end();
      return { kind: "handled" };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);
    reply.code(upstreamResponse.status);
    copyUpstreamHeaders(reply, upstreamResponse.headers);

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const isEventStream = contentType.toLowerCase().includes("text/event-stream");

    if (!upstreamResponse.body) {
      const responseText = await upstreamResponse.text();
      reply.send(responseText);
      return { kind: "handled" };
    }

    if (isEventStream) {
      const stream = Readable.fromWeb(upstreamResponse.body as never);
      reply.removeHeader("content-length");
      reply.send(stream);
      return { kind: "handled" };
    }

    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    reply.send(bytes);
    return { kind: "handled" };
  }
}

class LocalOllamaProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "local_ollama_chat" as const;

  public readonly isLocal = true;

  public matches(context: StrategyRequestContext): boolean {
    return context.localOllama && !context.explicitOllama;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.ollamaV1ChatPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = buildRequestBodyForUpstream(context);
    return buildPayloadResult(upstreamPayload);
  }

  public override async handleLocalAttempt(reply: FastifyReply, upstreamResponse: Response, context: LocalAttemptContext): Promise<void> {
    if (!upstreamResponse.ok) {
      await this.handleStandardLocalAttempt(reply, upstreamResponse, context);
      return;
    }

    if (context.clientWantsStream) {
      let upstreamJson: unknown;
      try {
        upstreamJson = await upstreamResponse.json();
      } catch (error) {
        sendOpenAiError(
          reply,
          502,
          `Failed to parse Ollama stream bootstrap payload: ${toErrorMessage(error)}`,
          "server_error",
          "ollama_stream_parse_failed"
        );
        return;
      }

      const chatCompletion = ollamaToChatCompletion(upstreamJson, context.routedModel);
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return;
    }

    await this.handleStandardLocalAttempt(reply, upstreamResponse, context);
  }
}

class OllamaProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "ollama_chat" as const;

  public readonly isLocal = true;

  public matches(context: StrategyRequestContext): boolean {
    return context.explicitOllama;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.ollamaChatPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildPayloadResult(chatRequestToOllamaRequest(context.requestBody, context.config.ollamaModelPrefixes), context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: LocalAttemptContext
  ): Promise<void> {
    if (!upstreamResponse.ok) {
      await this.handleStandardLocalAttempt(reply, upstreamResponse, context);
      return;
    }

    let upstreamJson: unknown;
    try {
      upstreamJson = await upstreamResponse.json();
    } catch (error) {
      const code = context.clientWantsStream ? "ollama_stream_parse_failed" : "ollama_parse_failed";
      const label = context.clientWantsStream ? "stream bootstrap payload" : "upstream payload";
      sendOpenAiError(
        reply,
        502,
        `Failed to parse Ollama ${label}: ${toErrorMessage(error)}`,
        "server_error",
        code
      );
      return;
    }

    const chatCompletion = ollamaToChatCompletion(upstreamJson, context.routedModel);

    if (context.clientWantsStream) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return;
    }

    reply.header("content-type", "application/json");
    reply.send(chatCompletion);
  }
}

abstract class TransformedJsonProviderStrategy extends BaseProviderStrategy {
  protected abstract convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown>;

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    if (!upstreamResponse.ok) {
      return this.handleStandardProviderAttempt(reply, upstreamResponse, context);
    }

    let upstreamJson: unknown;
    try {
      upstreamJson = await upstreamResponse.json();
    } catch {
      return {
        kind: "continue",
        requestError: true
      };
    }

    const chatCompletion = this.convertResponseToChatCompletion(upstreamJson, context.routedModel);
    if (context.needsReasoningTrace && !chatCompletionHasReasoningContent(chatCompletion) && context.hasMoreCandidates) {
      return {
        kind: "continue",
        requestError: true
      };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);
    if (context.clientWantsStream) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return { kind: "handled" };
    }

    reply.code(upstreamResponse.status);
    reply.header("content-type", "application/json");
    reply.send(chatCompletion);
    return { kind: "handled" };
  }
}

class MessagesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "messages" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return !context.localOllama
      && !context.openAiPrefixed
      && shouldUseMessagesUpstream(context.routedModel, context.config.messagesModelPrefixes);
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.messagesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildPayloadResult(chatRequestToMessagesRequest(buildRequestBodyForUpstream(context)), context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void {
    if (context.config.messagesInterleavedThinkingBeta && shouldEnableInterleavedThinkingHeader(payload)) {
      appendCsvHeaderValue(headers, "anthropic-beta", context.config.messagesInterleavedThinkingBeta);
    }
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    return messagesToChatCompletion(upstreamJson, routedModel);
  }
}

class ResponsesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "responses" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return !context.localOllama
      && !context.explicitOllama
      && !context.openAiPrefixed
      && shouldUseResponsesUpstream(context.routedModel, context.config.responsesModelPrefixes);
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.responsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = chatRequestToResponsesRequest(buildRequestBodyForUpstream(context));
    applyRequestedServiceTier(upstreamPayload, context);
    return buildPayloadResult(upstreamPayload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    if (!upstreamResponse.ok) {
      return this.handleStandardProviderAttempt(reply, upstreamResponse, context);
    }

    let upstreamJson: unknown;
    try {
      upstreamJson = await upstreamResponse.json();
    } catch {
      return {
        kind: "continue",
        requestError: true
      };
    }

    if (!isRecord(upstreamJson)) {
      return {
        kind: "continue",
        requestError: true
      };
    }

    const chatCompletion = this.convertResponseToChatCompletion(upstreamJson, context.routedModel);
    if (context.needsReasoningTrace && !chatCompletionHasReasoningContent(chatCompletion) && context.hasMoreCandidates) {
      return {
        kind: "continue",
        requestError: true
      };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);

    if (context.clientWantsStream && responsesOutputHasReasoning(upstreamJson)) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.hijack();
      const rawResponse = reply.raw;
      rawResponse.statusCode = 200;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          rawResponse.setHeader(name, value as never);
        }
      }
      rawResponse.flushHeaders();
      await writeInterleavedResponsesSse(upstreamJson, context.routedModel, (data) => rawResponse.write(data));
      rawResponse.end();
      return { kind: "handled" };
    }

    if (context.clientWantsStream) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return { kind: "handled" };
    }

    reply.code(upstreamResponse.status);
    reply.header("content-type", "application/json");
    reply.send(chatCompletion);
    return { kind: "handled" };
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    return responsesToChatCompletion(upstreamJson, routedModel);
  }
}

class OpenAiResponsesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "openai_responses" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.openAiPrefixed
      && (context.routedModel === "gpt-5.4"
        || shouldUseResponsesUpstream(context.routedModel, context.config.responsesModelPrefixes));
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.openaiResponsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = chatRequestToResponsesRequest(buildRequestBodyForUpstream(context));
    applyRequestedServiceTier(upstreamPayload, context);
    upstreamPayload["store"] = false;
    upstreamPayload["stream"] = true;
    return buildPayloadResult(upstreamPayload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const looksLikeEventStream = contentType.toLowerCase().includes("text/event-stream")
      || contentType.length === 0;

    if (!upstreamResponse.ok || !looksLikeEventStream) {
      return super.handleProviderAttempt(reply, upstreamResponse, context);
    }

    const streamText = await upstreamResponse.text();
    const upstreamError = responsesEventStreamToErrorPayload(streamText);
    if (upstreamError) {
      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.code(400);
      reply.header("content-type", "application/json");
      reply.send({ error: upstreamError });
      return { kind: "handled" };
    }

    let chatCompletion: Record<string, unknown>;
    try {
      chatCompletion = responsesEventStreamToChatCompletion(streamText, context.routedModel);
    } catch {
      return {
        kind: "continue",
        requestError: true
      };
    }

    if (context.needsReasoningTrace && !chatCompletionHasReasoningContent(chatCompletion) && context.hasMoreCandidates) {
      return {
        kind: "continue",
        requestError: true
      };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);

    if (context.clientWantsStream) {
      const terminalResponse = extractTerminalResponseFromEventStream(streamText);
      if (terminalResponse && responsesOutputHasReasoning(terminalResponse)) {
        reply.code(200);
        reply.header("content-type", "text/event-stream; charset=utf-8");
        reply.header("cache-control", "no-cache");
        reply.header("x-accel-buffering", "no");
        reply.hijack();
        const rawResponse = reply.raw;
        rawResponse.statusCode = 200;
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) {
            rawResponse.setHeader(name, value as never);
          }
        }
        rawResponse.flushHeaders();
        await writeInterleavedResponsesSse(terminalResponse, context.routedModel, (data) => rawResponse.write(data));
        rawResponse.end();
        return { kind: "handled" };
      }

      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return { kind: "handled" };
    }

    reply.code(200);
    reply.header("content-type", "application/json");
    reply.send(chatCompletion);
    return { kind: "handled" };
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    return responsesToChatCompletion(upstreamJson, routedModel);
  }
}

class OpenAiChatCompletionsProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "openai_chat_completions" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.openAiPrefixed;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.openaiChatCompletionsPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = buildRequestBodyForUpstream(context);
    ensureChatCompletionsUsageInStream(upstreamPayload);
    return buildPayloadResult(upstreamPayload, context);
  }
}

class ChatCompletionsProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "chat_completions" as const;

  public readonly isLocal = false;

  public matches(_context: StrategyRequestContext): boolean {
    return true;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.chatCompletionsPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = buildRequestBodyForUpstream(context);
    ensureChatCompletionsUsageInStream(upstreamPayload);
    return buildPayloadResult(upstreamPayload, context);
  }
}

class ImagesGenerationsPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "images" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.imagesPassthrough === true;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.imagesGenerationsPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload: Record<string, unknown> = { ...context.requestBody };
    delete upstreamPayload["open_hax"];
    return buildPayloadResult(upstreamPayload, context);
  }
}

class ResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "responses_passthrough" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.responsesPassthrough === true && !context.openAiPrefixed;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.responsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload: Record<string, unknown> = { ...context.requestBody };
    delete upstreamPayload["open_hax"];
    return buildPayloadResult(upstreamPayload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    if (!upstreamResponse.ok) {
      return this.handleStandardProviderAttempt(reply, upstreamResponse, context);
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const isEventStream = contentType.toLowerCase().includes("text/event-stream");

    reply.header("x-open-hax-upstream-provider", context.providerId);
    reply.code(upstreamResponse.status);
    copyUpstreamHeaders(reply, upstreamResponse.headers);

    if (isEventStream) {
      if (!upstreamResponse.body) {
        return { kind: "continue", requestError: true };
      }

      reply.removeHeader("content-length");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.hijack();
      const rawResponse = reply.raw;
      rawResponse.statusCode = upstreamResponse.status;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          rawResponse.setHeader(name, value as never);
        }
      }
      rawResponse.flushHeaders();
      const nodeStream = Readable.fromWeb(upstreamResponse.body as never);
      nodeStream.on("error", () => {
        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
      });
      nodeStream.pipe(rawResponse);
      return { kind: "handled" };
    }

    if (!upstreamResponse.body) {
      const responseText = await upstreamResponse.text();
      reply.send(responseText);
      return { kind: "handled" };
    }

    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    reply.send(bytes);
    return { kind: "handled" };
  }
}

class OpenAiResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "openai_responses_passthrough" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.responsesPassthrough === true && context.openAiPrefixed;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.openaiResponsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload: Record<string, unknown> = { ...context.requestBody };
    delete upstreamPayload["open_hax"];
    upstreamPayload["store"] = false;
    upstreamPayload["stream"] = true;
    if (upstreamPayload["instructions"] === undefined) {
      upstreamPayload["instructions"] = "";
    }
    return buildPayloadResult(upstreamPayload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const looksLikeEventStream = contentType.toLowerCase().includes("text/event-stream")
      || contentType.length === 0;

    if (!upstreamResponse.ok && !looksLikeEventStream) {
      return this.handleStandardProviderAttempt(reply, upstreamResponse, context);
    }

    if (!upstreamResponse.ok) {
      const streamText = await upstreamResponse.text();
      const upstreamError = responsesEventStreamToErrorPayload(streamText);
      if (upstreamError) {
        reply.header("x-open-hax-upstream-provider", context.providerId);
        reply.code(400);
        reply.header("content-type", "application/json");
        reply.send({ error: upstreamError });
        return { kind: "handled" };
      }

      return { kind: "continue", requestError: true };
    }

    if (context.clientWantsStream && looksLikeEventStream) {
      if (!upstreamResponse.body) {
        return { kind: "continue", requestError: true };
      }

      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.code(upstreamResponse.status);
      copyUpstreamHeaders(reply, upstreamResponse.headers);

      reply.removeHeader("content-length");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.hijack();
      const rawResponse = reply.raw;
      rawResponse.statusCode = upstreamResponse.status;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          rawResponse.setHeader(name, value as never);
        }
      }
      rawResponse.flushHeaders();
      const nodeStream = Readable.fromWeb(upstreamResponse.body as never);
      nodeStream.on("error", () => {
        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
      });
      nodeStream.pipe(rawResponse);
      return { kind: "handled" };
    }

    if (looksLikeEventStream) {
      const streamText = await upstreamResponse.text();
      const upstreamError = responsesEventStreamToErrorPayload(streamText);
      if (upstreamError) {
        reply.header("x-open-hax-upstream-provider", context.providerId);
        reply.code(400);
        reply.header("content-type", "application/json");
        reply.send({ error: upstreamError });
        return { kind: "handled" };
      }

      const terminalResponse = extractTerminalResponseFromEventStream(streamText);
      if (!terminalResponse) {
        return { kind: "continue", requestError: true };
      }

      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.code(200);
      reply.header("content-type", "application/json");
      reply.send(terminalResponse);
      return { kind: "handled" };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);
    reply.code(upstreamResponse.status);
    copyUpstreamHeaders(reply, upstreamResponse.headers);

    if (!upstreamResponse.body) {
      const responseText = await upstreamResponse.text();
      reply.send(responseText);
      return { kind: "handled" };
    }

    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    reply.send(bytes);
    return { kind: "handled" };
  }
}

/**
 * Factory.ai Anthropic Messages strategy.
 *
 * Routes claude-* models to Factory's `/api/llm/a/v1/messages` endpoint,
 * translating OpenAI chat format to Anthropic Messages format and back.
 * Adds all Factory-specific headers and handles system prompt inlining for fk- keys.
 */
class FactoryMessagesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "messages" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.factoryPrefixed
      && getFactoryModelType(context.routedModel) === "anthropic";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("anthropic");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const messagesPayload = chatRequestToMessagesRequest(buildRequestBodyForUpstream(context));
    const rawSystem = messagesPayload["system"];
    const sanitizedSystem = typeof rawSystem === "string" ? sanitizeFactorySystemPrompt(rawSystem) : rawSystem;
    const sanitizedPayload = sanitizedSystem === rawSystem
      ? messagesPayload
      : {
          ...messagesPayload,
          system: sanitizedSystem,
        };
    // Inline system content into first user message to avoid Factory 403 with fk- keys.
    // We always inline for Factory to keep behavior consistent across credential types.
    const inlinedPayload = inlineSystemPrompt(sanitizedPayload);
    return buildPayloadResult(inlinedPayload, context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void {
    const anthropicHeaders = buildFactoryAnthropicHeaders(
      context.routedModel,
      payload,
      context.config.messagesInterleavedThinkingBeta,
    );
    for (const [name, value] of Object.entries(anthropicHeaders)) {
      headers.set(name, value);
    }
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    return messagesToChatCompletion(upstreamJson, routedModel);
  }
}

/**
 * Factory.ai OpenAI Responses strategy.
 *
 * Routes gpt-* models to Factory's `/api/llm/o/v1/responses` endpoint,
 * translating OpenAI chat format to Responses format and back.
 * Adds Factory-specific headers. Streaming handled via Responses event stream translation.
 */
class FactoryResponsesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "responses" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.factoryPrefixed
      && getFactoryModelType(context.routedModel) === "openai";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("openai");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = chatRequestToResponsesRequest(buildRequestBodyForUpstream(context));
    applyRequestedServiceTier(upstreamPayload, context);
    upstreamPayload["store"] = false;
    upstreamPayload["stream"] = true;
    return buildPayloadResult(upstreamPayload, context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    const factoryHeaders = buildFactoryCommonHeaders(context.routedModel);
    for (const [name, value] of Object.entries(factoryHeaders)) {
      headers.set(name, value);
    }
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const looksLikeEventStream = contentType.toLowerCase().includes("text/event-stream")
      || contentType.length === 0;

    if (!upstreamResponse.ok || !looksLikeEventStream) {
      return super.handleProviderAttempt(reply, upstreamResponse, context);
    }

    const streamText = await upstreamResponse.text();
    const upstreamError = responsesEventStreamToErrorPayload(streamText);
    if (upstreamError) {
      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.code(400);
      reply.header("content-type", "application/json");
      reply.send({ error: upstreamError });
      return { kind: "handled" };
    }

    let chatCompletion: Record<string, unknown>;
    try {
      chatCompletion = responsesEventStreamToChatCompletion(streamText, context.routedModel);
    } catch {
      return {
        kind: "continue",
        requestError: true
      };
    }

    if (context.needsReasoningTrace && !chatCompletionHasReasoningContent(chatCompletion) && context.hasMoreCandidates) {
      return {
        kind: "continue",
        requestError: true
      };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);
    if (context.clientWantsStream) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return { kind: "handled" };
    }

    reply.code(200);
    reply.header("content-type", "application/json");
    reply.send(chatCompletion);
    return { kind: "handled" };
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    return responsesToChatCompletion(upstreamJson, routedModel);
  }
}

/**
 * Factory.ai Common Chat Completions strategy.
 *
 * Routes non-Claude, non-GPT models (gemini, glm, kimi, DeepSeek, etc.)
 * to Factory's `/api/llm/o/v1/chat/completions` endpoint.
 * Passes through standard chat completions format with Factory-specific headers.
 */
class FactoryChatCompletionsProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "chat_completions" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.factoryPrefixed
      && getFactoryModelType(context.routedModel) === "common";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("common");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildPayloadResult(buildRequestBodyForUpstream(context), context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    const factoryHeaders = buildFactoryCommonHeaders(context.routedModel);
    for (const [name, value] of Object.entries(factoryHeaders)) {
      headers.set(name, value);
    }
  }
}

function openAiContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

class GeminiChatProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "gemini_chat" as const;

  public readonly isLocal = false;

  public matches(_context: StrategyRequestContext): boolean {
    // Selected explicitly in selectRemoteProviderStrategyForRoute for providerId === "gemini".
    return false;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    const model = encodeURIComponent(context.routedModel);
    return `/models/${model}:generateContent`;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamBody = buildRequestBodyForUpstream(context);
    const rawMessages = Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [];

    const contents: Array<{ readonly role: string; readonly parts: Array<{ readonly text: string }> }> = [];
    const systemParts: string[] = [];

    for (const message of rawMessages) {
      if (!isRecord(message)) {
        continue;
      }

      const role = asString(message.role)?.trim().toLowerCase() ?? "";
      const text = openAiContentToText(message.content).trim();
      if (text.length === 0) {
        continue;
      }

      if (role === "system") {
        systemParts.push(text);
        continue;
      }

      if (role === "user") {
        contents.push({ role: "user", parts: [{ text }] });
        continue;
      }

      if (role === "assistant") {
        contents.push({ role: "model", parts: [{ text }] });
        continue;
      }
    }

    const generationConfig: Record<string, unknown> = {};
    const temperature = asNumber(upstreamBody.temperature);
    if (temperature !== undefined) {
      generationConfig.temperature = temperature;
    }
    const maxTokens = asNumber(upstreamBody.max_output_tokens)
      ?? asNumber(upstreamBody.max_tokens)
      ?? asNumber(upstreamBody.maxTokens);
    if (maxTokens !== undefined) {
      generationConfig.maxOutputTokens = maxTokens;
    }

    const payload: Record<string, unknown> = {
      contents,
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = {
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    return buildPayloadResult(payload, context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    // Gemini uses API key auth (X-Goog-Api-Key header) rather than OpenAI bearer headers.
    headers.delete("authorization");
    headers.set("x-goog-api-key", context.account.token);
    headers.set("content-type", "application/json");
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    const created = Math.floor(Date.now() / 1000);

    if (!isRecord(upstreamJson)) {
      return {
        id: `chatcmpl-gemini-${created}`,
        object: "chat.completion",
        created,
        model: routedModel,
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      };
    }

    const candidates = Array.isArray(upstreamJson.candidates) ? upstreamJson.candidates : [];
    const firstCandidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : undefined;
    const candidateContent = firstCandidate && isRecord(firstCandidate.content) ? firstCandidate.content : undefined;
    const parts = candidateContent && Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
    const text = parts
      .map((part) => (isRecord(part) ? asString(part.text) ?? "" : ""))
      .join("")
      .trim();

    const finishReasonRaw = firstCandidate ? asString(firstCandidate.finishReason) ?? asString(firstCandidate.finish_reason) : undefined;
    const finishReason = finishReasonRaw
      ? finishReasonRaw.toLowerCase() === "stop"
        ? "stop"
        : finishReasonRaw.toLowerCase() === "max_tokens"
          ? "length"
          : "stop"
      : "stop";

    const usageMetadata = isRecord(upstreamJson.usageMetadata) ? upstreamJson.usageMetadata : null;
    const promptTokens = usageMetadata ? asNumber(usageMetadata.promptTokenCount) : undefined;
    const completionTokens = usageMetadata ? asNumber(usageMetadata.candidatesTokenCount) : undefined;
    const totalTokens = usageMetadata ? asNumber(usageMetadata.totalTokenCount) : undefined;

    return {
      id: `chatcmpl-gemini-${created}`,
      object: "chat.completion",
      created,
      model: routedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: finishReason,
        },
      ],
      ...(promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
        ? {
            usage: {
              ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
              ...(completionTokens !== undefined ? { completion_tokens: completionTokens } : {}),
              ...(totalTokens !== undefined
                ? { total_tokens: totalTokens }
                : promptTokens !== undefined && completionTokens !== undefined
                  ? { total_tokens: promptTokens + completionTokens }
                  : {}),
            },
          }
        : {}),
    };
  }
}

const GEMINI_CHAT_STRATEGY = new GeminiChatProviderStrategy();

const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = [
  new ImagesGenerationsPassthroughStrategy(),
  new OpenAiResponsesPassthroughStrategy(),
  new ResponsesPassthroughStrategy(),
  new OllamaProviderStrategy(),
  new LocalOllamaProviderStrategy(),
  new FactoryMessagesProviderStrategy(),
  new FactoryResponsesProviderStrategy(),
  new FactoryChatCompletionsProviderStrategy(),
  new OpenAiResponsesProviderStrategy(),
  new OpenAiChatCompletionsProviderStrategy(),
  new MessagesProviderStrategy(),
  new ResponsesProviderStrategy(),
  new ChatCompletionsProviderStrategy(),
];

export function selectProviderStrategy(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  requestedModelInput: string,
  routingModelInput: string
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, routingModelInput);
  const clientWantsStream = requestBody.stream === true;
  const needsReasoningTrace = requestWantsReasoningTrace(requestBody);
  const upstreamAttemptTimeoutMs = clientWantsStream
    ? Math.min(config.requestTimeoutMs, config.streamBootstrapTimeoutMs)
    : config.requestTimeoutMs;

  const context: StrategyRequestContext = {
    config,
    clientHeaders,
    requestBody,
    requestedModelInput,
    routingModelInput,
    routedModel: routingState.routedModel,
    explicitOllama: routingState.explicitOllama,
    openAiPrefixed: routingState.openAiPrefixed,
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: routingState.localOllama,
    clientWantsStream,
    needsReasoningTrace,
    upstreamAttemptTimeoutMs,
  };

  const strategy = PROVIDER_STRATEGIES.find((entry) => entry.matches(context)) ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  return { strategy, context };
}

export function buildResponsesPassthroughContext(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  requestedModelInput: string,
  routingModelInput: string,
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, routingModelInput);
  const clientWantsStream = requestBody.stream === true;
  const upstreamAttemptTimeoutMs = clientWantsStream
    ? Math.min(config.requestTimeoutMs, config.streamBootstrapTimeoutMs)
    : config.requestTimeoutMs;

  const context: StrategyRequestContext = {
    config,
    clientHeaders,
    requestBody,
    requestedModelInput,
    routingModelInput,
    routedModel: routingState.routedModel,
    explicitOllama: false,
    openAiPrefixed: routingState.openAiPrefixed
      || (!routingState.factoryPrefixed && config.upstreamProviderId === config.openaiProviderId),
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: false,
    clientWantsStream,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs,
    responsesPassthrough: true,
  };

  const strategy = PROVIDER_STRATEGIES.find((entry) => entry.matches(context)) ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  return { strategy, context };
}

export function buildImagesPassthroughContext(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  model: string,
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, model);

  const context: StrategyRequestContext = {
    config,
    clientHeaders,
    requestBody,
    requestedModelInput: model,
    routingModelInput: model,
    routedModel: routingState.routedModel,
    explicitOllama: false,
    openAiPrefixed: routingState.openAiPrefixed,
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: false,
    clientWantsStream: false,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: config.requestTimeoutMs,
    imagesPassthrough: true,
  };

  const strategy = PROVIDER_STRATEGIES.find((entry) => entry.matches(context)) ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  return { strategy, context };
}

function selectRemoteProviderStrategyForRoute(
  context: StrategyRequestContext,
  providerId: string,
): ProviderStrategy {
  const normalizedProviderId = providerId.trim().toLowerCase();

  if (normalizedProviderId === "gemini" && context.responsesPassthrough !== true && context.imagesPassthrough !== true) {
    return GEMINI_CHAT_STRATEGY;
  }

  if (providerUsesOpenAiChatCompletions(providerId) && context.responsesPassthrough !== true && context.imagesPassthrough !== true) {
    // Use the generic ChatCompletionsProviderStrategy (the one that always matches),
    // not a Factory-specific strategy which would produce Factory endpoint paths.
    return PROVIDER_STRATEGIES.find((entry) => entry.mode === "chat_completions" && entry.matches({ ...context, factoryPrefixed: false, openAiPrefixed: false, explicitOllama: false, localOllama: false }))
      ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  }

  const routeContext: StrategyRequestContext = {
    ...context,
    openAiPrefixed: providerId === context.config.openaiProviderId,
    factoryPrefixed: providerId === "factory",
    explicitOllama: false,
    localOllama: false,
  };

  return PROVIDER_STRATEGIES.find((entry) => !entry.isLocal && entry.matches(routeContext))
    ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
}

export async function executeLocalStrategy(
  strategy: ProviderStrategy,
  reply: FastifyReply,
  requestLogStore: RequestLogStore,
  context: StrategyRequestContext,
  payload: BuildPayloadResult
): Promise<void> {
  reply.header("x-open-hax-upstream-provider", "local-ollama");
  const upstreamPath = strategy.getUpstreamPath(context);
  const upstreamUrl = joinUrl(context.config.ollamaBaseUrl, upstreamPath);
  const upstreamHeaders = buildForwardHeaders(context.clientHeaders);
  const attemptStartedAt = Date.now();

  const upstreamSpan = getTelemetry().startSpan("proxy.upstream_attempt", {
    "proxy.provider_id": "ollama",
    "proxy.account_id": "local",
    "proxy.auth_type": "local",
    "proxy.upstream_mode": strategy.mode,
    "proxy.upstream_path": upstreamPath,
    "proxy.model": context.routedModel,
    "proxy.requested_model": context.requestedModelInput,
  });
  upstreamSpan.setAttributes({
    "proxy.service_tier": payload.serviceTier,
    "proxy.service_tier_source": payload.serviceTierSource,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: payload.bodyText
    }, context.upstreamAttemptTimeoutMs);
  } catch (error) {
    const latencyMs = Date.now() - attemptStartedAt;
    upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);
    upstreamSpan.setAttribute("proxy.status", 0);
    upstreamSpan.recordError(error);
    upstreamSpan.end();
    recordAttempt(requestLogStore, { ...context, baseUrl: context.config.ollamaBaseUrl }, {
      providerId: "ollama",
      accountId: "local",
      authType: "local",
      upstreamPath,
      status: 0,
      latencyMs,
      serviceTier: payload.serviceTier,
      serviceTierSource: payload.serviceTierSource,
      error: toErrorMessage(error)
    }, strategy.mode);
    sendOpenAiError(
      reply,
      502,
      "Ollama upstream request failed due to a network or transport error.",
      "server_error",
      "ollama_upstream_unavailable"
    );
    return;
  }

    const latencyMs = Date.now() - attemptStartedAt;
    upstreamSpan.setAttribute("proxy.status", upstreamResponse.status);
    upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);
    if (upstreamResponse.ok) upstreamSpan.setStatus("ok");
    else upstreamSpan.setStatus("error", `HTTP ${upstreamResponse.status}`);
    upstreamSpan.end();

    const requestLogEntryId = recordAttempt(requestLogStore, { ...context, baseUrl: context.config.ollamaBaseUrl }, {
      providerId: "ollama",
      accountId: "local",
      authType: "local",
      upstreamPath,
      status: upstreamResponse.status,
      latencyMs,
      serviceTier: payload.serviceTier,
      serviceTierSource: payload.serviceTierSource
    }, strategy.mode);

    const usagePromise = updateUsageCountsFromResponse(requestLogStore, requestLogEntryId, upstreamResponse, strategy.mode, context.routedModel);
    if (responseIsEventStream(upstreamResponse) && context.clientWantsStream) {
      void usagePromise;
    } else {
      await usagePromise;
    }

    await strategy.handleLocalAttempt(reply, upstreamResponse, {
      ...context,
      baseUrl: context.config.ollamaBaseUrl
  });
}

export async function executeProviderFallback(
  strategy: ProviderStrategy,
  reply: FastifyReply,
  requestLogStore: RequestLogStore,
  promptAffinityStore: PromptAffinityStore,
  keyPool: {
    getRequestOrder(providerId: string): Promise<ProviderCredential[]>;
    markInFlight(credential: ProviderCredential): () => void;
    markRateLimited(credential: ProviderCredential, retryAfterMs?: number): void;
    isAccountExpired?(credential: ProviderCredential): boolean;
  },
  providerRoutes: readonly ProviderRoute[],
  context: StrategyRequestContext,
  payload: BuildPayloadResult,
  promptCacheKey?: string,
  refreshExpiredToken?: (credential: ProviderCredential) => Promise<ProviderCredential | null>,
  policy?: PolicyEngine,
  healthStore?: AccountHealthStore,
): Promise<ProviderFallbackExecutionResult> {
  const accumulator: FallbackAccumulator = {
    sawRateLimit: false,
    sawRequestError: false,
    sawUpstreamServerError: false,
    sawUpstreamInvalidRequest: false,
    sawModelNotFound: false,
    sawModelNotSupportedForAccount: false,
    attempts: 0,
  };

  const candidatesByProvider: Record<string, Array<{ readonly providerId: string; readonly baseUrl: string; readonly account: ProviderCredential }>> = {};

  for (const route of providerRoutes) {
    let routeAccounts: ProviderCredential[];
    try {
      const rawAccounts = await keyPool.getRequestOrder(route.providerId);
      routeAccounts = policy
        ? providerAccountsForRequestWithPolicy(policy, rawAccounts, route.providerId, context.routedModel, {
            openAiPrefixed: context.openAiPrefixed,
            localOllama: context.localOllama,
            explicitOllama: context.explicitOllama,
          })
        : providerAccountsForRequest(rawAccounts, route.providerId, context.routedModel);
    } catch {
      continue;
    }

    routeAccounts = reorderAccountsForLatency(requestLogStore, route.providerId, routeAccounts, context.routedModel, strategy.mode);

    const routeCandidates = routeAccounts.map((account) => ({
      providerId: route.providerId,
      baseUrl: route.baseUrl,
      account,
    }));

    if (routeCandidates.length > 0) {
      candidatesByProvider[route.providerId] = routeCandidates;
    }
  }

  const preferredAffinity = promptCacheKey
    ? await promptAffinityStore.get(promptCacheKey).then((record) => record
      ? { providerId: record.providerId, accountId: record.accountId }
      : undefined)
    : undefined;

  const allCandidates = providerRoutes.flatMap((route) => candidatesByProvider[route.providerId] ?? []);

  const providerIndex = new Map(providerRoutes.map((route, index) => [route.providerId, index] as const));

  const sortedCandidates = [...allCandidates].sort((left, right) => {
    const idxLeft = providerIndex.get(left.providerId) ?? Number.MAX_SAFE_INTEGER;
    const idxRight = providerIndex.get(right.providerId) ?? Number.MAX_SAFE_INTEGER;

    // Respect provider ordering first (already policy-ordered), with an escape hatch
    // for significant TTFT differences.
    if (idxLeft !== idxRight) {
      const perfLeft = requestLogStore.getPerfSummary(left.providerId, left.account.accountId, context.routedModel, strategy.mode);
      const perfRight = requestLogStore.getPerfSummary(right.providerId, right.account.accountId, context.routedModel, strategy.mode);

      const ttftLeft = perfLeft?.ewmaTtftMs;
      const ttftRight = perfRight?.ewmaTtftMs;
      if (
        typeof ttftLeft === "number" && Number.isFinite(ttftLeft)
        && typeof ttftRight === "number" && Number.isFinite(ttftRight)
      ) {
        const ttftDelta = Math.abs(ttftLeft - ttftRight);
        if (ttftDelta > 120) {
          return ttftLeft - ttftRight;
        }
      }

      return idxLeft - idxRight;
    }

    // Within a provider, preserve upstream ordering (policy + account ordering + latency window).
    return 0;
  });

  const candidates = reorderCandidatesForAffinity(sortedCandidates, preferredAffinity);

  if (candidates.length === 0) {
    return {
      handled: false,
      candidateCount: 0,
      summary: accumulator
    };
  }

  let preferredReassignmentAllowed = preferredAffinity === undefined || candidates.every(
    (candidate) => candidate.providerId !== preferredAffinity.providerId || candidate.account.accountId !== preferredAffinity.accountId,
  );

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const candidateStrategy = selectRemoteProviderStrategyForRoute(context, candidate.providerId);
    const candidatePayload = candidateStrategy.mode === strategy.mode
      ? payload
      : candidateStrategy.buildPayload(context);
    const hasMoreCandidates = candidateIndex < candidates.length - 1;
    const releaseInFlight = keyPool.markInFlight(candidate.account);

    for (let retryIndex = 0; retryIndex <= context.config.upstreamTransientRetryCount; retryIndex += 1) {
      accumulator.attempts += 1;
      const providerContext: ProviderAttemptContext = {
        ...context,
        providerId: candidate.providerId,
        baseUrl: candidate.baseUrl,
        account: candidate.account,
        hasMoreCandidates,
        attempt: accumulator.attempts,
      };
      const upstreamPath = candidateStrategy.getUpstreamPath(providerContext);
      const upstreamUrl = joinUrl(candidate.baseUrl, upstreamPath);
      const upstreamHeaders = buildUpstreamHeadersForCredential(context.clientHeaders, candidate.account);
      candidateStrategy.applyRequestHeaders(upstreamHeaders, providerContext, candidatePayload.upstreamPayload);
      const attemptStartedAt = Date.now();
      const hasRetryRemaining = retryIndex < context.config.upstreamTransientRetryCount;

      const upstreamSpan = getTelemetry().startSpan("proxy.upstream_attempt", {
        "proxy.provider_id": candidate.providerId,
        "proxy.account_id": candidate.account.accountId,
        "proxy.auth_type": candidate.account.authType,
        "proxy.upstream_mode": candidateStrategy.mode,
        "proxy.upstream_path": upstreamPath,
        "proxy.model": context.routedModel,
        "proxy.requested_model": context.requestedModelInput,
        "proxy.base_url": candidate.baseUrl,
        "proxy.fallback_attempt": accumulator.attempts,
      });
      upstreamSpan.setAttributes({
        "proxy.service_tier": candidatePayload.serviceTier,
        "proxy.service_tier_source": candidatePayload.serviceTierSource,
      });

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: candidatePayload.bodyText
        }, context.upstreamAttemptTimeoutMs);
      } catch (error) {
        const latencyMs = Date.now() - attemptStartedAt;
        upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);
        upstreamSpan.setAttribute("proxy.status", 0);
        upstreamSpan.recordError(error);
        upstreamSpan.end();
        accumulator.sawRequestError = true;
        recordAttempt(requestLogStore, providerContext, {
          providerId: candidate.providerId,
          accountId: candidate.account.accountId,
          authType: candidate.account.authType,
          upstreamPath,
          status: 0,
          latencyMs,
          serviceTier: candidatePayload.serviceTier,
          serviceTierSource: candidatePayload.serviceTierSource,
          error: toErrorMessage(error)
        }, candidateStrategy.mode);
        break;
      }

      const latencyMs = Date.now() - attemptStartedAt;
      upstreamSpan.setAttribute("proxy.status", upstreamResponse.status);
      upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);

      const requestLogEntryId = recordAttempt(requestLogStore, providerContext, {
        providerId: candidate.providerId,
        accountId: candidate.account.accountId,
        authType: candidate.account.authType,
        upstreamPath,
        status: upstreamResponse.status,
        latencyMs,
        serviceTier: candidatePayload.serviceTier,
        serviceTierSource: candidatePayload.serviceTierSource,
        promptCacheKeyUsed: Boolean(promptCacheKey),
      }, candidateStrategy.mode);

      const usagePromise = updateUsageCountsFromResponse(requestLogStore, requestLogEntryId, upstreamResponse, candidateStrategy.mode, context.routedModel);
      if (responseIsEventStream(upstreamResponse) && context.clientWantsStream) {
        void usagePromise;
      } else {
        await usagePromise;
      }

      if (isRateLimitResponse(upstreamResponse)) {
        accumulator.sawRateLimit = true;
        keyPool.markRateLimited(candidate.account, parseRetryAfterMs(upstreamResponse.headers.get("retry-after")));
        if (
          preferredAffinity
          && candidate.providerId === preferredAffinity.providerId
          && candidate.account.accountId === preferredAffinity.accountId
        ) {
          preferredReassignmentAllowed = true;
        }
        upstreamSpan.setStatus("error", "rate_limited");
        upstreamSpan.end();
        break;
      }

      if (await responseIndicatesQuotaError(upstreamResponse)) {
        accumulator.sawRateLimit = true;
        // A 402 indicates a payment/balance issue — the account is unusable
        // until the user pays, so apply a long cooldown (24 hours) instead of
        // the short transient cooldown used for normal quota exhaustion.
        const quotaCooldownMs = upstreamResponse.status === 402
          ? 24 * 60 * 60 * 1000
          : Math.min(context.config.keyCooldownMs, 60_000);
        keyPool.markRateLimited(candidate.account, quotaCooldownMs);
        if (healthStore) {
          healthStore.recordFailure(candidate.account, upstreamResponse.status, "quota_exhausted");
        }
        if (
          preferredAffinity
          && candidate.providerId === preferredAffinity.providerId
          && candidate.account.accountId === preferredAffinity.accountId
        ) {
          preferredReassignmentAllowed = true;
        }
        try {
          await upstreamResponse.arrayBuffer();
        } catch {
          // Ignore body read failures while failing over.
        }
        upstreamSpan.setStatus("error", "quota_exhausted");
        upstreamSpan.end();
        break;
      }

      if (upstreamResponse.status >= 500 && upstreamResponse.status <= 599) {
        accumulator.sawUpstreamServerError = true;
        if (hasRetryRemaining && shouldRetrySameCredentialForServerError(upstreamResponse.status)) {
          try {
            await upstreamResponse.arrayBuffer();
          } catch {
            // Ignore body read failures while retrying.
          }
          upstreamSpan.setStatus("error", `upstream_server_error_${upstreamResponse.status}`);
          upstreamSpan.end();
          await sleep(transientRetryDelayMs(context, retryIndex));
          continue;
        }
        keyPool.markRateLimited(candidate.account, Math.min(context.config.keyCooldownMs, 5000));
        try {
          await upstreamResponse.arrayBuffer();
        } catch {
          // Ignore body read failures while failing over.
        }
        upstreamSpan.setStatus("error", `upstream_server_error_${upstreamResponse.status}`);
        upstreamSpan.end();
        break;
      }

      reply.header("x-open-hax-upstream-mode", candidateStrategy.mode);
      const outcome = await candidateStrategy.handleProviderAttempt(reply, upstreamResponse, providerContext);
      if (outcome.kind === "handled") {
        upstreamSpan.setStatus("ok");
        upstreamSpan.end();
        if (healthStore && upstreamResponse.ok) {
          healthStore.recordSuccess(candidate.account, upstreamResponse.status);
        }
        if (
          promptCacheKey
          && (
            preferredAffinity === undefined
            || preferredReassignmentAllowed
            || (candidate.providerId === preferredAffinity.providerId && candidate.account.accountId === preferredAffinity.accountId)
          )
        ) {
          await promptAffinityStore.upsert(promptCacheKey, candidate.providerId, candidate.account.accountId);
        }
        releaseInFlight();
        return {
          handled: true,
          candidateCount: candidates.length,
          summary: accumulator
        };
      }

      if (
        healthStore
        && !upstreamResponse.ok
        && upstreamResponse.status >= 500
        && !outcome.upstreamInvalidRequest
        && !outcome.modelNotFound
        && !outcome.modelNotSupportedForAccount
      ) {
        healthStore.recordFailure(candidate.account, upstreamResponse.status);
      }

      accumulator.sawRateLimit ||= outcome.rateLimit === true;
      accumulator.sawRequestError ||= outcome.requestError === true;
      accumulator.sawUpstreamServerError ||= outcome.upstreamServerError === true;
      accumulator.sawUpstreamInvalidRequest ||= outcome.upstreamInvalidRequest === true;
      accumulator.sawModelNotFound ||= outcome.modelNotFound === true;
      accumulator.sawModelNotSupportedForAccount ||= outcome.modelNotSupportedForAccount === true;

      if (!upstreamResponse.ok && outcome.requestError === true && upstreamResponse.status === 401 && candidate.account.authType === "oauth_bearer" && candidate.account.refreshToken && refreshExpiredToken) {
        const refreshedCredential = await refreshExpiredToken(candidate.account);
        if (refreshedCredential) {
          const refreshedProviderContext: ProviderAttemptContext = { ...providerContext, account: refreshedCredential };
          const refreshedHeaders = buildUpstreamHeadersForCredential(context.clientHeaders, refreshedCredential);
          candidateStrategy.applyRequestHeaders(refreshedHeaders, refreshedProviderContext, candidatePayload.upstreamPayload);
          const refreshedRelease = keyPool.markInFlight(refreshedCredential);
          const refreshedAttemptStartedAt = Date.now();
          let refreshedResponse: Response;
          try {
            refreshedResponse = await fetchWithResponseTimeout(upstreamUrl, {
              method: "POST",
              headers: refreshedHeaders,
              body: candidatePayload.bodyText
            }, context.upstreamAttemptTimeoutMs);
          } catch (error) {
            refreshedRelease();
            releaseInFlight();
            throw error;
          }

          try {
            const refreshedLatencyMs = Date.now() - refreshedAttemptStartedAt;
            const refreshedLogId = recordAttempt(requestLogStore, refreshedProviderContext, {
              providerId: candidate.providerId,
              accountId: refreshedCredential.accountId,
              authType: refreshedCredential.authType,
              upstreamPath,
              status: refreshedResponse.status,
              latencyMs: refreshedLatencyMs,
              serviceTier: candidatePayload.serviceTier,
              serviceTierSource: candidatePayload.serviceTierSource,
              promptCacheKeyUsed: Boolean(promptCacheKey),
            }, candidateStrategy.mode);
            const usagePromise = updateUsageCountsFromResponse(requestLogStore, refreshedLogId, refreshedResponse, candidateStrategy.mode, context.routedModel);
            if (responseIsEventStream(refreshedResponse) && context.clientWantsStream) {
              void usagePromise;
            } else {
              await usagePromise;
            }
            if (isRateLimitResponse(refreshedResponse)) {
              accumulator.sawRateLimit = true;
              keyPool.markRateLimited(refreshedCredential, parseRetryAfterMs(refreshedResponse.headers.get("retry-after")));
              try {
                await refreshedResponse.arrayBuffer();
              } catch {
                // Ignore body read failures while failing over after refresh.
              }
              break;
            }
            reply.header("x-open-hax-upstream-mode", candidateStrategy.mode);
            const refreshedOutcome = await candidateStrategy.handleProviderAttempt(reply, refreshedResponse, refreshedProviderContext);
            if (refreshedOutcome.kind === "handled") {
              upstreamSpan.setStatus("ok");
              upstreamSpan.end();

              if (healthStore && refreshedResponse.ok) {
                healthStore.recordSuccess(refreshedCredential, refreshedResponse.status);
              }

              if (
                promptCacheKey
                && (
                  preferredAffinity === undefined
                  || preferredReassignmentAllowed
                  || (candidate.providerId === preferredAffinity.providerId && refreshedCredential.accountId === preferredAffinity.accountId)
                )
              ) {
                await promptAffinityStore.upsert(promptCacheKey, candidate.providerId, refreshedCredential.accountId);
              }

              releaseInFlight();
              return { handled: true, candidateCount: candidates.length, summary: accumulator };
            }
            accumulator.sawRateLimit ||= refreshedOutcome.rateLimit === true;
            accumulator.sawRequestError ||= refreshedOutcome.requestError === true;
            accumulator.sawUpstreamServerError ||= refreshedOutcome.upstreamServerError === true;
            accumulator.sawUpstreamInvalidRequest ||= refreshedOutcome.upstreamInvalidRequest === true;
            accumulator.sawModelNotFound ||= refreshedOutcome.modelNotFound === true;
            accumulator.sawModelNotSupportedForAccount ||= refreshedOutcome.modelNotSupportedForAccount === true;
            if (!refreshedResponse.ok && refreshedOutcome.requestError === true && (refreshedResponse.status === 401 || refreshedResponse.status === 403)) {
              if (shouldCooldownCredentialOnAuthFailure(candidate.providerId, refreshedResponse.status)) {
                keyPool.markRateLimited(refreshedCredential, Math.min(context.config.keyCooldownMs, 10_000));
                if (preferredAffinity && candidate.providerId === preferredAffinity.providerId && refreshedCredential.accountId === preferredAffinity.accountId) {
                  preferredReassignmentAllowed = true;
                }
              }
            }
            break;
          } finally {
            refreshedRelease();
          }
        }
        keyPool.markRateLimited(candidate.account, Math.min(context.config.keyCooldownMs, 10_000));
        if (preferredAffinity && candidate.providerId === preferredAffinity.providerId && candidate.account.accountId === preferredAffinity.accountId) {
          preferredReassignmentAllowed = true;
        }
      } else if (!upstreamResponse.ok && outcome.requestError === true && (upstreamResponse.status === 401 || upstreamResponse.status === 403)) {
        if (shouldCooldownCredentialOnAuthFailure(candidate.providerId, upstreamResponse.status)) {
          keyPool.markRateLimited(candidate.account, Math.min(context.config.keyCooldownMs, 10_000));
          if (preferredAffinity && candidate.providerId === preferredAffinity.providerId && candidate.account.accountId === preferredAffinity.accountId) {
            preferredReassignmentAllowed = true;
          }
        }
      }

      if (!upstreamResponse.ok && outcome.requestError === true && !outcome.modelNotFound && !outcome.modelNotSupportedForAccount) {
        await summarizeUpstreamError(upstreamResponse);
      }

      upstreamSpan.setStatus("error", `fallback_continue_${upstreamResponse.status}`);
      upstreamSpan.end();
      break;
    }

    releaseInFlight();
  }

  return {
    handled: false,
    candidateCount: candidates.length,
    summary: accumulator
  };
}

export async function inspectProviderAvailability(
  keyPool: {
    getStatus(providerId: string): Promise<{ readonly totalAccounts: number }>;
  },
  providerRoutes: readonly ProviderRoute[],
  promptCacheKey?: string,
): Promise<ProviderAvailabilitySummary> {
  let sawConfiguredProvider = false;

  for (const route of providerRoutes) {
    try {
      const status = await keyPool.getStatus(route.providerId);
      if (status.totalAccounts > 0) {
        sawConfiguredProvider = true;
      }
    } catch {
      // Ignore status lookup errors and continue collecting provider info.
    }
  }

  return { sawConfiguredProvider, prompt_cache_key: promptCacheKey };
}
