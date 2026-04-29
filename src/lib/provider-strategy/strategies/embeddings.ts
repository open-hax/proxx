import type { FastifyReply } from "fastify";
import { copyUpstreamHeaders } from "../../proxy.js";
import { BaseProviderStrategy } from "../base.js";
import {
  buildPayloadResult,
  isRecord,
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

function requestLooksLikeEmbedding(context: StrategyRequestContext): boolean {
  const body = context.requestBody;
  return context.embeddingsPassthrough === true
    || (isRecord(body) && "input" in body && !("messages" in body));
}

function readEmbeddingProviderHeader(context: StrategyRequestContext): string | undefined {
  const raw = context.clientHeaders["x-embedding-provider"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim().toLowerCase();
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

/**
 * Hugging Face cloud native feature-extraction strategy.
 * Uses /pipeline/feature-extraction/<model>, not the OpenAI shim.
 */
export class HuggingFaceEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "hf_embeddings" as const;
  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    if (!requestLooksLikeEmbedding(context)) {
      return false;
    }
    const provider = readEmbeddingProviderHeader(context);
    return provider === "huggingface" || provider === "hf" || provider === "hf_embeddings";
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    const model = typeof context.requestBody.model === "string"
      ? context.requestBody.model
      : "Qwen/Qwen3-Embedding-4B";
    return `/pipeline/feature-extraction/${encodeURIComponent(model)}`;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const inputs = context.requestBody.input;
    const payload: Record<string, unknown> = {
      inputs: Array.isArray(inputs) ? inputs : [inputs],
    };
    if (context.requestBody.instruction !== undefined) {
      payload.parameters = { prompt: context.requestBody.instruction };
    }
    if (context.requestBody.dimensions !== undefined) {
      payload.parameters = {
        ...(isRecord(payload.parameters) ? payload.parameters : {}),
        truncate_dim: context.requestBody.dimensions,
      };
    }
    return buildPayloadResult(payload, context);
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

  public matches(context: StrategyRequestContext): boolean {
    if (!requestLooksLikeEmbedding(context)) {
      return false;
    }
    const provider = readEmbeddingProviderHeader(context);
    return provider === "tei" || provider === "tei_embeddings";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return "/embed";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const inputs = context.requestBody.input;
    const payload: Record<string, unknown> = {
      inputs: Array.isArray(inputs) ? inputs : [inputs],
    };
    if (context.requestBody.dimensions !== undefined) {
      payload.truncate_dim = context.requestBody.dimensions;
    }
    return buildPayloadResult(payload, context);
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

  public matches(context: StrategyRequestContext): boolean {
    if (!requestLooksLikeEmbedding(context)) {
      return false;
    }
    const provider = readEmbeddingProviderHeader(context);
    return provider === "ovm" || provider === "ovm-npu" || provider === "ovm_embeddings";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return "/v3/embeddings";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const inputs = context.requestBody.input;
    const payload: Record<string, unknown> = {
      model: typeof context.requestBody.model === "string"
        ? context.requestBody.model
        : "OpenVINO/Qwen3-Embedding-0.6B-int8-ov",
      input: Array.isArray(inputs) ? inputs : [inputs],
    };
    if (context.requestBody.dimensions !== undefined) {
      payload.dimensions = context.requestBody.dimensions;
    }
    return buildPayloadResult(payload, context);
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
