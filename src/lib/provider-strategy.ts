import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import type { FastifyReply } from "fastify";

import type { ProxyConfig } from "./config.js";
import type { ProviderCredential } from "./key-pool.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { PromptAffinityStore } from "./prompt-affinity-store.js";
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
  appendCsvHeaderValue,
  chatCompletionHasReasoningContent,
  fetchWithResponseTimeout,
  requestWantsReasoningTrace,
  responseIsEventStream,
  responseIndicatesMissingModel,
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

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
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
  readonly localOllama: boolean;
  readonly clientWantsStream: boolean;
  readonly needsReasoningTrace: boolean;
  readonly upstreamAttemptTimeoutMs: number;
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
}

type ProviderAttemptOutcome = ProviderAttemptOutcomeHandled | ProviderAttemptOutcomeContinue;

interface FallbackAccumulator {
  sawRateLimit: boolean;
  sawRequestError: boolean;
  sawUpstreamServerError: boolean;
  sawUpstreamInvalidRequest: boolean;
  sawModelNotFound: boolean;
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
}

interface BuildPayloadResult {
  readonly upstreamPayload: Record<string, unknown>;
  readonly bodyText: string;
}

function providerAccountsForRequest(
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
): ProviderCredential[] {
  if (providerId !== "openai" || routedModel !== "gpt-5.4") {
    return [...accounts];
  }

  const stronglySupportedPlans = new Set(["plus", "pro", "business", "enterprise"]);
  const stronglySupportedAccounts = accounts.filter((account) => stronglySupportedPlans.has(account.planType ?? ""));
  const paidAccounts = accounts.filter((account) => account.planType !== "free");
  const prioritized = stronglySupportedAccounts.length > 0
    ? stronglySupportedAccounts
    : paidAccounts.length > 0
      ? paidAccounts
      : [...accounts];
  const planWeight = (planType: string | undefined): number => {
    switch (planType) {
      case "plus":
        return 5;
      case "pro":
      case "business":
      case "enterprise":
        return 4;
      case "team":
        return 2;
      case "free":
        return 0;
      default:
        return 1;
    }
  };

  return [...prioritized].sort((left, right) => planWeight(right.planType) - planWeight(left.planType));
}

