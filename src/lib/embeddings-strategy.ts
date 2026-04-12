/**
 * embeddings-strategy.ts
 *
 * Multi-provider embedding strategy for proxx.
 *
 * Providers:
 *   ollama           - existing local path, unchanged default
 *   huggingface-cloud - HF Inference Providers serverless (free-tier friendly)
 *   tei              - self-hosted Text Embeddings Inference
 *   ovm-npu          - Intel OpenVINO Model Server /v3/embeddings (NPU-optimised)
 *
 * Model intent:
 *   ollama           -> any model available via Ollama (e.g. nomic-embed-text)
 *   huggingface-cloud -> Qwen/Qwen3-Embedding-4B  (routed, free-tier credits)
 *   tei              -> Qwen/Qwen3-Embedding-4B  (self-hosted TEI)
 *   ovm-npu          -> OpenVINO/Qwen3-Embedding-0.6B-int8-ov  (NPU local)
 *
 * NOTE: HF cloud uses the native HF inference flow, NOT the OpenAI embeddings shim.
 *       The /v1/embeddings OpenAI-compat route on HF is chat-only at this time.
 */

export type EmbeddingProvider =
  | 'ollama'
  | 'huggingface-cloud'
  | 'tei'
  | 'ovm-npu';

export type EmbeddingMode = 'query' | 'document';

export interface EmbeddingRequest {
  provider: EmbeddingProvider;
  model: string;
  input: string | string[];
  mode?: EmbeddingMode;
  /** Qwen3 instruction-aware prefix (optional, passed in prompt field) */
  instruction?: string;
  /** Truncate output to N dimensions if model supports matryoshka */
  dimensions?: number;
  timeoutMs?: number;
}

export interface EmbeddingResponse {
  provider: EmbeddingProvider;
  model: string;
  embeddings: number[][];
  dimensions: number;
  usage?: { promptTokens: number; totalTokens: number };
}

export interface EmbeddingProviderConfig {
  endpoint: string;
  apiKey?: string;
  defaultModel?: string;
  defaultDimensions?: number;
  timeoutMs?: number;
}

/** Per-provider config, loaded from env (see .env.example additions) */
export interface EmbeddingsConfig {
  ollama: EmbeddingProviderConfig;
  'huggingface-cloud': EmbeddingProviderConfig;
  tei: EmbeddingProviderConfig;
  'ovm-npu': EmbeddingProviderConfig;
  defaultProvider: EmbeddingProvider;
  fallbackProvider?: EmbeddingProvider;
}

export function loadEmbeddingsConfig(): EmbeddingsConfig {
  return {
    ollama: {
      endpoint: process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434',
      defaultModel: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
    },
    'huggingface-cloud': {
      endpoint: process.env.HF_INFERENCE_ENDPOINT ?? 'https://api-inference.huggingface.co',
      apiKey: process.env.HF_API_KEY,
      defaultModel: process.env.HF_EMBED_MODEL ?? 'Qwen/Qwen3-Embedding-4B',
      defaultDimensions: process.env.HF_EMBED_DIMENSIONS
        ? parseInt(process.env.HF_EMBED_DIMENSIONS, 10)
        : undefined,
    },
    tei: {
      endpoint: process.env.TEI_ENDPOINT ?? 'http://localhost:8080',
      apiKey: process.env.TEI_API_KEY,
      defaultModel: process.env.TEI_EMBED_MODEL ?? 'Qwen/Qwen3-Embedding-4B',
      defaultDimensions: process.env.TEI_EMBED_DIMENSIONS
        ? parseInt(process.env.TEI_EMBED_DIMENSIONS, 10)
        : undefined,
    },
    'ovm-npu': {
      endpoint: process.env.OVM_NPU_ENDPOINT ?? 'http://localhost:9000',
      apiKey: process.env.OVM_NPU_API_KEY,
      defaultModel:
        process.env.OVM_NPU_EMBED_MODEL ?? 'OpenVINO/Qwen3-Embedding-0.6B-int8-ov',
      defaultDimensions: process.env.OVM_NPU_EMBED_DIMENSIONS
        ? parseInt(process.env.OVM_NPU_EMBED_DIMENSIONS, 10)
        : undefined,
    },
    defaultProvider: (process.env.EMBED_DEFAULT_PROVIDER as EmbeddingProvider) ?? 'ollama',
    fallbackProvider: process.env.EMBED_FALLBACK_PROVIDER as EmbeddingProvider | undefined,
  };
}
