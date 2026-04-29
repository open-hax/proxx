/**
 * embeddings-strategy.test.ts
 *
 * Conformance tests for the embedding ProviderStrategy subclasses.
 * Uses the same strategy interface as all other proxx strategies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

  it('has mode hf_embeddings', () => assert.equal(s.mode, 'hf_embeddings'));
  it('is not local', () => assert.equal(s.isLocal, false));

  it('matches on x-embedding-provider: hf', () =>
    assert.equal(s.matches(embedCtx('hf')), true));
  it('matches on x-embedding-provider: huggingface', () =>
    assert.equal(s.matches(embedCtx('huggingface')), true));
  it('does not match tei', () =>
    assert.equal(s.matches(embedCtx('tei')), false));

  it('getUpstreamPath encodes model name', () => {
    const ctx = embedCtx('hf', { requestBody: { input: ['x'], model: 'Qwen/Qwen3-Embedding-4B' } });
    assert.equal(s.getUpstreamPath(ctx), '/pipeline/feature-extraction/Qwen%2FQwen3-Embedding-4B');
  });

  it('getUpstreamPath does NOT contain /v1/embeddings', () => {
    const ctx = embedCtx('hf');
    assert.equal(s.getUpstreamPath(ctx).includes('/v1/embeddings'), false);
  });

  it('buildPayload wraps scalar input in array', () => {
    const ctx = embedCtx('hf', { requestBody: { input: 'single string' } });
    const result = s.buildPayload(ctx);
    assert.equal(Array.isArray(result.upstreamPayload['inputs']), true);
  });

  it('buildPayload forwards instruction as parameters.prompt', () => {
    const ctx = embedCtx('hf', { requestBody: { input: ['x'], instruction: 'Embed this' } });
    const result = s.buildPayload(ctx);
    const params = result.upstreamPayload['parameters'] as Record<string, unknown>;
    assert.equal(params['prompt'], 'Embed this');
  });
});

// ---------------------------------------------------------------------------
// TEIEmbeddingStrategy
// ---------------------------------------------------------------------------
describe('TEIEmbeddingStrategy', () => {
  const s = new TEIEmbeddingStrategy();

  it('has mode tei_embeddings', () => assert.equal(s.mode, 'tei_embeddings'));
  it('is not local', () => assert.equal(s.isLocal, false));

  it('matches on x-embedding-provider: tei', () =>
    assert.equal(s.matches(embedCtx('tei')), true));
  it('does not match hf', () =>
    assert.equal(s.matches(embedCtx('hf')), false));

  it('getUpstreamPath returns /embed', () =>
    assert.equal(s.getUpstreamPath(makeCtx()), '/embed'));

  it('getUpstreamPath does NOT contain /v1/embeddings', () =>
    assert.equal(s.getUpstreamPath(makeCtx()).includes('/v1/embeddings'), false));

  it('buildPayload sets truncate_dim when dimensions provided', () => {
    const ctx = embedCtx('tei', { requestBody: { input: ['x'], dimensions: 512 } });
    const result = s.buildPayload(ctx);
    assert.equal(result.upstreamPayload['truncate_dim'], 512);
  });
});

// ---------------------------------------------------------------------------
// OvmNpuEmbeddingStrategy
// ---------------------------------------------------------------------------
describe('OvmNpuEmbeddingStrategy', () => {
  const s = new OvmNpuEmbeddingStrategy();

  it('has mode ovm_embeddings', () => assert.equal(s.mode, 'ovm_embeddings'));
  it('is not local', () => assert.equal(s.isLocal, false));

  it('matches on x-embedding-provider: ovm', () =>
    assert.equal(s.matches(embedCtx('ovm')), true));
  it('matches on x-embedding-provider: ovm-npu', () =>
    assert.equal(s.matches(embedCtx('ovm-npu')), true));
  it('does not match tei', () =>
    assert.equal(s.matches(embedCtx('tei')), false));

  it('getUpstreamPath returns /v3/embeddings', () =>
    assert.equal(s.getUpstreamPath(makeCtx()), '/v3/embeddings'));

  it('buildPayload uses 0.6B model by default', () => {
    const ctx = embedCtx('ovm');
    const result = s.buildPayload(ctx);
    assert.equal(String(result.upstreamPayload['model']).includes('0.6B'), true);
  });

  it('Qwen3-Embedding-4B is NOT the ovm default (route to hf/tei instead)', () => {
    const ctx = embedCtx('ovm');
    const result = s.buildPayload(ctx);
    assert.equal(String(result.upstreamPayload['model']).includes('4B'), false);
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
      assert.equal(s.matches(chatCtx), false);
    }
  });
});
