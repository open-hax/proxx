import type { ModelRoutingRule, ProviderId, UpstreamMode } from "../../schema.js";

const CLAUDE_STRATEGIES: readonly UpstreamMode[] = [
  "messages",
  "chat_completions",
];

export const CLAUDE_OPUS_46_PROVIDER_ORDER: readonly ProviderId[] = [
  "factory",
  "openrouter",
  "requesty",
  "vivgrid",
];

export function createClaudeRoutingRules(): readonly ModelRoutingRule[] {
  return [
    {
      modelPattern: /^claude-opus-4-6(?:-fast)?$/,
      preferredProviders: CLAUDE_OPUS_46_PROVIDER_ORDER,
      excludedProviders: ["openai", "ollama-cloud"],
      preferredStrategies: CLAUDE_STRATEGIES,
      accountOrdering: { kind: "prefer_free" },
    },

    // Default: route the broader Claude family through Anthropic Messages when available.
    // Provider-level strategy rules can exclude "messages" for OpenAI-compatible providers.
    {
      modelPattern: /^claude-/,
      preferredProviders: CLAUDE_OPUS_46_PROVIDER_ORDER,
      excludedProviders: ["openai", "ollama-cloud"],
      preferredStrategies: CLAUDE_STRATEGIES,
      accountOrdering: { kind: "prefer_free" },
    },
  ];
}
