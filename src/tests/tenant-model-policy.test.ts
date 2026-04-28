import assert from "node:assert/strict";
import test from "node:test";

import { tenantModelAllowed } from "../lib/tenant-policy-helpers.js";

test("tenantModelAllowed accepts exact configured model ids", () => {
  const settings = {
    allowedModels: ["ollama/gpt-oss:20b", "ollama/gemma3:12b"],
    allowedProviderIds: null,
    disabledProviderIds: null,
  };

  assert.equal(tenantModelAllowed(settings, "ollama/gpt-oss:20b"), true);
  assert.equal(tenantModelAllowed(settings, "ollama/gemma3:27b"), false);
});

test("tenantModelAllowed accepts normalized Ollama variants from the allow-list", () => {
  const settings = {
    allowedModels: ["ollama/qwen3.5:2b-bf16"],
    allowedProviderIds: null,
    disabledProviderIds: null,
  };

  assert.equal(tenantModelAllowed(settings, "qwen3.5:2b-bf16"), true);
  assert.equal(tenantModelAllowed(settings, "ollama:qwen3.5:2b-bf16"), true);
});
