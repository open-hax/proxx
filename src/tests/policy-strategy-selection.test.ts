import assert from "node:assert/strict";
import test from "node:test";

import { createPolicyEngine, DEFAULT_POLICY_CONFIG, type ModelInfo } from "../lib/policy/index.js";
import type { StrategyInfo } from "../lib/policy/schema.js";

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

test("policy selects responses-first strategies for gpt-* models", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const available: StrategyInfo[] = [
    { mode: "chat_completions", isLocal: false, priority: 1 },
    { mode: "openai_chat_completions", isLocal: false, priority: 2 },
    { mode: "responses", isLocal: false, priority: 3 },
    { mode: "openai_responses", isLocal: false, priority: 4 },
  ];

  const selected = policy.selectStrategy(available, "openai", createModelInfo("gpt-5.4"));
  assert.equal(selected?.mode, "openai_responses");
});

test("policy selects ollama chat strategies for gpt-oss models", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const available: StrategyInfo[] = [
    { mode: "chat_completions", isLocal: false, priority: 1 },
    { mode: "ollama_chat", isLocal: false, priority: 2 },
  ];

  const selected = policy.selectStrategy(available, "ollama-cloud", createModelInfo("gpt-oss-120b"));
  assert.equal(selected?.mode, "ollama_chat");
});

test("policy prefers messages strategy for claude models when available", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const available: StrategyInfo[] = [
    { mode: "chat_completions", isLocal: false, priority: 1 },
    { mode: "messages", isLocal: false, priority: 2 },
  ];

  const selected = policy.selectStrategy(available, "factory", createModelInfo("claude-opus-4-6"));
  assert.equal(selected?.mode, "messages");
});

test("policy falls back to chat completions for claude models when messages is unavailable", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);

  const available: StrategyInfo[] = [
    { mode: "chat_completions", isLocal: false, priority: 1 },
  ];

  const selected = policy.selectStrategy(available, "openrouter", createModelInfo("claude-opus-4-6"));
  assert.equal(selected?.mode, "chat_completions");
});
