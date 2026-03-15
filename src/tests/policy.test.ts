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

test("de-prioritizes vivgrid and excludes ollama-cloud for gpt model provider ordering", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const ordered = policy.orderProviders(
    ["vivgrid", "ollama-cloud", "openai"],
    createModelInfo("gpt-5.4"),
  );

  // ollama-cloud has no GPT models (except gpt-oss), so it sorts after all preferred providers
  assert.deepEqual(ordered, ["openai", "vivgrid", "ollama-cloud"]);
});

test("preserves provider order for non-gpt models", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const ordered = policy.orderProviders(
    ["vivgrid", "ollama-cloud", "openai"],
    createModelInfo("glm-5"),
  );

  assert.deepEqual(ordered, ["vivgrid", "ollama-cloud", "openai"]);
});
