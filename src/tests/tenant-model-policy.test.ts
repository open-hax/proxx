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
