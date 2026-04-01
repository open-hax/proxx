import assert from "node:assert/strict";
import test from "node:test";

import { buildVisionModelCandidates, isVisionAutoModel, reorderVisionProviderRoutes } from "../lib/provider-strategy/strategies/vision.js";

test("auto:vision advertises itself as a synthetic auto model", () => {
  assert.equal(isVisionAutoModel("auto:vision"), true);
  assert.equal(isVisionAutoModel("AUTO:VISION"), true);
  assert.equal(isVisionAutoModel("auto:smartest"), false);
});

test("auto:vision preserves the configured fallback chain order when preferred models are available", () => {
  const candidates = buildVisionModelCandidates({
    routingModelInput: "auto:vision",
    requestBody: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }] },
    catalog: null,
    availableModels: ["gpt-5.4-mini", "glm-5v-turbo", "Kimi-K2.5", "deepseek-v3.2"],
    providerId: "rotussy",
  });

  assert.deepEqual(candidates, ["glm-5v-turbo", "Kimi-K2.5", "gpt-5.4-mini"]);
});

test("auto:vision falls back to the full chain when catalog discovery has not surfaced the preferred models yet", () => {
  const candidates = buildVisionModelCandidates({
    routingModelInput: "auto:vision",
    requestBody: {},
    catalog: null,
    availableModels: ["deepseek-v3.2"],
    providerId: "rotussy",
  });

  assert.deepEqual(candidates, ["glm-5v-turbo", "Kimi-K2.5", "gpt-5.4-mini", "qwen3.5:4b-q8_0"]);
});

test("auto:vision provider ordering prefers rotussy for GLM vision models and ollama routes for local qwen", () => {
  const routes = [
    { providerId: "openai", baseUrl: "https://openai.example" },
    { providerId: "rotussy", baseUrl: "https://rotussy.example" },
    { providerId: "ollama-cloud", baseUrl: "https://ollama.example" },
    { providerId: "ollama-stealth", baseUrl: "http://127.0.0.1:11434" },
  ];

  assert.deepEqual(
    reorderVisionProviderRoutes(routes, "glm-5v-turbo").map((route) => route.providerId),
    ["rotussy", "openai", "ollama-cloud", "ollama-stealth"],
  );

  assert.deepEqual(
    reorderVisionProviderRoutes(routes, "glm-4.6v").map((route) => route.providerId),
    ["rotussy", "openai", "ollama-cloud", "ollama-stealth"],
  );

  assert.deepEqual(
    reorderVisionProviderRoutes(routes, "qwen3.5:4b-q8_0").map((route) => route.providerId),
    ["ollama-cloud", "ollama-stealth", "openai", "rotussy"],
  );
});
