import { DEFAULT_FALLBACK_BEHAVIOR, DEFAULT_PLAN_WEIGHTS, type PolicyConfig } from "../schema.js";
import {
  createAllModelRoutingRules,
  buildFreeBlockedConstraints,
  GPT_FREE_BLOCKED_MODELS,
  // Re-exports for backward compatibility
  PAID_PLAN_WEIGHTS,
  PAID_PLANS,
  GPT_FREE_BLOCKED_MODEL_PATTERN,
  DEFAULT_GPT_PROVIDER_ORDER,
  GPT_OSS_PROVIDER_ORDER,
  CLAUDE_OPUS_46_PROVIDER_ORDER,
  GLM_PROVIDER_ORDER,
  createGptRoutingRules,
  createClaudeRoutingRules,
  createGlmRoutingRules,
} from "./rules/index.js";

// Re-export for backward compatibility
export {
  buildFreeBlockedConstraints,
  PAID_PLAN_WEIGHTS,
  PAID_PLANS,
  GPT_FREE_BLOCKED_MODELS,
  GPT_FREE_BLOCKED_MODEL_PATTERN,
  DEFAULT_GPT_PROVIDER_ORDER,
  GPT_OSS_PROVIDER_ORDER,
  CLAUDE_OPUS_46_PROVIDER_ORDER,
  GLM_PROVIDER_ORDER,
  createGptRoutingRules,
  createClaudeRoutingRules,
  createGlmRoutingRules,
  createAllModelRoutingRules,
};

// Legacy export for backward compatibility
export { createAllModelRoutingRules as createGptModelRoutingRules } from "./rules/index.js";

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  version: "1.0",

  modelRouting: {
    rules: createAllModelRoutingRules(),
    defaultAccountOrdering: { kind: "prefer_free" },
  },

  strategySelection: {
    rules: [
      // Provider capability/preferences
      {
        providerPattern: /^gemini$/,
        requestKind: "chat",
        preferredStrategies: ["gemini_chat"],
      },
      {
        providerPattern: /^zai$/,
        requestKind: "chat",
        preferredStrategies: ["chat_completions"],
        excludedStrategies: ["responses", "messages"],
      },
      {
        providerPattern: /^rotussy$/,
        requestKind: "responses_passthrough",
        preferredStrategies: ["chat_completions"],
        excludedStrategies: ["responses_passthrough"],
      },
      {
        providerPattern: /^(openrouter|requesty|ob1|zen)$/,
        requestKind: "chat",
        // These providers are OpenAI-compatible; don't attempt Anthropic /v1/messages.
        excludedStrategies: ["messages"],
      },

      // Request-surface defaults (keep last so provider-specific rules can override)
      {
        providerPattern: /.*/,
        requestKind: "images_passthrough",
        preferredStrategies: ["images"],
      },
      {
        providerPattern: /.*/,
        requestKind: "responses_passthrough",
        preferredStrategies: [
          "openai_responses_passthrough",
          "responses_passthrough",
          // Some providers (e.g. rotussy) don't offer /v1/responses; allow translation via chat.
          "chat_completions",
        ],
      },
    ],
    defaultOrder: [
      "local_ollama_chat",
      "ollama_chat",
      "openai_responses",
      "openai_chat_completions",
      "responses",
      "messages",
      "chat_completions",
    ],
  },

  fallback: DEFAULT_FALLBACK_BEHAVIOR,

  accountPreferences: {
    planWeights: DEFAULT_PLAN_WEIGHTS,
    modelConstraints: buildFreeBlockedConstraints(GPT_FREE_BLOCKED_MODELS),
  },
};
