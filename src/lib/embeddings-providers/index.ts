/**
 * embeddings-providers/index.ts
 *
 * Provider implementations for each embedding backend.
 * Each provider function accepts a resolved config + request
 * and returns a normalised EmbeddingResponse.
 */

import type {
  EmbeddingProviderConfig,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../embeddings-strategy.js';

// ---------------------------------------------------------------------------
// Ollama  (existing path — unchanged semantics)
// ---------------------------------------------------------------------------
export async function embedWithOllama(
  cfg: EmbeddingProviderConfig,
  req: EmbeddingRequest,
): Promise<EmbeddingResponse> {
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const url = `${cfg.endpoint}/api/embed`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: req.model, input: inputs }),
    signal: AbortSignal.timeout(req.timeoutMs ?? cfg.timeoutMs ?? 30_000),
  });

  if (!res.ok) throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { embeddings: number[][] };
  return {
    provider: 'ollama',
    model: req.model,
    embeddings: data.embeddings,
    dimensions: data.embeddings[0]?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Hugging Face cloud  (native HF inference flow, NOT OpenAI compat shim)
// Docs: https://huggingface.co/docs/inference-providers/en/index
// ---------------------------------------------------------------------------
export async function embedWithHFCloud(
  cfg: EmbeddingProviderConfig,
  req: EmbeddingRequest,
): Promise<EmbeddingResponse> {
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const model = req.model;
  const url = `${cfg.endpoint}/pipeline/feature-extraction/${encodeURIComponent(model)}`;

  const body: Record<string, unknown> = { inputs };
  if (req.instruction) body['parameters'] = { prompt: req.instruction };
  if (req.dimensions) body['parameters'] = { ...(body['parameters'] as object), truncate_dim: req.dimensions };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs ?? cfg.timeoutMs ?? 30_000),
  });

  if (!res.ok) throw new Error(`HF cloud embed error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as number[][] | number[][][];
  // HF returns shape [batch, dims] or [batch, seq, dims]; normalise to [batch, dims]
  const embeddings = (data as number[][][]).every(Array.isArray)
    ? (data as number[][][]).map((seq) => seq[0])
    : (data as number[][]);

  return {
    provider: 'huggingface-cloud',
    model,
    embeddings,
    dimensions: embeddings[0]?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// TEI  (self-hosted Text Embeddings Inference)
// Docs: https://github.com/huggingface/text-embeddings-inference
// Exposes /embed  (TEI native) and /v1/embeddings (OpenAI-compat)
// We prefer the native /embed endpoint here for full feature parity.
// ---------------------------------------------------------------------------
export async function embedWithTEI(
  cfg: EmbeddingProviderConfig,
  req: EmbeddingRequest,
): Promise<EmbeddingResponse> {
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const url = `${cfg.endpoint}/embed`;

  const body: Record<string, unknown> = { inputs };
  if (req.dimensions) body['truncate_dim'] = req.dimensions;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs ?? cfg.timeoutMs ?? 30_000),
  });

  if (!res.ok) throw new Error(`TEI embed error ${res.status}: ${await res.text()}`);

  const embeddings = (await res.json()) as number[][];
  return {
    provider: 'tei',
    model: req.model,
    embeddings,
    dimensions: embeddings[0]?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// ovm-npu  (Intel OpenVINO Model Server, /v3/embeddings path)
// Docs: https://github.com/openvinotoolkit/model_server/blob/main/demos/embeddings/README.md
// Primary model: OpenVINO/Qwen3-Embedding-0.6B-int8-ov
// NOTE: ovm-npu is for 0.6B only — use HF cloud or TEI for 4B variants.
// ---------------------------------------------------------------------------
export async function embedWithOvmNpu(
  cfg: EmbeddingProviderConfig,
  req: EmbeddingRequest,
): Promise<EmbeddingResponse> {
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const url = `${cfg.endpoint}/v3/embeddings`;

  const body: Record<string, unknown> = {
    model: req.model,
    input: inputs,
  };
  if (req.dimensions) body['dimensions'] = req.dimensions;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs ?? cfg.timeoutMs ?? 30_000),
  });

  if (!res.ok) throw new Error(`ovm-npu embed error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { prompt_tokens: number; total_tokens: number };
  };

  const embeddings = data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return {
    provider: 'ovm-npu',
    model: req.model,
    embeddings,
    dimensions: embeddings[0]?.length ?? 0,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, totalTokens: data.usage.total_tokens }
      : undefined,
  };
}
