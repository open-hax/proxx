import assert from "node:assert/strict";
import test from "node:test";

import { MessagesProviderStrategy } from "../lib/provider-strategy/strategies/standard.js";
import type { ProxyConfig } from "../lib/config.js";
import type { ProviderAttemptContext } from "../lib/provider-strategy/shared.js";

function createHeaders(): Headers {
  return new Headers();
}

function configStub(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    messagesPath: "/v1/messages",
    messagesInterleavedThinkingBeta: "interleaved-thinking-2025-05-14",
    ...overrides,
  } as unknown as ProxyConfig;
}

function createContext(overrides: Partial<ProviderAttemptContext> = {}): ProviderAttemptContext {
  return {
    providerId: "anthropic",
    accountId: "test-account",
    routedModel: "claude-haiku-4-5",
    clientHeaders: {},
    clientWantsStream: false,
    config: configStub(),
    ...overrides,
  } as ProviderAttemptContext;
}

const strategy = new MessagesProviderStrategy();

test("MessagesProviderStrategy adds anthropic-version header for Anthropic provider", () => {
  const headers = createHeaders();
  const context = createContext({ providerId: "anthropic" });
  const payload = { messages: [{ role: "user", content: "hi" }] };

  strategy.applyRequestHeaders(headers, context, payload);

  assert.equal(headers.get("anthropic-version"), "2023-06-01");
});

test("MessagesProviderStrategy does not add anthropic-version header for non-Anthropic providers", () => {
  const headers = createHeaders();
  const context = createContext({ providerId: "openrouter" });
  const payload = { messages: [{ role: "user", content: "hi" }] };

  strategy.applyRequestHeaders(headers, context, payload);

  assert.equal(headers.get("anthropic-version"), null);
});

test("MessagesProviderStrategy does not overwrite existing anthropic-version header", () => {
  const headers = createHeaders();
  headers.set("anthropic-version", "2024-01-01");
  const context = createContext({ providerId: "anthropic" });
  const payload = { messages: [{ role: "user", content: "hi" }] };

  strategy.applyRequestHeaders(headers, context, payload);

  assert.equal(headers.get("anthropic-version"), "2024-01-01");
});

test("MessagesProviderStrategy adds anthropic-beta header when thinking is enabled", () => {
  const headers = createHeaders();
  const context = createContext({
    providerId: "anthropic",
    config: configStub(),
  });
  const payload = {
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 10000 },
  };

  strategy.applyRequestHeaders(headers, context, payload);

  assert.ok(headers.get("anthropic-beta")?.includes("interleaved-thinking-2025-05-14"));
});

test("MessagesProviderStrategy does not add anthropic-beta header when thinking is disabled", () => {
  const headers = createHeaders();
  const context = createContext({
    providerId: "anthropic",
    config: configStub(),
  });
  const payload = { messages: [{ role: "user", content: "hi" }] };

  strategy.applyRequestHeaders(headers, context, payload);

  assert.equal(headers.get("anthropic-beta"), null);
});

test("MessagesProviderStrategy uses correct upstream path for messages mode", () => {
  const context = createContext({
    providerId: "anthropic",
    config: configStub({ messagesPath: "/v1/messages" }),
  });

  const path = strategy.getUpstreamPath(context);

  assert.equal(path, "/v1/messages");
});

test("MessagesProviderStrategy uses provider-specific path when available", () => {
  const context = createContext({
    providerId: "anthropic",
    providerPaths: { messages: "/custom/messages" },
    config: configStub({ messagesPath: "/v1/messages" }),
  });

  const path = strategy.getUpstreamPath(context);

  assert.equal(path, "/custom/messages");
});
