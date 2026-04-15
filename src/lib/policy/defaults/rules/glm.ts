import type { ModelRoutingRule, ProviderId, UpstreamMode } from "../../schema.js";

const GLM_STRATEGIES: readonly UpstreamMode[] = [
  "chat_completions",
  "ollama_chat",
];

export const GLM_PROVIDER_ORDER: readonly ProviderId[] = [
  "zai",
  "rotussy",
  "requesty",
  "factory",
  "openrouter",
  "vivgrid",
  "ollama-cloud",
];

export function createGlmRoutingRules(): readonly ModelRoutingRule[] {
  return [
    {
      modelPattern: /^glm-/,
      preferredProviders: GLM_PROVIDER_ORDER,
      excludedProviders: ["openai"],
      preferredStrategies: GLM_STRATEGIES,
      accountOrdering: { kind: "prefer_free" },
    },
  ];
}
