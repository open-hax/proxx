import { Readable } from "node:stream";

import type { FastifyReply } from "fastify";

import { copyUpstreamHeaders } from "../proxy.js";
import { chatCompletionToSse } from "../responses-compat.js";
import {
  stripSseCommentLines,
  streamPayloadHasSubstantiveChunks,
  chatCompletionHasReasoningContent,
} from "../sse/index.js";
import { kernels } from "../cljs-kernels.js";
import {
  responseIndicatesMissingModel,
  responseIndicatesModelNotSupportedForAccount,
  summarizeUpstreamError,
} from "../errors/index.js";
import {
  type BuildPayloadResult,
  isRecord,
  selectionFacts,
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

type StreamBootstrapResult = Awaited<ReturnType<typeof kernels.bootstrapEventStream>>;

/*
 * Whether a stream has proven itself (substantive data, no hidden quota error,
 * a reasoning trace when required) is decided in CLJS: the bootstrap reader loop
 * and its verdict live in proxx.strategy.attempt / proxx.runtime.strategy.
 */
async function bootstrapEventStream(
  upstreamResponse: Response,
  context: ProviderAttemptContext,
): Promise<StreamBootstrapResult> {
  return kernels.bootstrapEventStream(upstreamResponse, {
    timeoutMs: context.upstreamAttemptTimeoutMs,
    needsReasoningTrace: context.needsReasoningTrace,
    hasMoreCandidates: context.hasMoreCandidates,
  });
}

async function streamEventStreamToClient(
  reply: FastifyReply,
  upstreamResponse: Response,
  context: ProviderAttemptContext,
  bootstrap: Extract<StreamBootstrapResult, { readonly kind: "ready" }>,
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

  /** Id of this strategy's entry in the strategy registry (78-strategy-registry.edn). */
  public abstract readonly registryId: string;

  /** Whether the registry's predicates accept this request. */
  public matches(context: StrategyRequestContext): boolean {
    return kernels.strategyMatches(this.registryId, selectionFacts(context), context.config?.cljsPolicyManifestPath);
  }

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
      const isEventStream = kernels.isEventStreamContentType(contentType);

      if (!isEventStream) {
        let bodyText: string;
        try {
          bodyText = await upstreamResponse.clone().text();
        } catch {
          return { kind: "continue", requestError: true };
        }

        const verdict = kernels.okBodyVerdict(bodyText, {
          clientWantsStream: context.clientWantsStream,
          streamLike: context.clientWantsStream && streamPayloadHasSubstantiveChunks(stripSseCommentLines(bodyText)),
          imagesPassthrough: context.imagesPassthrough === true,
          providerId: context.providerId,
        });
        if (verdict === "stream-like") {
          return this.handleSuccessfulProviderAttempt(reply, upstreamResponse, context);
        }
        if (verdict !== "ok") {
          return { kind: "continue", requestError: true };
        }
      }

      return this.handleSuccessfulProviderAttempt(reply, upstreamResponse, context);
    }

    const isMissingModel = await responseIndicatesMissingModel(upstreamResponse, context.routedModel);
    const modelNotSupported = !isMissingModel
      && await responseIndicatesModelNotSupportedForAccount(upstreamResponse, context.routedModel);
    const bodyNeeded = isMissingModel || modelNotSupported
      ? undefined
      : kernels.failedBodyNeeded(upstreamResponse.status);

    let authMessage: string | undefined;
    let errorBody: string | undefined;
    if (bodyNeeded === "auth-summary") {
      authMessage = (await summarizeUpstreamError(upstreamResponse)).upstreamErrorMessage;
    }
    if (bodyNeeded === "text") {
      try {
        errorBody = await upstreamResponse.text();
      } catch {
        // Ignore body read failures while failing over.
      }
    } else {
      try {
        await upstreamResponse.arrayBuffer();
      } catch {
        // Ignore body read failures while failing over.
      }
    }

    return kernels.failedAttemptOutcome({
      status: upstreamResponse.status,
      missingModel: isMissingModel,
      modelNotSupported,
      authMessage,
      errorBody,
    });
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
        reply.hijack();
        const rawResponse = reply.raw;
        rawResponse.statusCode = upstreamResponse.status;
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) {
            rawResponse.setHeader(name, value as never);
          }
        }
        rawResponse.flushHeaders();
        stream.pipe(rawResponse);
        stream.on("error", () => {
          if (!rawResponse.writableEnded) {
            rawResponse.end();
          }
        });
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
      reply.hijack();
      const rawResponse = reply.raw;
      rawResponse.statusCode = upstreamResponse.status;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          rawResponse.setHeader(name, value as never);
        }
      }
      rawResponse.flushHeaders();
      stream.pipe(rawResponse);
      stream.on("error", () => {
        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
      });
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
    const mode = kernels.successMode(context);
    if (mode === "reasoning-json") {
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
      if (kernels.missingReasoningSkips(context, hasReasoning)) {
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

    if (mode === "stream") {
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
    if (kernels.missingReasoningSkips(context, chatCompletionHasReasoningContent(chatCompletion))) {
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
