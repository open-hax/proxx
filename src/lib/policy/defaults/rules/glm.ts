import type { ModelRoutingRule, ProviderId } from "../../schema.js";

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
      accountOrdering: { kind: "prefer_free" },
    },
  ];
}
