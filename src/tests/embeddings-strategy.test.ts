/**
 * embeddings-strategy.test.ts
 *
 * Conformance tests for the embedding ProviderStrategy subclasses.
 * Uses the same strategy interface as all other proxx strategies.
 */

import { describe, it, expect } from 'vitest';
import {
  HuggingFaceEmbeddingStrategy,
  TEIEmbeddingStrategy,
  OvmNpuEmbeddingStrategy,
} from '../lib/provider-strategy/strategies/embeddings.js';
import type { StrategyRequestContext } from '../lib/provider-strategy/shared.js';

// ---------------------------------------------------------------------------
// Minimal mock context
// ---------------------------------------------------------------------------
function makeCtx(overrides: Partial<StrategyRequestContext> = {}): StrategyRequestContext {
  return {
    config: {} as never,
    clientHeaders: {},
    requestBody: { input: ['hello world'] },
    requestedModelInput: 'test-model',
    routingModelInput: 'test-model',
    routedModel: 'test-model',
    explicitOllama: false,
    openAiPrefixed: false,
    factoryPrefixed: false,
    localOllama: false,
    clientWantsStream: false,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: 30_000,
    ...overrides,
  };
}

function embedCtx(provider: string, extra?: Partial<StrategyRequestContext>): StrategyRequestContext {
  return makeCtx({
    clientHeaders: { 'x-embedding-provider': provider },
    requestBody: { input: ['hello'] },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// HuggingFaceEmbeddingStrategy
// ---------------------------------------------------------------------------
describe('HuggingFaceEmbeddingStrategy', () => {
  const s = new HuggingFaceEmbeddingStrategy();

  it('has mode hf_embeddings', () => expect(s.mode).toBe('hf_embeddings'));
  it('is not local', () => expect(s.isLocal).toBe(false));

  it('matches on x-embedding-provider: hf', () =>
    expect(s.matches(embedCtx('hf'))).toBe(true));
  it('matches on x-embedding-provider: huggingface', () =>
    expect(s.matches(embedCtx('huggingface'))).toBe(true));
  it('does not match tei', () =>
    expect(s.matches(embedCtx('tei'))).toBe(false));

  it('getUpstreamPath encodes model name', () => {
    const ctx = embedCtx('hf', { requestBody: { input: ['x'], model: 'Qwen/Qwen3-Embedding-4B' } });
    expect(s.getUpstreamPath(ctx)).toBe('/pipeline/feature-extraction/Qwen%2FQwen3-Embedding-4B');
  });

  it('getUpstreamPath does NOT contain /v1/embeddings', () => {
    const ctx = embedCtx('hf');
    expect(s.getUpstreamPath(ctx)).not.toContain('/v1/embeddings');
  });

  it('buildPayload wraps scalar input in array', () => {
    const ctx = embedCtx('hf', { requestBody: { input: 'single string' } });
    const result = s.buildPayload(ctx);
    expect(Array.isArray(result.upstreamPayload['inputs'])).toBe(true);
  });

  it('buildPayload forwards instruction as parameters.prompt', () => {
    const ctx = embedCtx('hf', { requestBody: { input: ['x'], instruction: 'Embed this' } });
    const result = s.buildPayload(ctx);
    const params = result.upstreamPayload['parameters'] as Record<string, unknown>;
    expect(params['prompt']).toBe('Embed this');
  });
});

// ---------------------------------------------------------------------------
// TEIEmbeddingStrategy
// ---------------------------------------------------------------------------
describe('TEIEmbeddingStrategy', () => {
  const s = new TEIEmbeddingStrategy();

  it('has mode tei_embeddings', () => expect(s.mode).toBe('tei_embeddings'));
  it('is not local', () => expect(s.isLocal).toBe(false));

  it('matches on x-embedding-provider: tei', () =>
    expect(s.matches(embedCtx('tei'))).toBe(true));
  it('does not match hf', () =>
    expect(s.matches(embedCtx('hf'))).toBe(false));

  it('getUpstreamPath returns /embed', () =>
    expect(s.getUpstreamPath(makeCtx())).toBe('/embed'));

  it('getUpstreamPath does NOT contain /v1/embeddings', () =>
    expect(s.getUpstreamPath(makeCtx())).not.toContain('/v1/embeddings'));

  it('buildPayload sets truncate_dim when dimensions provided', () => {
    const ctx = embedCtx('tei', { requestBody: { input: ['x'], dimensions: 512 } });
    const result = s.buildPayload(ctx);
    expect(result.upstreamPayload['truncate_dim']).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// OvmNpuEmbeddingStrategy
// ---------------------------------------------------------------------------
describe('OvmNpuEmbeddingStrategy', () => {
  const s = new OvmNpuEmbeddingStrategy();

  it('has mode ovm_embeddings', () => expect(s.mode).toBe('ovm_embeddings'));
  it('is not local', () => expect(s.isLocal).toBe(false));

  it('matches on x-embedding-provider: ovm', () =>
    expect(s.matches(embedCtx('ovm'))).toBe(true));
  it('matches on x-embedding-provider: ovm-npu', () =>
    expect(s.matches(embedCtx('ovm-npu'))).toBe(true));
  it('does not match tei', () =>
    expect(s.matches(embedCtx('tei'))).toBe(false));

  it('getUpstreamPath returns /v3/embeddings', () =>
    expect(s.getUpstreamPath(makeCtx())).toBe('/v3/embeddings'));

  it('buildPayload uses 0.6B model by default', () => {
    const ctx = embedCtx('ovm');
    const result = s.buildPayload(ctx);
    expect(result.upstreamPayload['model']).toContain('0.6B');
  });

  it('Qwen3-Embedding-4B is NOT the ovm default (route to hf/tei instead)', () => {
    const ctx = embedCtx('ovm');
    const result = s.buildPayload(ctx);
    expect(result.upstreamPayload['model']).not.toContain('4B');
  });
});

// ---------------------------------------------------------------------------
// Registration guard: embedding strategies must not accidentally match chat
// ---------------------------------------------------------------------------
describe('embedding strategies do not match chat requests', () => {
  const strategies = [
    new HuggingFaceEmbeddingStrategy(),
    new TEIEmbeddingStrategy(),
    new OvmNpuEmbeddingStrategy(),
  ];

  it('none match a plain chat request body', () => {
    const chatCtx = makeCtx({
      requestBody: { messages: [{ role: 'user', content: 'hi' }] },
    });
    for (const s of strategies) {
      expect(s.matches(chatCtx)).toBe(false);
    }
  });
});
