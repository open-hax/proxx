import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../lib/config.js";
import { resolveRequestRoutingState, shouldUseLocalOllama } from "../lib/provider-routing.js";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("gpt-5.4-mini no longer falls into local ollama heuristic because of generic 'mini' pattern", () => {
  const result = shouldUseLocalOllama("gpt-5.4-mini", ["mini", ":4b"]);
  assert.equal(result, false);
});

test("explicit ollama prefix still wins even for hosted-looking model names", () => {
  const config = withEnv(
    {
      PROXY_AUTH_TOKEN: "test-token",
      DATABASE_URL: undefined,
      PROXY_ALLOW_UNAUTHENTICATED: "false",
    },
    () => loadConfig(),
  );

  const routed = resolveRequestRoutingState(config, "ollama/gpt-5.4-mini");
  assert.equal(routed.explicitOllama, true);
  assert.equal(routed.localOllama, true);
  assert.equal(routed.routedModel, "gpt-5.4-mini");
});

test("unprefixed qwen local model still routes to local ollama", () => {
  const result = shouldUseLocalOllama("qwen3.5:4b-q8_0", ["mini", ":4b"]);
  assert.equal(result, true);
});
