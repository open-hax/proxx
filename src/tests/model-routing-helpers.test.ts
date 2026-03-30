import assert from "node:assert/strict";
import test from "node:test";

import { filterProviderRoutesByCatalogAvailability } from "../lib/model-routing-helpers.js";

test("filterProviderRoutesByCatalogAvailability keeps only providers that advertise the requested model", () => {
  const filtered = filterProviderRoutesByCatalogAvailability(
    [
      { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
      { providerId: "ollama-b", baseUrl: "http://ollama-b:11434" },
      { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
    ],
    "gemma3:12b",
    {
      catalog: {
        modelIds: ["gemma3:12b"],
        aliasTargets: {},
        dynamicOllamaModelIds: ["gemma3:12b"],
        declaredModelIds: [],
      },
      providerCatalogs: {
        "ollama-a": {
          providerId: "ollama-a",
          modelIds: ["gemma3:12b"],
          fetchedAt: Date.now(),
          stale: false,
          sourceEndpoints: ["/api/tags"],
        },
        "ollama-b": {
          providerId: "ollama-b",
          modelIds: ["gpt-oss:20b"],
          fetchedAt: Date.now(),
          stale: false,
          sourceEndpoints: ["/api/tags"],
        },
      },
      preferences: {
        preferred: [],
        disabled: [],
        aliases: {},
      },
    },
  );

  assert.deepEqual(filtered, [
    { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
  ]);
});

test("filterProviderRoutesByCatalogAvailability leaves routes alone when no provider advertises the model", () => {
  const routes = [
    { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
    { providerId: "ollama-b", baseUrl: "http://ollama-b:11434" },
  ];

  const filtered = filterProviderRoutesByCatalogAvailability(
    routes,
    "gemma3:27b",
    {
      catalog: {
        modelIds: ["gemma3:27b"],
        aliasTargets: {},
        dynamicOllamaModelIds: ["gemma3:27b"],
        declaredModelIds: [],
      },
      providerCatalogs: {
        "ollama-a": {
          providerId: "ollama-a",
          modelIds: ["gpt-oss:20b"],
          fetchedAt: Date.now(),
          stale: false,
          sourceEndpoints: ["/api/tags"],
        },
      },
      preferences: {
        preferred: [],
        disabled: [],
        aliases: {},
      },
    },
  );

  assert.deepEqual(filtered, routes);
});
