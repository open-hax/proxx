import assert from "node:assert/strict";
import test from "node:test";

import { filterDedicatedOllamaRoutes, hasDedicatedOllamaRoutes, prependDynamicOllamaRoutes } from "../lib/dynamic-ollama-routes.js";

test("prependDynamicOllamaRoutes prefers discovered ollama providers and dedupes existing routes", () => {
  const merged = prependDynamicOllamaRoutes(
    [
      { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
      { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
      { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
    ],
    [
      { providerId: "ollama-76-13-13-250", baseUrl: "http://76.13.13.250:11434" },
      { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
    ],
  );

  assert.deepEqual(merged, [
    { providerId: "ollama-76-13-13-250", baseUrl: "http://76.13.13.250:11434" },
    { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
    { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
    { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
  ]);
});

test("filterDedicatedOllamaRoutes removes cloud and hosted providers", () => {
  const filtered = filterDedicatedOllamaRoutes([
    { providerId: "ollama-76-13-13-250", baseUrl: "http://76.13.13.250:11434" },
    { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
    { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
    { providerId: "factory", baseUrl: "https://api.factory.ai" },
  ]);

  assert.deepEqual(filtered, [
    { providerId: "ollama-76-13-13-250", baseUrl: "http://76.13.13.250:11434" },
  ]);
});

test("hasDedicatedOllamaRoutes identifies non-cloud ollama providers", () => {
  assert.equal(hasDedicatedOllamaRoutes([
    { providerId: "openai", baseUrl: "https://chatgpt.com/backend-api" },
    { providerId: "ollama-76-13-13-250", baseUrl: "http://76.13.13.250:11434" },
  ]), true);

  assert.equal(hasDedicatedOllamaRoutes([
    { providerId: "ollama-cloud", baseUrl: "https://ollama.com" },
    { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
  ]), false);
});
