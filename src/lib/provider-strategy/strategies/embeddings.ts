import { kernels } from "../../cljs-kernels.js";

/**
 * Providers that speak OpenAI-compatible /v1/embeddings natively (llama.cpp
 * server, etc.); they never use the Ollama /api/embed path. The embedding
 * strategies themselves are registry entries built in CLJS
 * (proxx.runtime.strategies).
 */
export function isOpenAiCompatEmbedProvider(providerId: string, manifestPath?: string): boolean {
  return kernels.isCompatEmbeddingProvider(providerId, manifestPath);
}