interface UsageCounts {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
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

function buildPayloadResult(upstreamPayload: Record<string, unknown>): BuildPayloadResult {
  return {
    upstreamPayload,
    bodyText: JSON.stringify(upstreamPayload)
  };
}

function buildRequestBodyForUpstream(context: StrategyRequestContext): Record<string, unknown> {
  return context.routedModel !== context.requestedModelInput
    ? {
      ...context.requestBody,
      model: context.routedModel
    }
    : context.requestBody;
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
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
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
    promptTokens: values.promptTokens,
    completionTokens: values.completionTokens,
    totalTokens: values.totalTokens,
    error: values.error
  });

  return entry.id;
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

  return {
    promptTokens,
    completionTokens,
    totalTokens,
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

function usageCountsForMode(mode: UpstreamMode, upstreamJson: unknown, routedModel: string): UsageCounts {
  if (!isRecord(upstreamJson)) {
    return {};
  }

  if (mode === "messages") {
    return usageCountsFromCompletion(messagesToChatCompletion(upstreamJson, routedModel));
  }

  if (mode === "responses" || mode === "openai_responses") {
    return usageCountsFromCompletion(responsesToChatCompletion(upstreamJson, routedModel));
  }

  if (mode === "ollama_chat" || mode === "local_ollama_chat") {
    return usageCountsFromCompletion(ollamaToChatCompletion(upstreamJson, routedModel));
  }

  return usageCountsFromUpstreamJson(upstreamJson, routedModel);
}

async function extractUsageCounts(
  response: Response,
  mode: UpstreamMode,
  routedModel: string,
): Promise<UsageCounts> {
  if (!response.ok || responseIsEventStream(response)) {
    return {};
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
  const usageCounts = await extractUsageCounts(response, mode, routedModel);
  if (
    usageCounts.promptTokens === undefined
    && usageCounts.completionTokens === undefined
    && usageCounts.totalTokens === undefined
  ) {
    return;
  }

  requestLogStore.update(entryId, usageCounts);
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

    if (upstreamResponse.status === 400 || upstreamResponse.status === 422) {
      try {
        await upstreamResponse.arrayBuffer();
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
    return buildPayloadResult(chatRequestToOllamaRequest(context.requestBody, context.config.ollamaModelPrefixes));
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
    return buildPayloadResult(chatRequestToMessagesRequest(buildRequestBodyForUpstream(context)));
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
    return buildPayloadResult(chatRequestToResponsesRequest(buildRequestBodyForUpstream(context)));
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
      && shouldUseResponsesUpstream(context.routedModel, context.config.responsesModelPrefixes);
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.openaiResponsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = chatRequestToResponsesRequest(buildRequestBodyForUpstream(context));
    delete upstreamPayload["max_output_tokens"];
    upstreamPayload["store"] = false;
    upstreamPayload["stream"] = true;
    return buildPayloadResult(upstreamPayload);
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
    return buildPayloadResult(buildRequestBodyForUpstream(context));
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
    return buildPayloadResult(buildRequestBodyForUpstream(context));
  }
}

const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = [
  new OllamaProviderStrategy(),
  new LocalOllamaProviderStrategy(),
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
    localOllama: routingState.localOllama,
    clientWantsStream,
    needsReasoningTrace,
    upstreamAttemptTimeoutMs,
  };

  const strategy = PROVIDER_STRATEGIES.find((entry) => entry.matches(context)) ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  return { strategy, context };
}

function selectRemoteProviderStrategyForRoute(
  context: StrategyRequestContext,
  providerId: string,
): ProviderStrategy {
  const routeContext: StrategyRequestContext = {
    ...context,
    openAiPrefixed: providerId === context.config.openaiProviderId,
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

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: payload.bodyText
    }, context.upstreamAttemptTimeoutMs);
  } catch (error) {
    recordAttempt(requestLogStore, { ...context, baseUrl: context.config.ollamaBaseUrl }, {
      providerId: "ollama",
      accountId: "local",
      authType: "local",
      upstreamPath,
      status: 0,
      latencyMs: Date.now() - attemptStartedAt,
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

    const requestLogEntryId = recordAttempt(requestLogStore, { ...context, baseUrl: context.config.ollamaBaseUrl }, {
      providerId: "ollama",
      accountId: "local",
      authType: "local",
      upstreamPath,
      status: upstreamResponse.status,
      latencyMs: Date.now() - attemptStartedAt
    }, strategy.mode);

    await updateUsageCountsFromResponse(requestLogStore, requestLogEntryId, upstreamResponse, strategy.mode, context.routedModel);

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
  },
  providerRoutes: readonly ProviderRoute[],
  context: StrategyRequestContext,
  payload: BuildPayloadResult,
  promptCacheKey?: string,
): Promise<ProviderFallbackExecutionResult> {
  const accumulator: FallbackAccumulator = {
    sawRateLimit: false,
    sawRequestError: false,
    sawUpstreamServerError: false,
    sawUpstreamInvalidRequest: false,
    sawModelNotFound: false,
    attempts: 0,
  };

  const candidatesByProvider: Record<string, Array<{ readonly providerId: string; readonly baseUrl: string; readonly account: ProviderCredential }>> = {};

  for (const route of providerRoutes) {
    let routeAccounts: ProviderCredential[];
    try {
      routeAccounts = providerAccountsForRequest(
        await keyPool.getRequestOrder(route.providerId),
        route.providerId,
        context.routedModel,
      );
    } catch {
      continue;
    }

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

  const candidates = reorderCandidatesForAffinity(
    providerRoutes.flatMap((route) => candidatesByProvider[route.providerId] ?? []),
    preferredAffinity,
  );
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

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: candidatePayload.bodyText
        }, context.upstreamAttemptTimeoutMs);
      } catch (error) {
        accumulator.sawRequestError = true;
        recordAttempt(requestLogStore, providerContext, {
          providerId: candidate.providerId,
          accountId: candidate.account.accountId,
          authType: candidate.account.authType,
          upstreamPath,
          status: 0,
          latencyMs: Date.now() - attemptStartedAt,
          error: toErrorMessage(error)
        }, candidateStrategy.mode);
        if (hasRetryRemaining) {
          await sleep(transientRetryDelayMs(context, retryIndex));
          continue;
        }
        break;
      }

      const requestLogEntryId = recordAttempt(requestLogStore, providerContext, {
        providerId: candidate.providerId,
        accountId: candidate.account.accountId,
        authType: candidate.account.authType,
        upstreamPath,
        status: upstreamResponse.status,
        latencyMs: Date.now() - attemptStartedAt
      }, candidateStrategy.mode);

      await updateUsageCountsFromResponse(requestLogStore, requestLogEntryId, upstreamResponse, candidateStrategy.mode, context.routedModel);

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
        break;
      }

      if (await responseIndicatesQuotaError(upstreamResponse)) {
        accumulator.sawRateLimit = true;
        keyPool.markRateLimited(candidate.account, Math.min(context.config.keyCooldownMs, 60_000));
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
        break;
      }

      if (upstreamResponse.status >= 500 && upstreamResponse.status <= 599) {
        accumulator.sawUpstreamServerError = true;
        if (hasRetryRemaining) {
          try {
            await upstreamResponse.arrayBuffer();
          } catch {
            // Ignore body read failures while retrying.
          }
          await sleep(transientRetryDelayMs(context, retryIndex));
          continue;
        }
        keyPool.markRateLimited(candidate.account, Math.min(context.config.keyCooldownMs, 5000));
        try {
          await upstreamResponse.arrayBuffer();
        } catch {
          // Ignore body read failures while failing over.
        }
        break;
      }

      reply.header("x-open-hax-upstream-mode", candidateStrategy.mode);
      const outcome = await candidateStrategy.handleProviderAttempt(reply, upstreamResponse, providerContext);
      if (outcome.kind === "handled") {
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

      accumulator.sawRateLimit ||= outcome.rateLimit === true;
      accumulator.sawRequestError ||= outcome.requestError === true;
      accumulator.sawUpstreamServerError ||= outcome.upstreamServerError === true;
      accumulator.sawUpstreamInvalidRequest ||= outcome.upstreamInvalidRequest === true;
      accumulator.sawModelNotFound ||= outcome.modelNotFound === true;

      if (!upstreamResponse.ok && outcome.requestError === true && (upstreamResponse.status === 401 || upstreamResponse.status === 403)) {
        keyPool.markRateLimited(candidate.account, Math.min(context.config.keyCooldownMs, 10_000));
        if (
          preferredAffinity
          && candidate.providerId === preferredAffinity.providerId
          && candidate.account.accountId === preferredAffinity.accountId
        ) {
          preferredReassignmentAllowed = true;
        }
      }

      if (!upstreamResponse.ok && outcome.requestError === true && !outcome.modelNotFound) {
        await summarizeUpstreamError(upstreamResponse);
      }

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
  providerRoutes: readonly ProviderRoute[]
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

  return { sawConfiguredProvider };
}
