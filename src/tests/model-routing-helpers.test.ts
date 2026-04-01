import assert from "node:assert/strict";
import test from "node:test";

import { catalogHasDynamicOllamaModel, filterProviderRoutesByCatalogAvailability } from "../lib/model-routing-helpers.js";

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

test("catalogHasDynamicOllamaModel matches catalog entries case-insensitively", () => {
  assert.equal(catalogHasDynamicOllamaModel({ dynamicOllamaModelIds: ["Gemma3:27B", "gpt-oss:20b"] }, "gemma3:27b"), true);
  assert.equal(catalogHasDynamicOllamaModel({ dynamicOllamaModelIds: ["Gemma3:27B", "gpt-oss:20b"] }, "glm-5"), false);
});

test("filterProviderRoutesByCatalogAvailability falls back to ollama-like providers for dynamic Ollama models", () => {
  const filtered = filterProviderRoutesByCatalogAvailability(
    [
      { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
      { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
      { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
      { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
    ],
    "gemma3:27b",
    {
      catalog: {
        modelIds: ["gemma3:27b"],
        aliasTargets: {},
        dynamicOllamaModelIds: ["gemma3:27b"],
        declaredModelIds: [],
      },
      providerCatalogs: {
        openai: {
          providerId: "openai",
          modelIds: ["gpt-5.4"],
          fetchedAt: Date.now(),
          stale: false,
          sourceEndpoints: ["/v1/models"],
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
    { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
    { providerId: "ollama-a", baseUrl: "http://ollama-a:11434" },
  ]);
});

test("filterProviderRoutesByCatalogAvailability returns no routes when a dynamic Ollama model has no ollama-like providers", () => {
  const filtered = filterProviderRoutesByCatalogAvailability(
    [
      { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
      { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
    ],
    "gemma3:27b",
    {
      catalog: {
        modelIds: ["gemma3:27b"],
        aliasTargets: {},
        dynamicOllamaModelIds: ["gemma3:27b"],
        declaredModelIds: [],
      },
      providerCatalogs: {},
      preferences: {
        preferred: [],
        disabled: [],
        aliases: {},
      },
    },
  );

  assert.deepEqual(filtered, []);
});

test("filterProviderRoutesByCatalogAvailability leaves non-dynamic routes alone when no provider advertises the model", () => {
  const routes = [
    { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
    { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
  ];

  const filtered = filterProviderRoutesByCatalogAvailability(
    routes,
    "glm-5",
    {
      catalog: {
        modelIds: ["glm-5"],
        aliasTargets: {},
        dynamicOllamaModelIds: ["gemma3:27b"],
        declaredModelIds: [],
      },
      providerCatalogs: {},
      preferences: {
        preferred: [],
        disabled: [],
        aliases: {},
      },
    },
  );

  assert.deepEqual(filtered, routes);
});
