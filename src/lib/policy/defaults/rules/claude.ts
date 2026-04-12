import type { ModelRoutingRule, ProviderId } from "../../schema.js";

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
      accountOrdering: { kind: "prefer_free" },
    },
  ];
}
