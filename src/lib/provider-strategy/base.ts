import { Readable } from "node:stream";

import type { FastifyReply } from "fastify";

import { copyUpstreamHeaders } from "../proxy.js";
import { chatCompletionToSse } from "../responses-compat.js";
import {
  streamPayloadHasReasoningTrace,
  stripSseCommentLines,
  streamPayloadHasSubstantiveChunks,
  chatCompletionHasReasoningContent,
} from "../sse/index.js";
import {
  responseIndicatesMissingModel,
  responseIndicatesModelNotSupportedForAccount,
  streamPayloadIndicatesQuotaError,
  summarizeUpstreamError,
} from "../provider-utils.js";
import {
  type BuildPayloadResult,
  isRecord,
  type LocalAttemptContext,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type ProviderStrategy,
  type StrategyRequestContext,
  type UpstreamMode,
} from "./shared.js";

function appendUpstreamIdentityHeaders(reply: FastifyReply, context: ProviderAttemptContext): void {
  reply.header("x-open-hax-upstream-provider", context.providerId);

  // Only expose the selected account identity to legacy admin callers.
  // This keeps tenant traffic from learning internal account IDs while still
  // enabling federation/bridge observability between trusted nodes.
  if (context.requestAuth?.kind === "legacy_admin") {
    reply.header("x-open-hax-upstream-account", context.account.accountId);
    reply.header("x-open-hax-upstream-auth-type", context.account.authType);
  }
}

type StreamBootstrapResult =
  | { kind: "continue"; rateLimit?: true; requestError?: true }
  | {
    kind: "ready";
    reader: ReadableStreamDefaultReader<Uint8Array>;
    bufferedChunks: Uint8Array[];
  };

async function cancelStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Ignore cancellation errors while failing over.
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
        timeoutHandle = setTimeout(() => {
          reject(new Error("stream bootstrap timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function bootstrapEventStream(
  upstreamResponse: Response,
  context: ProviderAttemptContext,
): Promise<StreamBootstrapResult> {
  if (!upstreamResponse.body) {
    return { kind: "continue", requestError: true };
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: Uint8Array[] = [];
  let bufferedText = "";

  try {
    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(reader, context.upstreamAttemptTimeoutMs);

      if (done) {
        bufferedText += decoder.decode();
        const sanitized = stripSseCommentLines(bufferedText);

        if (streamPayloadIndicatesQuotaError(sanitized)) {
          await cancelStreamReader(reader);
          return { kind: "continue", rateLimit: true };
        }

        if (!streamPayloadHasSubstantiveChunks(sanitized)) {
          await cancelStreamReader(reader);
          return { kind: "continue", requestError: true };
        }

        if (context.needsReasoningTrace && context.hasMoreCandidates && !streamPayloadHasReasoningTrace(sanitized)) {
          await cancelStreamReader(reader);
          return { kind: "continue", requestError: true };
        }

        return {
          kind: "ready",
          reader,
          bufferedChunks,
        };
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      bufferedChunks.push(value);
      bufferedText += decoder.decode(value, { stream: true });
      const sanitized = stripSseCommentLines(bufferedText);

      if (streamPayloadIndicatesQuotaError(sanitized)) {
        await cancelStreamReader(reader);
        return { kind: "continue", rateLimit: true };
      }

      if (!streamPayloadHasSubstantiveChunks(sanitized)) {
        continue;
      }

      if (context.needsReasoningTrace && context.hasMoreCandidates && !streamPayloadHasReasoningTrace(sanitized)) {
        continue;
      }

      return {
        kind: "ready",
        reader,
        bufferedChunks,
      };
    }
  } catch {
    await cancelStreamReader(reader);
    return { kind: "continue", requestError: true };
  }
}

async function streamEventStreamToClient(
  reply: FastifyReply,
  upstreamResponse: Response,
  context: ProviderAttemptContext,
  bootstrap: Extract<StreamBootstrapResult, { kind: "ready" }>,
): Promise<ProviderAttemptOutcome> {
  appendUpstreamIdentityHeaders(reply, context);
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
    for (const chunk of bootstrap.bufferedChunks) {
      rawResponse.write(chunk);
    }

    while (!rawResponse.writableEnded) {
      const { done, value } = await bootstrap.reader.read();
      if (done) {
        break;
      }

      if (value && value.byteLength > 0) {
        rawResponse.write(value);
      }
    }
  } finally {
    try {
      bootstrap.reader.releaseLock();
    } catch {
      // Ignore reader release errors while closing the downstream stream.
    }

    if (!rawResponse.writableEnded) {
      rawResponse.end();
    }
  }

  return { kind: "handled" };
}

export abstract class BaseProviderStrategy implements ProviderStrategy {
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
      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      const isEventStream = contentType.toLowerCase().includes("text/event-stream");

      if (!isEventStream) {
        try {
          const bodyText = await upstreamResponse.clone().text();
          if (bodyText.length === 0) {
            return { kind: "continue", requestError: true };
          }

          if (context.clientWantsStream && streamPayloadHasSubstantiveChunks(stripSseCommentLines(bodyText))) {
            return this.handleSuccessfulProviderAttempt(reply, upstreamResponse, context);
          }

          const parsed = JSON.parse(bodyText);
          const looksLikeImagesPayload = context.imagesPassthrough === true
            && isRecord(parsed)
            && Array.isArray(parsed["data"]);
          if (
            ((typeof parsed !== "object" || parsed === null)
            || (!("choices" in parsed) && !("object" in parsed) && !("id" in parsed)))
            && !looksLikeImagesPayload
          ) {
            return { kind: "continue", requestError: true };
          }
        } catch {
          return { kind: "continue", requestError: true };
        }
      }

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

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      const authSummary = await summarizeUpstreamError(upstreamResponse);
      try {
        await upstreamResponse.arrayBuffer();
      } catch {
        // Ignore body read failures while failing over.
      }

      return {
        kind: "continue",
        requestError: true,
        upstreamAuthError: {
          status: upstreamResponse.status,
          message: authSummary.upstreamErrorMessage,
        },
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
    _context: LocalAttemptContext
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

      appendUpstreamIdentityHeaders(reply, context);
      reply.code(upstreamResponse.status);
      copyUpstreamHeaders(reply, upstreamResponse.headers);
      reply.header("content-type", "application/json");
      reply.send(upstreamJson);
      return { kind: "handled" };
    }

    if (context.clientWantsStream) {
      const bootstrap = await bootstrapEventStream(upstreamResponse, context);
      if (bootstrap.kind === "continue") {
        return bootstrap;
      }

      return streamEventStreamToClient(reply, upstreamResponse, context, bootstrap);
    }

    appendUpstreamIdentityHeaders(reply, context);
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

export abstract class TransformedJsonProviderStrategy extends BaseProviderStrategy {
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

    appendUpstreamIdentityHeaders(reply, context);
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
