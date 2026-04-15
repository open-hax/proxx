import type { FastifyReply } from "fastify";

import {
  chatRequestToOllamaRequest,
  ollamaToChatCompletion,
  streamOllamaNdjsonToChatCompletionSse,
} from "../../ollama-compat.js";
import { toErrorMessage } from "../../errors/index.js";
import { BaseProviderStrategy } from "../base.js";
import {
  buildPayloadResult,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
} from "../shared.js";

/**
 * Strategy for ollama-cloud (https://ollama.com) that uses their native /api/chat endpoint
 * instead of the OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Ollama-cloud serves GLM models (glm-5.1, glm-5, glm-4.7, glm-4.6) and other models
 * via their native API, which is more reliable than the OpenAI compatibility layer.
 */
export class OllamaCloudProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "ollama_chat" as const;

  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.routeProviderId === "ollama-cloud"
      && context.responsesPassthrough !== true
      && context.imagesPassthrough !== true;
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return "/api/chat";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildPayloadResult(chatRequestToOllamaRequest(context.requestBody, context.config.ollamaModelPrefixes), context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    if (!upstreamResponse.ok) {
      return this.handleStandardProviderAttempt(reply, upstreamResponse, context);
    }

    // Handle streaming responses
    if (context.clientWantsStream && upstreamResponse.body) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.header("x-open-hax-upstream-provider", context.providerId);
      reply.hijack();
      const rawResponse = reply.raw;
      rawResponse.statusCode = 200;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          rawResponse.setHeader(name, value as never);
        }
      }
      rawResponse.flushHeaders();

      try {
        await streamOllamaNdjsonToChatCompletionSse(upstreamResponse.body, context.routedModel, (data) => {
          rawResponse.write(data);
          (rawResponse as { flush?: () => void }).flush?.();
        });
      } catch (error) {
        if (!rawResponse.writableEnded) {
          rawResponse.write(`data: ${JSON.stringify({ error: { message: toErrorMessage(error) } })}\n\n`);
        }
      }

      if (!rawResponse.writableEnded) {
        rawResponse.end();
      }
      return { kind: "handled" };
    }

    // Handle non-streaming responses
    let upstreamJson: unknown;
    try {
      upstreamJson = await upstreamResponse.json();
    } catch (_error) {
      return {
        kind: "continue",
        requestError: true,
      };
    }

    const chatCompletion = ollamaToChatCompletion(upstreamJson, context.routedModel);

    reply.header("content-type", "application/json");
    reply.header("x-open-hax-upstream-provider", context.providerId);
    reply.send(chatCompletion);
    return { kind: "handled" };
  }
}
