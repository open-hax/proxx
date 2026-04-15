import type { ModelRoutingRule } from "../../schema.js";
import { createGptRoutingRules, DEFAULT_GPT_PROVIDER_ORDER, GPT_OSS_PROVIDER_ORDER } from "./gpt.js";
import { createClaudeRoutingRules, CLAUDE_OPUS_46_PROVIDER_ORDER } from "./claude.js";
import { createGlmRoutingRules, GLM_PROVIDER_ORDER } from "./glm.js";
import {
  PAID_PLAN_WEIGHTS,
  PAID_PLANS,
  buildFreeBlockedConstraints,
  GPT_FREE_BLOCKED_MODELS,
  GPT_FREE_BLOCKED_MODEL_PATTERN,
} from "./plans.js";

/**
 * Creates all model routing rules in the correct order.
 *
 * Order matters: rules are matched in sequence, so more specific patterns
 * must come before catch-all patterns.
 *
 * 1. GLM rules (most specific - /^glm-/)
 * 2. Claude rules (highly specific - /^claude-opus-4-6/)
 * 3. GPT rules (catch-all for gpt-* family)
 */
export function createAllModelRoutingRules(): readonly ModelRoutingRule[] {
  return [
    ...createGlmRoutingRules(),      // GLM first (most specific)
    ...createClaudeRoutingRules(),   // Claude next
    ...createGptRoutingRules(),      // GPT last (catches remaining gpt- patterns)
    // Catch-all: default to OpenAI-compatible chat completions unless a more
    // specific model-family rule overrides it.
    {
      modelPattern: /.*/,
      preferredStrategies: ["chat_completions"],
    },
  ];
}

// Re-export for backward compatibility and testing
export {
  // Plan-related
  PAID_PLAN_WEIGHTS,
  PAID_PLANS,
  buildFreeBlockedConstraints,
  GPT_FREE_BLOCKED_MODELS,
  GPT_FREE_BLOCKED_MODEL_PATTERN,

  // Provider orders (for testing)
  DEFAULT_GPT_PROVIDER_ORDER,
  GPT_OSS_PROVIDER_ORDER,
  CLAUDE_OPUS_46_PROVIDER_ORDER,
  GLM_PROVIDER_ORDER,

  // Individual rule creators (for testing)
  createGptRoutingRules,
  createClaudeRoutingRules,
  createGlmRoutingRules,
};
