export type ProviderId = string;
export type AccountId = string;
export type ModelId = string;
export type PlanType = "free" | "plus" | "pro" | "team" | "business" | "enterprise" | "unknown";

export interface AccountInfo {
  readonly providerId: ProviderId;
  readonly accountId: AccountId;
  readonly planType: PlanType;
  readonly authType: "api_key" | "oauth_bearer" | "local";
  readonly isExpired?: boolean;
  readonly isRateLimited?: boolean;
  readonly rateLimitExpiresAt?: number;
}

export interface ModelInfo {
  readonly requestedModel: ModelId;
  readonly routedModel: ModelId;
  readonly isGptModel: boolean;
  readonly isOpenAiPrefixed: boolean;
  readonly isLocal: boolean;
  readonly isOllama: boolean;
}

export type UpstreamMode =
  | "chat_completions"
  | "responses"
  | "messages"
  | "openai_chat_completions"
  | "openai_responses"
  | "ollama_chat"
  | "local_ollama_chat";

export interface StrategyInfo {
  readonly mode: UpstreamMode;
  readonly isLocal: boolean;
  readonly priority: number;
}

export interface RequestContext {
  readonly model: ModelInfo;
  readonly clientWantsStream: boolean;
  readonly needsReasoningTrace: boolean;
}

export type AccountOrderingRule = 
  | { readonly kind: "prefer_plans"; readonly plans: readonly PlanType[] }
  | { readonly kind: "exclude_plans"; readonly plans: readonly PlanType[] }
  | { readonly kind: "prefer_free" }
  | { readonly kind: "custom_weight"; readonly weights: Record<PlanType, number> };

export interface ModelRoutingRule {
  readonly modelPattern: string | RegExp;
  readonly preferredProviders?: readonly ProviderId[];
  readonly excludedProviders?: readonly ProviderId[];
  readonly accountOrdering?: AccountOrderingRule;
  readonly requiresPaidPlan?: boolean;
  readonly fallbackModels?: readonly ModelId[];
}

export interface StrategySelectionRule {
  readonly providerPattern: string | RegExp;
  readonly preferredStrategies?: readonly UpstreamMode[];
  readonly excludedStrategies?: readonly UpstreamMode[];
}

export interface FallbackBehavior {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly retryBackoffMultiplier: number;
  readonly transientRetryCount: number;
  readonly transientStatusCodes: readonly number[];
  readonly skipOnRateLimit: boolean;
  readonly skipOnModelNotFound: boolean;
  readonly skipOnAccountIncompatible: boolean;
  readonly skipOnServerError: boolean;
}

export interface PolicyConfig {
  readonly version: "1.0";
  
  readonly modelRouting: {
    readonly rules: readonly ModelRoutingRule[];
    readonly defaultAccountOrdering: AccountOrderingRule;
  };
  
  readonly strategySelection: {
    readonly rules: readonly StrategySelectionRule[];
    readonly defaultOrder: readonly UpstreamMode[];
  };
  
  readonly fallback: FallbackBehavior;
  
  readonly accountPreferences: {
    readonly planWeights: Record<PlanType, number>;
    readonly modelConstraints: Record<ModelId, {
      readonly requiresPlan?: PlanType[];
      readonly excludesPlan?: PlanType[];
    }>;
  };
}

export const DEFAULT_PLAN_WEIGHTS: Record<PlanType, number> = {
  plus: 5,
  pro: 4,
  business: 4,
  enterprise: 4,
  team: 2,
  unknown: 1,
  free: 0,
};

export const DEFAULT_FALLBACK_BEHAVIOR: FallbackBehavior = {
  maxAttempts: 50,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,
  transientRetryCount: 2,
  transientStatusCodes: [502, 503, 504],
  skipOnRateLimit: true,
  skipOnModelNotFound: false,
  skipOnAccountIncompatible: true,
  skipOnServerError: false,
};

const DEFAULT_GPT_PROVIDER_ORDER: readonly ProviderId[] = [
  "openai",
  "ollama-cloud",
  "openrouter",
  "requesty",
  "vivgrid",
];

/**
 * Free-account model availability — last verified 2026-03-13.
 *
 * WORKS on free: gpt-5, gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.2, gpt-5.2-codex
 * BLOCKED on free: gpt-5.4, gpt-5.3-codex, gpt-5-mini
 *
 * To update: edit GPT_FREE_BLOCKED_MODELS below and the modelConstraints map.
 */
const GPT_FREE_BLOCKED_MODELS: readonly string[] = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5-mini",
];

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GPT_FREE_BLOCKED_MODEL_PATTERN = new RegExp(
  `^(?:${GPT_FREE_BLOCKED_MODELS.map(escapeRegexLiteral).join("|")})$`,
);

const PAID_PLAN_WEIGHTS: Record<PlanType, number> = {
  plus: 5,
  pro: 4,
  business: 4,
  enterprise: 4,
  team: 2,
  unknown: 1,
  free: 0,
};

const PAID_PLANS: readonly PlanType[] = ["plus", "pro", "business", "enterprise", "team"];

function buildFreeBlockedConstraints(
  models: readonly string[],
): Record<string, { requiresPlan: PlanType[]; excludesPlan: PlanType[] }> {
  const constraints: Record<string, { requiresPlan: PlanType[]; excludesPlan: PlanType[] }> = {};
  for (const model of models) {
    constraints[model] = {
      requiresPlan: [...PAID_PLANS],
      excludesPlan: ["free"],
    };
  }
  return constraints;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  version: "1.0",
  
  modelRouting: {
    rules: [
      // Paid-only GPT models (free-account blocked — see list above)
      {
        modelPattern: GPT_FREE_BLOCKED_MODEL_PATTERN,
        requiresPaidPlan: true,
        preferredProviders: DEFAULT_GPT_PROVIDER_ORDER,
        accountOrdering: { kind: "custom_weight", weights: PAID_PLAN_WEIGHTS },
      },
      {
        modelPattern: /^gpt-[6-9]/,
        requiresPaidPlan: true,
        preferredProviders: DEFAULT_GPT_PROVIDER_ORDER,
        accountOrdering: { kind: "custom_weight", weights: PAID_PLAN_WEIGHTS },
      },
      // All other GPT models — free accounts allowed and preferred
      {
        modelPattern: /^gpt-/,
        preferredProviders: DEFAULT_GPT_PROVIDER_ORDER,
        accountOrdering: { kind: "prefer_free" },
      },
    ],
    defaultAccountOrdering: { kind: "prefer_free" },
  },
  
  strategySelection: {
    rules: [],
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
    // Free-account exclusions — last verified 2026-03-13
    modelConstraints: buildFreeBlockedConstraints(GPT_FREE_BLOCKED_MODELS),
  },
};
