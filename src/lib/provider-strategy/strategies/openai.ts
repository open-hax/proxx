import type { FastifyReply } from "fastify";

import { copyUpstreamHeaders } from "../../proxy.js";
import {
  chatRequestToResponsesRequest,
  extractTerminalResponseFromEventStream,
  responsesEventStreamToErrorPayload,
  responsesToChatCompletion,
} from "../../responses-compat.js";
import { BaseProviderStrategy, TransformedJsonProviderStrategy } from "../base.js";
import { handleResponsesEventStreamAsChatCompletion } from "./responses-event-stream.js";
import {
  applyRequestedServiceTier,
  buildPayloadResult,
  buildRequestBodyForUpstream,
  stripTrailingAssistantPrefill,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
  type UpstreamMode,
} from "../shared.js";

/**
 * Parameters that the ChatGPT Codex backend (`chatgpt.com/backend-api/codex/responses`)
 * does not support and will reject with HTTP 400.
 */
const CODEX_UNSUPPORTED_PARAMS = [
  "max_output_tokens",
  "prompt_cache_retention",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "service_tier",
  "user",
] as const;

function stripCodexUnsupportedParams(payload: Record<string, unknown>): void {
  for (const key of CODEX_UNSUPPORTED_PARAMS) {
    delete payload[key];
  }
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("responses stream timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function streamResponsesPassthroughToClient(
  reply: FastifyReply,
  upstreamResponse: Response,
  context: ProviderAttemptContext,
): Promise<ProviderAttemptOutcome> {
  if (!upstreamResponse.body) {
    return { kind: "continue", requestError: true };
  }

  const reader = upstreamResponse.body.getReader();
  let firstChunk: ReadableStreamReadResult<Uint8Array>;
  try {
    firstChunk = await readStreamChunkWithTimeout(reader, context.config.streamBootstrapTimeoutMs);
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: "continue", requestError: true };
  }

  if (firstChunk.done) {
    await reader.cancel().catch(() => undefined);
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

  try {
    if (firstChunk.value && firstChunk.value.byteLength > 0) {
      rawResponse.write(firstChunk.value);
    }

    while (!rawResponse.writableEnded) {
      let nextChunk: ReadableStreamReadResult<Uint8Array>;
      try {
        nextChunk = await readStreamChunkWithTimeout(reader, context.config.requestTimeoutMs);
      } catch {
        await reader.cancel().catch(() => undefined);
        break;
      }

      const { done, value } = nextChunk;
      if (done) {
        break;
      }

      if (value && value.byteLength > 0) {
        rawResponse.write(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore reader release errors while closing the downstream stream.
    }
    if (!rawResponse.writableEnded) {
      rawResponse.end();
    }
  }

  return { kind: "handled" };
}

abstract class OpenAiCodexResponsesStrategy extends TransformedJsonProviderStrategy {
  public abstract readonly mode: Extract<UpstreamMode, "openai_responses" | "openai_chat_completions">;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.openAiPrefixed
      && context.responsesPassthrough !== true
      && context.imagesPassthrough !== true;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.openaiResponsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = chatRequestToResponsesRequest(buildRequestBodyForUpstream(context));
    applyRequestedServiceTier(upstreamPayload, context);
    stripCodexUnsupportedParams(upstreamPayload);
    if (upstreamPayload["instructions"] == null) {
      upstreamPayload["instructions"] = "";
    }
    upstreamPayload["store"] = false;
    upstreamPayload["stream"] = true;
    stripTrailingAssistantPrefill(upstreamPayload);
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

    return handleResponsesEventStreamAsChatCompletion(reply, upstreamResponse, context);
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    return responsesToChatCompletion(upstreamJson, routedModel);
  }
}

export class OpenAiResponsesProviderStrategy extends OpenAiCodexResponsesStrategy {
  public readonly mode = "openai_responses" as const;
}

export class OpenAiChatCompletionsProviderStrategy extends OpenAiCodexResponsesStrategy {
  public readonly mode = "openai_chat_completions" as const;
}


export class OpenAiResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "openai_responses_passthrough" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.responsesPassthrough === true && context.openAiPrefixed;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    return context.config.openaiResponsesPath;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = buildRequestBodyForUpstream(context);
    stripCodexUnsupportedParams(upstreamPayload);
    upstreamPayload["store"] = false;
    upstreamPayload["stream"] = true;
    if (upstreamPayload["instructions"] == null) {
      upstreamPayload["instructions"] = "";
    }
    stripTrailingAssistantPrefill(upstreamPayload);
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
      return streamResponsesPassthroughToClient(reply, upstreamResponse, context);
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
