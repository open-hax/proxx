import assert from "node:assert/strict";
import test from "node:test";

import modelsDevPricingSnapshot from "../lib/data/models-dev-pricing-data.js";
import { estimateRequestCost, getModelPricing, refreshModelsDevPricingIndex, setPolicyModelPricingOverrides } from "../lib/model-pricing.js";

function resetPolicyOverrides(): void {
  setPolicyModelPricingOverrides([]);
}

test("uses models.dev pricing for direct OpenAI models", () => {
  resetPolicyOverrides();
  const pricing = getModelPricing("openai", "gpt-5.4");

  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingSource, "models.dev");
  assert.equal(pricing.pricingProviderId, "openai");
  assert.equal(pricing.inputPer1MTokens, 2.5);
  assert.equal(pricing.outputPer1MTokens, 15);
});

test("falls back to canonical vendor pricing for factory Claude models", () => {
  resetPolicyOverrides();
  const pricing = getModelPricing("factory", "factory/claude-opus-4-6");

  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingProviderId, "anthropic");
  assert.equal(pricing.pricingModelId, "claude-opus-4-6");
  assert.equal(pricing.inputPer1MTokens, 5);
  assert.equal(pricing.outputPer1MTokens, 25);
});

test("falls back from ollama-cloud router entries to vendor pricing when router price is absent", () => {
  resetPolicyOverrides();
  const pricing = getModelPricing("ollama-cloud", "glm-5");

  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingProviderId, "zai");
  assert.equal(pricing.inputPer1MTokens, 1);
  assert.equal(pricing.outputPer1MTokens, 3.2);
});

test("glm-5v* variants fall back to glm-5* pricing when models.dev omits the v-tag", () => {
  resetPolicyOverrides();
  const pricing = getModelPricing("ollama-cloud", "glm-5v-turbo");

  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingProviderId, "zai");
  assert.equal(pricing.pricingModelId, "glm-5-turbo");
  assert.equal(pricing.inputPer1MTokens, 1.2);
  assert.equal(pricing.outputPer1MTokens, 4);
});

test("local ollama models remain zero-cost but still track energy estimates", () => {
  resetPolicyOverrides();
  const estimate = estimateRequestCost("ollama", "ollama/qwen3.5:4b-q8_0", 1000, 500);

  assert.equal(estimate.costUsd, 0);
  assert.ok(estimate.energyJoules > 0);
  assert.ok(estimate.waterEvaporatedMl > 0);
});

test("policy pricing overrides can provide fallback prices for unpriced models", () => {
  setPolicyModelPricingOverrides([
    {
      contractId: ":model-pricing-override/gemma4-31b",
      modelPattern: "(?i)^gemma4:31b$",
      mode: "fallback-unpriced",
      inputPer1MTokens: 0.134,
      outputPer1MTokens: 0.395,
    },
  ]);

  const pricing = getModelPricing("ollama-cloud", "gemma4:31b");
  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingSource, "policy");
  assert.equal(pricing.inputPer1MTokens, 0.134);
  assert.equal(pricing.outputPer1MTokens, 0.395);
});

test("refreshes the in-memory pricing index from models.dev-compatible payloads", async () => {
  resetPolicyOverrides();
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    providers: {
      ...modelsDevPricingSnapshot.providers,
      freshprovider: {
        models: {
          "fresh-model-2026": {
            input: 0.25,
            output: 0.75,
          },
        },
      },
    },
  }), { status: 200 });

  const status = await refreshModelsDevPricingIndex({
    sourceUrl: "https://example.test/models-dev-api.json",
    fetchFn,
    timeoutMs: 1000,
  });
  const pricing = getModelPricing("freshprovider", "fresh-model-2026");

  assert.equal(status.sourceUrl, "https://example.test/models-dev-api.json");
  assert.ok(status.providerCount > 1);
  assert.ok(status.modelCount > 1);
  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingSource, "models.dev");
  assert.equal(pricing.pricingProviderId, "freshprovider");
  assert.equal(pricing.inputPer1MTokens, 0.25);
  assert.equal(pricing.outputPer1MTokens, 0.75);
});
