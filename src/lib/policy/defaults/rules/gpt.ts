import type { ModelRoutingRule, ProviderId } from "../../schema.js";
import { GPT_FREE_BLOCKED_MODEL_PATTERN, PAID_PLAN_WEIGHTS } from "./plans.js";

export const DEFAULT_GPT_PROVIDER_ORDER: readonly ProviderId[] = [
  "openai",
  "factory",
  "openrouter",
  "requesty",
  "vivgrid",
];

export const GPT_OSS_PROVIDER_ORDER: readonly ProviderId[] = [
  "ollama-cloud",
];

const GPT_EXCLUDED_PROVIDERS: readonly ProviderId[] = [
  "ollama-cloud",
  "rotussy",
];

export function createGptRoutingRules(): readonly ModelRoutingRule[] {
  return [
    // GPT-OSS routing (Ollama-hosted open-source models)
    {
      modelPattern: /^gpt-oss/,
      preferredProviders: GPT_OSS_PROVIDER_ORDER,
      accountOrdering: { kind: "prefer_free" },
    },
    // GPT blocked models (free tier blocked, requires paid plan)
    {
      modelPattern: GPT_FREE_BLOCKED_MODEL_PATTERN,
      requiresPaidPlan: true,
      preferredProviders: DEFAULT_GPT_PROVIDER_ORDER,
      excludedProviders: GPT_EXCLUDED_PROVIDERS,
      accountOrdering: { kind: "custom_weight", weights: PAID_PLAN_WEIGHTS },
    },
    // GPT 6+ (requires paid plan)
    {
      modelPattern: /^gpt-[6-9]/,
      requiresPaidPlan: true,
      preferredProviders: DEFAULT_GPT_PROVIDER_ORDER,
      excludedProviders: GPT_EXCLUDED_PROVIDERS,
      accountOrdering: { kind: "custom_weight", weights: PAID_PLAN_WEIGHTS },
    },
    // GPT general routing (catch-all for remaining gpt-* models)
    {
      modelPattern: /^gpt-/,
      preferredProviders: DEFAULT_GPT_PROVIDER_ORDER,
      excludedProviders: GPT_EXCLUDED_PROVIDERS,
      accountOrdering: { kind: "prefer_free" },
    },
  ];
}
