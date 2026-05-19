import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../lib/config.js";
import { selectProviderStrategy } from "../lib/provider-strategy.js";
import { selectExecutionStrategyForProviderRoutes } from "../lib/provider-strategy/registry.js";
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
      OLLAMA_MODEL_PREFIXES: undefined,
      PROXY_ALLOW_UNAUTHENTICATED: "false",
    },
    () => loadConfig(),
  );

  const routed = resolveRequestRoutingState(config, "ollama/gpt-5.4-mini");
  assert.equal(routed.explicitOllama, true);
  assert.equal(routed.localOllama, true);
  assert.equal(routed.routedModel, "gpt-5.4-mini");
});

test("explicit ollama-lan prefix strips to the LAN Ollama model id", () => {
  const config = withEnv(
    {
      PROXY_AUTH_TOKEN: "test-token",
      DATABASE_URL: undefined,
      OLLAMA_MODEL_PREFIXES: undefined,
      PROXY_ALLOW_UNAUTHENTICATED: "false",
    },
    () => loadConfig(),
  );

  const routed = resolveRequestRoutingState(config, "ollama-lan/gemma4:e4b");
  assert.equal(routed.explicitOllama, true);
  assert.equal(routed.localOllama, true);
  assert.equal(routed.routedModel, "gemma4:e4b");
});

test("policy-selected ollama_chat strategy is not tied to a hard-coded provider id", () => {
  const config = withEnv(
    {
      PROXY_AUTH_TOKEN: "test-token",
      DATABASE_URL: undefined,
      PROXY_ALLOW_UNAUTHENTICATED: "false",
    },
    () => loadConfig(),
  );
  const { strategy, context } = selectProviderStrategy(
    config,
    {},
    { model: "gemma4:e4b", messages: [{ role: "user", content: "hi" }] },
    "gemma4:e4b",
    "gemma4:e4b",
  );

  const selected = selectExecutionStrategyForProviderRoutes(
    context,
    strategy,
    ["policy-named-ollama-node"],
    "ollama_chat",
  );
  assert.equal(selected.mode, "ollama_chat");
});

test("unprefixed qwen local model still routes to local ollama", () => {
  const result = shouldUseLocalOllama("qwen3.5:4b-q8_0", ["mini", ":4b"]);
  assert.equal(result, true);
});

test("ollama tags like :e4b match default :4b local-ollama patterns", () => {
  const result = shouldUseLocalOllama("gemma4:e4b", [":4b"]);
  assert.equal(result, true);
});
