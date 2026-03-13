import assert from "node:assert/strict";
import test from "node:test";

import { createPolicyEngine, DEFAULT_POLICY_CONFIG, type ModelInfo } from "../lib/policy/index.js";

function createModelInfo(routedModel: string): ModelInfo {
  return {
    requestedModel: routedModel,
    routedModel,
    isGptModel: routedModel.startsWith("gpt-"),
    isOpenAiPrefixed: false,
    isLocal: false,
    isOllama: false,
  };
}

test("de-prioritizes vivgrid for gpt model provider ordering", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const ordered = policy.orderProviders(
    ["vivgrid", "ollama-cloud", "openai"],
    createModelInfo("gpt-5.4"),
  );

  assert.deepEqual(ordered, ["openai", "ollama-cloud", "vivgrid"]);
});

test("preserves provider order for non-gpt models", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const ordered = policy.orderProviders(
    ["vivgrid", "ollama-cloud", "openai"],
    createModelInfo("glm-5"),
  );

  assert.deepEqual(ordered, ["vivgrid", "ollama-cloud", "openai"]);
});
