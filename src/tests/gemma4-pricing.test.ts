import assert from "node:assert/strict";
import test from "node:test";

import { assertCljsRuntimeReady, loadCljsRuntime } from "../lib/cljs-runtime.js";
import { getModelPricing, estimateRequestCost, setPolicyModelPricingOverrides } from "../lib/model-pricing.js";

test("CLJS runtime loads gemma4 pricing override from manifest", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const overrides = loaded.runtime.loadModelPricingOverrides("resources/policies/runtime/00-manifest.edn");
  console.error("Loaded overrides:", JSON.stringify(overrides, null, 2));

  assert.ok(Array.isArray(overrides), "overrides should be an array");
  const gemma4Override = overrides.find((o: { modelPattern?: string }) => o.modelPattern === "(?i)^gemma4:31b$");
  assert.ok(gemma4Override, "should find gemma4:31b pricing override");
  assert.equal(gemma4Override.inputPer1MTokens, 0.134);
  assert.equal(gemma4Override.outputPer1MTokens, 0.395);
});

test("gemma4:31b cost calculation with 2.9B tokens is correct", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const overrides = loaded.runtime.loadModelPricingOverrides("resources/policies/runtime/00-manifest.edn");
  setPolicyModelPricingOverrides(overrides);
  t.after(() => setPolicyModelPricingOverrides([]));

  // 2.9 billion tokens, all input
  const estimate = estimateRequestCost("gemini", "gemma4:31b", 2_900_000_000, 0);
  console.error("Cost estimate for 2.9B input tokens:", estimate);

  // At $0.134 per 1M tokens, 2.9B tokens = 2900 * $0.134 = $388.60
  assert.ok(estimate.costUsd > 300, `cost should be > $300 for 2.9B tokens, got $${estimate.costUsd}`);
  assert.ok(estimate.costUsd < 400, `cost should be < $400 for 2.9B tokens, got $${estimate.costUsd}`);
});

test("gemma4:31b pricing is found for gemini provider", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const overrides = loaded.runtime.loadModelPricingOverrides("resources/policies/runtime/00-manifest.edn");
  setPolicyModelPricingOverrides(overrides);
  t.after(() => setPolicyModelPricingOverrides([]));

  const pricing = getModelPricing("gemini", "gemma4:31b");
  console.error("Pricing for gemma4:31b:", pricing);

  assert.equal(pricing.pricingFound, true);
  assert.equal(pricing.pricingSource, "policy");
  assert.equal(pricing.inputPer1MTokens, 0.134);
  assert.equal(pricing.outputPer1MTokens, 0.395);
});
