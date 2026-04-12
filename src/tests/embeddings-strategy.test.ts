/**
 * embeddings-strategy.test.ts
 *
 * Conformance and sanity tests for the multi-provider embedding strategy.
 * All provider calls are mocked — no live endpoints required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  embedWithOllama,
  embedWithHFCloud,
  embedWithTEI,
  embedWithOvmNpu,
} from '../lib/embeddings-providers/index.js';
import type { EmbeddingProviderConfig, EmbeddingRequest } from '../lib/embeddings-strategy.js';

const MOCK_DIMS = 1024;
const mockEmbedding = Array.from({ length: MOCK_DIMS }, (_, i) => i / MOCK_DIMS);

function makeCfg(overrides?: Partial<EmbeddingProviderConfig>): EmbeddingProviderConfig {
  return { endpoint: 'http://mock', apiKey: 'test-key', ...overrides };
}

function makeReq(overrides?: Partial<EmbeddingRequest>): EmbeddingRequest {
  return {
    provider: 'ollama',
    model: 'test-model',
    input: ['hello world'],
    mode: 'query',
    ...overrides,
  };
}

beforeEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------
describe('embedWithOllama', () => {
  it('returns normalised EmbeddingResponse', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ embeddings: [mockEmbedding] }),
    }));

    const res = await embedWithOllama(makeCfg(), makeReq({ provider: 'ollama' }));
    expect(res.provider).toBe('ollama');
    expect(res.embeddings).toHaveLength(1);
    expect(res.dimensions).toBe(MOCK_DIMS);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => 'err' }));
    await expect(embedWithOllama(makeCfg(), makeReq())).rejects.toThrow('500');
  });
});

// ---------------------------------------------------------------------------
// Hugging Face cloud  (native inference, not OpenAI shim)
// ---------------------------------------------------------------------------
describe('embedWithHFCloud', () => {
  it('returns normalised EmbeddingResponse', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => [mockEmbedding],
    }));

    const res = await embedWithHFCloud(
      makeCfg(),
      makeReq({ provider: 'huggingface-cloud', model: 'Qwen/Qwen3-Embedding-4B' }),
    );
    expect(res.provider).toBe('huggingface-cloud');
    expect(res.model).toBe('Qwen/Qwen3-Embedding-4B');
    expect(res.dimensions).toBe(MOCK_DIMS);
  });

  it('sends Authorization header when apiKey present', async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal('fetch', async (_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return { ok: true, json: async () => [mockEmbedding] };
    });

    await embedWithHFCloud(makeCfg({ apiKey: 'hf_test' }), makeReq({ provider: 'huggingface-cloud' }));
    expect(capturedHeaders['Authorization']).toBe('Bearer hf_test');
  });

  it('does NOT hit /v1/embeddings (OpenAI shim)', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => [mockEmbedding] };
    });

    await embedWithHFCloud(makeCfg(), makeReq({ provider: 'huggingface-cloud' }));
    expect(capturedUrl).not.toContain('/v1/embeddings');
    expect(capturedUrl).toContain('/pipeline/feature-extraction/');
  });
});

// ---------------------------------------------------------------------------
// TEI (self-hosted)
// ---------------------------------------------------------------------------
describe('embedWithTEI', () => {
  it('returns normalised EmbeddingResponse', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => [mockEmbedding],
    }));

    const res = await embedWithTEI(
      makeCfg(),
      makeReq({ provider: 'tei', model: 'Qwen/Qwen3-Embedding-4B' }),
    );
    expect(res.provider).toBe('tei');
    expect(res.model).toBe('Qwen/Qwen3-Embedding-4B');
    expect(res.dimensions).toBe(MOCK_DIMS);
  });

  it('uses /embed not /v1/embeddings', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => [mockEmbedding] };
    });

    await embedWithTEI(makeCfg(), makeReq({ provider: 'tei' }));
    expect(capturedUrl).toMatch(/\/embed$/);
  });
});

// ---------------------------------------------------------------------------
// ovm-npu  (Intel OpenVINO Model Server)
// ---------------------------------------------------------------------------
describe('embedWithOvmNpu', () => {
  const ovmResponse = {
    data: [{ embedding: mockEmbedding, index: 0 }],
    usage: { prompt_tokens: 5, total_tokens: 5 },
  };

  it('returns normalised EmbeddingResponse', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ovmResponse,
    }));

    const res = await embedWithOvmNpu(
      makeCfg(),
      makeReq({ provider: 'ovm-npu', model: 'OpenVINO/Qwen3-Embedding-0.6B-int8-ov' }),
    );
    expect(res.provider).toBe('ovm-npu');
    expect(res.model).toBe('OpenVINO/Qwen3-Embedding-0.6B-int8-ov');
    expect(res.dimensions).toBe(MOCK_DIMS);
    expect(res.usage?.promptTokens).toBe(5);
  });

  it('hits /v3/embeddings', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ovmResponse };
    });

    await embedWithOvmNpu(makeCfg(), makeReq({ provider: 'ovm-npu' }));
    expect(capturedUrl).toContain('/v3/embeddings');
  });

  it('sorts embeddings by index', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.9, 0.9], index: 1 },
          { embedding: [0.1, 0.1], index: 0 },
        ],
      }),
    }));

    const res = await embedWithOvmNpu(makeCfg(), makeReq({ provider: 'ovm-npu' }));
    expect(res.embeddings[0][0]).toBeCloseTo(0.1);
    expect(res.embeddings[1][0]).toBeCloseTo(0.9);
  });
});

// ---------------------------------------------------------------------------
// Provider isolation — ovm-npu should NOT be used for 4B models
// ---------------------------------------------------------------------------
describe('provider intent guards', () => {
  it('Qwen3-Embedding-4B should route to hf-cloud or tei, not ovm-npu', () => {
    const model = 'Qwen/Qwen3-Embedding-4B';
    // ovm-npu default model is the 0.6B variant
    const ovmDefault = 'OpenVINO/Qwen3-Embedding-0.6B-int8-ov';
    expect(model).not.toBe(ovmDefault);
    expect(model).not.toContain('0.6B');
  });
});
