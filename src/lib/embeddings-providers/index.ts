/**
 * embeddings-providers/index.ts
 *
 * Provider implementations for each embedding backend. The request shapes and
 * response normalisation live in CLJS (proxx.embeddings.providers); each
 * function accepts a resolved config + request and returns a normalised
 * EmbeddingResponse.
 */

import { kernels } from '../cljs-kernels.js';
import type {
  EmbeddingProviderConfig,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../embeddings-strategy.js';

/** Ollama (existing path — unchanged semantics). */
export async function embedWithOllama(cfg: EmbeddingProviderConfig, req: EmbeddingRequest): Promise<EmbeddingResponse> {
  return await kernels.embedWithOllama(cfg, req);
}

/** Hugging Face cloud (native HF inference flow, NOT the OpenAI compat shim). */
export async function embedWithHFCloud(cfg: EmbeddingProviderConfig, req: EmbeddingRequest): Promise<EmbeddingResponse> {
  return await kernels.embedWithHFCloud(cfg, req);
}

/** Self-hosted Text Embeddings Inference, native /embed endpoint. */
export async function embedWithTEI(cfg: EmbeddingProviderConfig, req: EmbeddingRequest): Promise<EmbeddingResponse> {
  return await kernels.embedWithTEI(cfg, req);
}

/** Intel OpenVINO Model Server, /v3/embeddings (0.6B model only). */
export async function embedWithOvmNpu(cfg: EmbeddingProviderConfig, req: EmbeddingRequest): Promise<EmbeddingResponse> {
  return await kernels.embedWithOvmNpu(cfg, req);
}
