import type { FastifyReply } from "fastify";
import { copyUpstreamHeaders } from "../../proxy.js";
import { kernels } from "../../cljs-kernels.js";
import { BaseProviderStrategy } from "../base.js";
import {
  buildStrategyPayloadResult,
  strategyUpstreamPath,
  type BuildPayloadResult,
  type LocalAttemptContext,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
} from "../shared.js";

/**
 * Providers that speak OpenAI-compatible /v1/embeddings natively.
 * These never use the Ollama /api/embed path.
 */
export function isOpenAiCompatEmbedProvider(providerId: string, manifestPath?: string): boolean {
  return kernels.isCompatEmbeddingProvider(providerId, manifestPath);
}

async function handleNativeEmbeddingAttempt(
  reply: FastifyReply,
  response: Response,
  _context: ProviderAttemptContext,
): Promise<ProviderAttemptOutcome> {
  if (!response.ok) {
    return { kind: "continue", requestError: true };
  }

  reply.code(response.status);
  copyUpstreamHeaders(reply, response.headers);
  reply.header("content-type", response.headers.get("content-type") ?? "application/json");
  reply.send(await response.text());
  return { kind: "handled" };
}

async function handleNativeEmbeddingLocalAttempt(
  reply: FastifyReply,
  response: Response,
  _context: LocalAttemptContext,
): Promise<void> {
  reply.code(response.status);
  copyUpstreamHeaders(reply, response.headers);
  reply.header("content-type", response.headers.get("content-type") ?? "application/json");
  reply.send(await response.text());
}

/**
 * Strategy for OpenAI-compatible embedding providers (llama.cpp server, etc.).
 * The actual HTTP dispatch is handled directly in embeddings.ts; this strategy
 * satisfies the registry contract and carries the provider identity.
 */
export class OpenAiCompatEmbeddingsStrategy extends BaseProviderStrategy {
  public readonly mode = "embeddings" as const;
  public readonly isLocal = false;
  public readonly registryId: string = "openai-compat-embeddings";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("openai-compat-embeddings", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("openai-compat-embeddings", context);
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
  public readonly registryId: string = "ollama-embeddings";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("ollama-embeddings", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("ollama-embeddings", context);
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

/**
 * Hugging Face cloud native feature-extraction strategy.
 * Uses /pipeline/feature-extraction/<model>, not the OpenAI shim.
 */
export class HuggingFaceEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "hf_embeddings" as const;
  public readonly isLocal = false;
  public readonly registryId: string = "hf-embeddings";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("hf-embeddings", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("hf-embeddings", context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return handleNativeEmbeddingAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    await handleNativeEmbeddingLocalAttempt(reply, response, context);
  }
}

/**
 * Hugging Face Text Embeddings Inference strategy for native /embed.
 */
export class TEIEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "tei_embeddings" as const;
  public readonly isLocal = false;
  public readonly registryId: string = "tei-embeddings";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("tei-embeddings", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("tei-embeddings", context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return handleNativeEmbeddingAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    await handleNativeEmbeddingLocalAttempt(reply, response, context);
  }
}

/**
 * Intel OpenVINO Model Server embeddings strategy for /v3/embeddings.
 */
export class OvmNpuEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "ovm_embeddings" as const;
  public readonly isLocal = false;
  public readonly registryId: string = "ovm-embeddings";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("ovm-embeddings", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("ovm-embeddings", context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return handleNativeEmbeddingAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    await handleNativeEmbeddingLocalAttempt(reply, response, context);
  }
}
