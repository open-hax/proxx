import assert from "node:assert/strict";
import test from "node:test";

import { assertCljsRuntimeReady, loadCljsRuntime, setActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { GeminiChatProviderStrategy } from "../lib/provider-strategy/strategies/gemini.js";
import { applyProviderModelAliasToPayload } from "../lib/provider-strategy/shared.js";
import type { ProxyConfig } from "../lib/config.js";

test("CLJS runtime resolves gemma4:31b alias for gemini provider", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const result = loaded.runtime.resolveModelAlias(
    "resources/policies/runtime/00-manifest.edn",
    "gemma4:31b",
    "gemini",
  );

  assert.equal(result.status, "ok");
  assert.equal(result.alias, "gemma-4-31b-it");
});

test("CLJS runtime resolves gemma4:e4b to 128k tag for ollama-lan provider", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const result = loaded.runtime.resolveModelAlias(
    "resources/policies/runtime/00-manifest.edn",
    "gemma4:e4b",
    "ollama-lan",
  );

  assert.equal(result.status, "ok");
  assert.equal(result.alias, "gemma4:e4b-128k");
});

test("provider model alias rewrites chat-completions payload for ollama-lan", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);
  setActiveCljsRuntime(loaded.runtime);
  t.after(() => setActiveCljsRuntime(undefined));

  const config = {
    cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
  } as unknown as ProxyConfig;
  const context = {
    config,
    routedModel: "gemma4:e4b",
  } as Parameters<typeof applyProviderModelAliasToPayload>[1];
  const payload = applyProviderModelAliasToPayload({
    upstreamPayload: { model: "gemma4:e4b", messages: [] },
    bodyText: JSON.stringify({ model: "gemma4:e4b", messages: [] }),
    serviceTierSource: "none",
  }, context, "ollama-lan");

  assert.equal(payload.upstreamPayload.model, "gemma4:e4b-128k");
  assert.equal(JSON.parse(payload.bodyText).model, "gemma4:e4b-128k");
});

test("CLJS runtime returns null for gemma4:31b with non-matching provider", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const result = loaded.runtime.resolveModelAlias(
    "resources/policies/runtime/00-manifest.edn",
    "gemma4:31b",
    "openai",
  );

  assert.equal(result.status, "ok");
  assert.equal(result.alias, null);
});

test("Gemini strategy getUpstreamPath resolves model alias using candidate providerId", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);
  setActiveCljsRuntime(loaded.runtime);
  t.after(() => setActiveCljsRuntime(undefined));

  const strategy = new GeminiChatProviderStrategy();
  const config = {
    cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
  } as unknown as ProxyConfig;

  // Simulate ProviderAttemptContext where providerId is the candidate provider
  const context = {
    config,
    routedModel: "gemma4:31b",
    routeProviderId: "openai", // Original context has wrong provider
    providerId: "gemini", // But candidate provider is gemini
    clientHeaders: {},
    requestBody: {},
    requestedModelInput: "gemma4:31b",
    routingModelInput: "gemma4:31b",
    explicitOllama: false,
    openAiPrefixed: false,
    factoryPrefixed: false,
    localOllama: false,
    clientWantsStream: false,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: 30000,
  };

  const path = strategy.getUpstreamPath(context);
  assert.equal(path, "/models/gemma-4-31b-it:generateContent");
});

test("Gemini strategy getUpstreamPath falls back to routedModel when no alias", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);
  setActiveCljsRuntime(loaded.runtime);
  t.after(() => setActiveCljsRuntime(undefined));

  const strategy = new GeminiChatProviderStrategy();
  const config = {
    cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
  } as unknown as ProxyConfig;

  const context = {
    config,
    routedModel: "gemini-2.5-pro",
    routeProviderId: "gemini",
    providerId: "gemini",
    clientHeaders: {},
    requestBody: {},
    requestedModelInput: "gemini-2.5-pro",
    routingModelInput: "gemini-2.5-pro",
    explicitOllama: false,
    openAiPrefixed: false,
    factoryPrefixed: false,
    localOllama: false,
    clientWantsStream: false,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: 30000,
  };

  const path = strategy.getUpstreamPath(context);
  assert.equal(path, "/models/gemini-2.5-pro:generateContent");
});
