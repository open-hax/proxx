import type { FastifyReply } from "fastify";

import { copyUpstreamHeaders } from "../../proxy.js";
import {
  extractTerminalResponseFromEventStream,
  responsesEventStreamToErrorPayload,
  responsesToChatCompletion,
} from "../../responses-compat.js";
import { BaseProviderStrategy, TransformedJsonProviderStrategy } from "../base.js";
import { handleResponsesEventStreamAsChatCompletion } from "./responses-event-stream.js";
import {
  buildRequestBodyForUpstream,
  buildStrategyPayloadResult,
  strategyUpstreamPath,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
  type UpstreamMode,
} from "../shared.js";

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

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("openai-responses", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("openai-responses", context, buildRequestBodyForUpstream(context));
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
  public readonly registryId: string = "openai-responses";

  public readonly mode = "openai_responses" as const;
}

export class OpenAiChatCompletionsProviderStrategy extends OpenAiCodexResponsesStrategy {
  public readonly registryId: string = "openai-chat";

  public readonly mode = "openai_chat_completions" as const;
}


export class OpenAiResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "openai_responses_passthrough" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "openai-responses-passthrough";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("openai-responses-passthrough", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("openai-responses-passthrough", context, buildRequestBodyForUpstream(context));
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
