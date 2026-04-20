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
} from "../errors/index.js";
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

function looksLikeSsePayload(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("data:") || trimmed.startsWith(":");
}

async function readResponseTextWithBootstrap(
  upstreamResponse: Response,
  bootstrapTimeoutMs: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  if (!upstreamResponse.body) {
    return { ok: true, text: await upstreamResponse.text() };
  }

  const reader = (upstreamResponse.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + Math.max(0, bootstrapTimeoutMs);

  const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array> | null> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }

    const timeout = new Promise<null>((resolve) => {
      setTimeout(resolve, remainingMs);
    });
    const result = await Promise.race([reader.read(), timeout]);
    return result === null ? null : (result as ReadableStreamReadResult<Uint8Array>);
  };

  // Require the first bytes to arrive within the bootstrap window.
  const first = await readWithTimeout();
  if (!first || first.done) {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    return { ok: false };
  }

  let text = decoder.decode(first.value, { stream: true });
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true, text };
}

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

      // Image generation responses don't follow the chat/responses JSON shapes.
      // Accept them as-is and let handleSuccessfulProviderAttempt pass them through.
      if (this.mode === "images") {
        return this.handleSuccessfulProviderAttempt(reply, upstreamResponse, context);
      }

      // For non-stream requests, sanity-check that the upstream returned a JSON
      // payload we can plausibly forward. For stream requests, defer validation
      // to the streaming handler so we can accept mislabelled SSE payloads.
      if (!isEventStream && !context.clientWantsStream) {
        try {
          const bodyText = await upstreamResponse.clone().text();
          if (bodyText.length === 0) {
            return { kind: "continue", requestError: true };
          }
          const parsed = JSON.parse(bodyText);
          if (
            typeof parsed !== "object" || parsed === null
            || (!("choices" in parsed) && !("object" in parsed) && !("id" in parsed))
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
      // Some upstreams will ignore `stream=true` and return a normal JSON
      // ChatCompletion payload. In that case, translate it into an SSE stream
      // so clients still receive an event-stream.
      const contentType = (upstreamResponse.headers.get("content-type") ?? "").toLowerCase();
      const declaredEventStream = contentType.includes("text/event-stream");

      // Some upstreams incorrectly label their SSE responses as JSON. If the
      // body is already SSE, treat it as such.
      if (!declaredEventStream) {
        const responseText = await upstreamResponse.text();
        const stripped = stripSseCommentLines(responseText);
        if (looksLikeSsePayload(stripped)) {
          const streamText = stripped;

          if (streamPayloadIndicatesQuotaError(streamText) && context.hasMoreCandidates) {
            return {
              kind: "continue",
              rateLimit: true,
            };
          }

          if (!streamPayloadHasSubstantiveChunks(streamText)) {
            return {
              kind: "continue",
              requestError: true,
            };
          }

          if (context.needsReasoningTrace && !streamPayloadHasReasoningTrace(streamText) && context.hasMoreCandidates) {
            return {
              kind: "continue",
              requestError: true,
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

        // Otherwise treat it like a normal JSON completion and convert to SSE.
        let upstreamJson: unknown;
        try {
          upstreamJson = JSON.parse(responseText);
        } catch {
          return {
            kind: "continue",
            requestError: true,
          };
        }

        appendUpstreamIdentityHeaders(reply, context);
        reply.code(upstreamResponse.status);
        copyUpstreamHeaders(reply, upstreamResponse.headers);
        reply.removeHeader("content-length");
        reply.header("cache-control", "no-cache");
        reply.header("x-accel-buffering", "no");
        reply.header("content-type", "text/event-stream; charset=utf-8");
        reply.send(chatCompletionToSse(isRecord(upstreamJson) ? upstreamJson : { error: upstreamJson }));
        return { kind: "handled" };
      }

      const bootstrapResult = await readResponseTextWithBootstrap(
        upstreamResponse,
        Math.min(context.config.requestTimeoutMs, context.config.streamBootstrapTimeoutMs),
      );
      if (!bootstrapResult.ok) {
        return {
          kind: "continue",
          requestError: true,
        };
      }

      const streamText = stripSseCommentLines(bootstrapResult.text);
      if (streamPayloadIndicatesQuotaError(streamText) && context.hasMoreCandidates) {
        return {
          kind: "continue",
          rateLimit: true
        };
      }

      // Even if this is the last candidate, a stream with no substantive chunks
      // is treated as an upstream failure so the caller receives a 502.
      if (!streamPayloadHasSubstantiveChunks(streamText)) {
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
