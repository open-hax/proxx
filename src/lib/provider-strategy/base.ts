import { Readable } from "node:stream";

import type { FastifyReply } from "fastify";

import { copyUpstreamHeaders } from "../proxy.js";
import { chatCompletionToSse } from "../responses-compat.js";
import {
  chatCompletionHasReasoningContent,
  responseIndicatesMissingModel,
  responseIndicatesModelNotSupportedForAccount,
  stripSseCommentLines,
  streamPayloadHasReasoningTrace,
  streamPayloadHasSubstantiveChunks,
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

          if (context.clientWantsStream && /(^|\n)data:\s*(?!\[DONE\])/imu.test(bodyText)) {
            return this.handleSuccessfulProviderAttempt(reply, upstreamResponse, context);
          }

          const parsed = JSON.parse(bodyText);
          const isImagePayload =
            this.mode === "images"
            && typeof parsed === "object"
            && parsed !== null
            && Array.isArray((parsed as Record<string, unknown>)["data"]);
          if (
            !isImagePayload && (
              typeof parsed !== "object" || parsed === null
              || (!("choices" in parsed) && !("object" in parsed) && !("id" in parsed))
            )
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

  private startValidatedStreamReply(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext,
  ): FastifyReply["raw"] {
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
    return rawResponse;
  }

  private async relayValidatedStreamResponse(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome | null> {
    if (!upstreamResponse.body || context.needsReasoningTrace) {
      return null;
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bufferedChunks = "";
    let sawSubstantiveChunk = false;
    let rawResponse: FastifyReply["raw"] | null = null;

    const flushBufferedChunks = (): void => {
      if (bufferedChunks.length === 0) {
        return;
      }

      rawResponse ??= this.startValidatedStreamReply(reply, upstreamResponse, context);
      rawResponse.write(bufferedChunks);
      bufferedChunks = "";
    };

    const processEvent = (eventText: string): ProviderAttemptOutcome | null => {
      const normalizedChunk = stripSseCommentLines(eventText).trim();
      if (normalizedChunk.length === 0) {
        return null;
      }

      const serializedChunk = `${normalizedChunk}\n\n`;
      const hasSubstantiveChunk = streamPayloadHasSubstantiveChunks(serializedChunk);
      if (!sawSubstantiveChunk) {
        if (streamPayloadIndicatesQuotaError(serializedChunk) && context.hasMoreCandidates) {
          return {
            kind: "continue",
            rateLimit: true,
          };
        }

        if (!hasSubstantiveChunk) {
          bufferedChunks += serializedChunk;
          return null;
        }

        sawSubstantiveChunk = true;
      }

      bufferedChunks += serializedChunk;
      flushBufferedChunks();
      return null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex >= 0) {
          const eventText = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const outcome = processEvent(eventText);
          if (outcome) {
            void reader.cancel();
            return outcome;
          }
          separatorIndex = buffer.indexOf("\n\n");
        }

        if (done) {
          break;
        }
      }

      if (buffer.trim().length > 0) {
        const outcome = processEvent(buffer);
        if (outcome) {
          return outcome;
        }
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // ignore cleanup errors
      }

      const destroyableResponse = rawResponse as (FastifyReply["raw"] & {
        readonly writableEnded?: boolean;
        readonly destroyed?: boolean;
        destroy?: (error?: Error) => void;
      }) | null;
      if (destroyableResponse && destroyableResponse.writableEnded !== true && destroyableResponse.destroyed !== true) {
        destroyableResponse.destroy?.(error instanceof Error ? error : undefined);
      }

      throw error;
    } finally {
      reader.releaseLock();
    }

    if (!sawSubstantiveChunk && context.hasMoreCandidates) {
      return {
        kind: "continue",
        requestError: true,
      };
    }

    if (!rawResponse && bufferedChunks.length > 0) {
      rawResponse = this.startValidatedStreamReply(reply, upstreamResponse, context);
      rawResponse.write(bufferedChunks);
      bufferedChunks = "";
    }

    if (rawResponse) {
      rawResponse.end();
      return { kind: "handled" };
    }

    return {
      kind: "continue",
      requestError: true,
    };
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
      if (!upstreamResponse.body) {
        return {
          kind: "continue",
          requestError: true
        };
      }

      if (!context.needsReasoningTrace) {
        const relayedOutcome = await this.relayValidatedStreamResponse(reply, upstreamResponse, context);
        if (relayedOutcome) {
          return relayedOutcome;
        }
      }

      const streamText = stripSseCommentLines(await upstreamResponse.text());
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
      rawResponse.write(streamText);
      rawResponse.end();
      return { kind: "handled" };
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
