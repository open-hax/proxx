import assert from "node:assert/strict";
import test from "node:test";

import { rankProviderRoutesWithAco } from "../lib/provider-route-aco.js";

test("rankProviderRoutesWithAco filters unhealthy dedicated ollama routes", async () => {
  const result = await rankProviderRoutesWithAco({
    providerRoutes: [
      { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
      { providerId: "ollama-b", baseUrl: "http://ollama-b:11434" },
      { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
    ],
    model: "qwen3.5:2b-bf16",
    upstreamMode: "local_ollama_chat",
    keyPool: {
      getRequestOrder: async (providerId: string) => [{ providerId, accountId: `${providerId}-1`, token: "t", authType: "api_key" as const }],
    },
    requestLogStore: {
      getModelPerfSummary: () => undefined,
    } as never,
    healthStore: {
      getHealthScore: (providerId: string) => providerId === "ollama-a" ? 0.91 : 0.12,
      isQuotaExhausted: () => false,
    } as never,
    pheromoneStore: {
      getPheromone: () => 0.5,
    } as never,
    rng: () => 0,
  });

  assert.deepEqual(result.orderedRoutes, [
    { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
    { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
  ]);
  assert.deepEqual(result.signals.map((signal) => signal.providerId), ["ollama-a"]);
});

test("rankProviderRoutesWithAco prefers healthier faster routes under weighted selection", async () => {
  const result = await rankProviderRoutesWithAco({
    providerRoutes: [
      { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
      { providerId: "ollama-b", baseUrl: "http://ollama-b:11434" },
    ],
    model: "qwen3.5:2b-bf16",
    upstreamMode: "local_ollama_chat",
    keyPool: {
      getRequestOrder: async (providerId: string) => [{ providerId, accountId: `${providerId}-1`, token: "t", authType: "api_key" as const }],
    },
    requestLogStore: {
      getModelPerfSummary: (providerId: string) => providerId === "ollama-a"
        ? { providerId, accountId: "*", model: "qwen3.5:2b-bf16", upstreamMode: "local_ollama_chat", sampleCount: 2, ewmaTtftMs: 4500, ewmaTps: null, ewmaEndToEndTps: null, updatedAt: Date.now() - 5 * 60 * 60 * 1000 }
        : { providerId, accountId: "*", model: "qwen3.5:2b-bf16", upstreamMode: "local_ollama_chat", sampleCount: 20, ewmaTtftMs: 120, ewmaTps: null, ewmaEndToEndTps: null, updatedAt: Date.now() - 60_000 },
    } as never,
    healthStore: {
      getHealthScore: (providerId: string) => providerId === "ollama-a" ? 0.55 : 0.97,
      isQuotaExhausted: () => false,
    } as never,
    pheromoneStore: {
      getPheromone: (providerId: string) => providerId === "ollama-a" ? 0.2 : 0.95,
    } as never,
    rng: () => 0.8,
  });

  assert.equal(result.orderedRoutes[0]?.providerId, "ollama-b");
  const byProvider = new Map(result.signals.map((signal) => [signal.providerId, signal] as const));
  assert.ok((byProvider.get("ollama-b")?.combinedScore ?? 0) > (byProvider.get("ollama-a")?.combinedScore ?? 1));
});
