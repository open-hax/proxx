/**
 * embeddings.ts
 *
 * Embedding strategies for proxx.
 *
 * Each provider extends BaseProviderStrategy so it participates in the
 * standard fallback/retry/logging pipeline.
 *
 * Modes added to UpstreamMode (in shared.ts):
 *   "hf_embeddings"   – HF cloud, native feature-extraction pipeline
 *   "tei_embeddings"  – self-hosted Text Embeddings Inference  (/embed)
 *   "ovm_embeddings"  – Intel OpenVINO Model Server  (/v3/embeddings)
 *
 * Routing:
 *   context.requestBody must contain { input: string | string[], model?: string }
 *   Strategy.matches() checks the x-embedding-provider header or a body flag.
 *
 * NOTE: HF cloud uses /pipeline/feature-extraction/<model>, NOT /v1/embeddings.
 *       The /v1/embeddings OpenAI shim on HF is chat-only at this time.
 */

import type { FastifyReply } from "fastify";
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
import { copyUpstreamHeaders } from "../../proxy.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isEmbeddingRequest(context: StrategyRequestContext): boolean {
  // Either an explicit header or the body looks like an embeddings request
  // (has `input` but no `messages`).
  const embedHeader = (context.clientHeaders["x-embedding-provider"] as string | undefined)?.trim().toLowerCase();
  if (embedHeader) return true;
  const body = context.requestBody;
  return isRecord(body) && "input" in body && !("messages" in body);
}

function embedProviderHeader(context: StrategyRequestContext): string | undefined {
  return (context.clientHeaders["x-embedding-provider"] as string | undefined)?.trim().toLowerCase();
}

async function handleEmbeddingAttempt(
  reply: FastifyReply,
  response: Response,
  context: ProviderAttemptContext,
): Promise<ProviderAttemptOutcome> {
  if (!response.ok) {
    return { kind: "continue", requestError: true };
  }
  reply.code(response.status);
  copyUpstreamHeaders(reply, response.headers);
  reply.header("content-type", "application/json");
  reply.send(await response.json());
  return { kind: "handled" };
}

async function handleEmbeddingLocalAttempt(
  reply: FastifyReply,
  response: Response,
  _context: LocalAttemptContext,
): Promise<void> {
  reply.code(response.status);
  copyUpstreamHeaders(reply, response.headers);
  reply.header("content-type", "application/json");
  reply.send(response.ok ? await response.json() : await response.text());
}

// ---------------------------------------------------------------------------
// Hugging Face cloud  (native inference, NOT OpenAI shim)
// Docs: https://huggingface.co/docs/inference-providers/en/index
// Default model: Qwen/Qwen3-Embedding-4B
// ---------------------------------------------------------------------------
export class HuggingFaceEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "hf_embeddings" as const;
  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    if (!isEmbeddingRequest(context)) return false;
    const provider = embedProviderHeader(context);
    return provider === "huggingface" || provider === "hf" || provider === "hf_embeddings";
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    const model = (context.requestBody["model"] as string | undefined) ?? "Qwen/Qwen3-Embedding-4B";
    // NOTE: NOT /v1/embeddings — native HF feature-extraction pipeline.
    return `/pipeline/feature-extraction/${encodeURIComponent(model)}`;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const inputs = context.requestBody["input"];
    const payload: Record<string, unknown> = {
      inputs: Array.isArray(inputs) ? inputs : [inputs],
    };
    if (context.requestBody["instruction"]) {
      payload["parameters"] = { prompt: context.requestBody["instruction"] };
    }
    if (context.requestBody["dimensions"]) {
      payload["parameters"] = {
        ...(isRecord(payload["parameters"]) ? payload["parameters"] : {}),
        truncate_dim: context.requestBody["dimensions"],
      };
    }
    return buildPayloadResult(payload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return handleEmbeddingAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    await handleEmbeddingLocalAttempt(reply, response, context);
  }
}

// ---------------------------------------------------------------------------
// TEI  (self-hosted Text Embeddings Inference)
// Docs: https://github.com/huggingface/text-embeddings-inference
// Hits native /embed (not OpenAI /v1/embeddings) for full feature parity.
// Default model: Qwen/Qwen3-Embedding-4B
// ---------------------------------------------------------------------------
export class TEIEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "tei_embeddings" as const;
  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    if (!isEmbeddingRequest(context)) return false;
    const provider = embedProviderHeader(context);
    return provider === "tei" || provider === "tei_embeddings";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    // Native TEI endpoint — NOT the OpenAI shim /v1/embeddings.
    return "/embed";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const inputs = context.requestBody["input"];
    const payload: Record<string, unknown> = {
      inputs: Array.isArray(inputs) ? inputs : [inputs],
    };
    if (context.requestBody["dimensions"]) {
      payload["truncate_dim"] = context.requestBody["dimensions"];
    }
    return buildPayloadResult(payload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return handleEmbeddingAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    await handleEmbeddingLocalAttempt(reply, response, context);
  }
}

// ---------------------------------------------------------------------------
// ovm-npu  (Intel OpenVINO Model Server)
// Docs: https://github.com/openvinotoolkit/model_server/blob/main/demos/embeddings/README.md
// Uses /v3/embeddings (OpenAI-compat embeddings path on OVMS).
// Intended for 0.6B NPU-optimised model only; route 4B variants to HF/TEI.
// Default model: OpenVINO/Qwen3-Embedding-0.6B-int8-ov
// ---------------------------------------------------------------------------
export class OvmNpuEmbeddingStrategy extends BaseProviderStrategy {
  public readonly mode = "ovm_embeddings" as const;
  public readonly isLocal = false;

  public matches(context: StrategyRequestContext): boolean {
    if (!isEmbeddingRequest(context)) return false;
    const provider = embedProviderHeader(context);
    return provider === "ovm" || provider === "ovm-npu" || provider === "ovm_embeddings";
  }

  public getUpstreamPath(_context: StrategyRequestContext): string {
    // OVMS uses OpenAI-compat /v3/embeddings (not /v1/embeddings).
    return "/v3/embeddings";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const inputs = context.requestBody["input"];
    const payload: Record<string, unknown> = {
      model: (context.requestBody["model"] as string | undefined) ?? "OpenVINO/Qwen3-Embedding-0.6B-int8-ov",
      input: Array.isArray(inputs) ? inputs : [inputs],
    };
    if (context.requestBody["dimensions"]) {
      payload["dimensions"] = context.requestBody["dimensions"];
    }
    return buildPayloadResult(payload, context);
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    return handleEmbeddingAttempt(reply, response, context);
  }

  public override async handleLocalAttempt(
    reply: FastifyReply,
    response: Response,
    context: LocalAttemptContext,
  ): Promise<void> {
    await handleEmbeddingLocalAttempt(reply, response, context);
  }
}
