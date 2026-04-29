import type { FastifyReply } from "fastify";
import { BaseProviderStrategy } from "../base.js";
import {
  buildPayloadResult,
  type BuildPayloadResult,
  type LocalAttemptContext,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
} from "../shared.js";
import { normalizeLlamacppModelName } from "./llamacpp.js";

/**
 * Providers that speak OpenAI-compatible /v1/embeddings natively.
 * These never use the Ollama /api/embed path.
 */
export const OPENAI_COMPAT_EMBED_PROVIDERS = new Set(["llamacpp-embed", "llamacpp"]);

export function isOpenAiCompatEmbedProvider(providerId: string): boolean {
  return OPENAI_COMPAT_EMBED_PROVIDERS.has(providerId.trim().toLowerCase());
}

/**
 * Strategy for OpenAI-compatible embedding providers (llama.cpp server, etc.).
 * The actual HTTP dispatch is handled directly in embeddings.ts; this strategy
 * satisfies the registry contract and carries the provider identity.
 */
export class OpenAiCompatEmbeddingsStrategy extends BaseProviderStrategy {
  public readonly mode = "embeddings" as const;
  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.embeddingsPassthrough === true
      && isOpenAiCompatEmbedProvider(context.routeProviderId ?? "");
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return "/v1/embeddings";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const body = { ...context.requestBody };
    if (typeof body.model === "string") {
      body.model = normalizeLlamacppModelName(body.model);
    }
    return buildPayloadResult(body, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    // Embeddings are dispatched directly; this path is only reached if the
    // strategy executor is invoked explicitly in future.
    return super.handleProviderAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    return super.handleLocalAttempt(reply, response, context);
  }
}

/**
 * Strategy for Ollama-native embedding requests (/api/embed).
 */
export class OllamaEmbeddingsStrategy extends BaseProviderStrategy {
  public readonly mode = "embeddings" as const;
  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    return context.embeddingsPassthrough === true
      && !isOpenAiCompatEmbedProvider(context.routeProviderId ?? "");
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return "/api/embed";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildPayloadResult({ ...context.requestBody }, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return super.handleProviderAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    return super.handleLocalAttempt(reply, response, context);
  }
}
