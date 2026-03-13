import type {
  PolicyConfig,
  AccountInfo,
  ModelInfo,
  UpstreamMode,
  StrategyInfo,
  PlanType,
  AccountOrderingRule,
  ModelRoutingRule,
  ProviderId,
  FallbackBehavior,
} from "./types.js";

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value === pattern || value.startsWith(pattern);
  }
  return pattern.test(value);
}

function sortAccountsByPlanWeight(
  accounts: readonly AccountInfo[],
  weights: Record<PlanType, number>,
): AccountInfo[] {
  return [...accounts].sort((a, b) => {
    const weightA = weights[a.planType] ?? weights.unknown ?? 1;
    const weightB = weights[b.planType] ?? weights.unknown ?? 1;
    return weightB - weightA;
  });
}

function applyAccountOrdering(
  accounts: readonly AccountInfo[],
  rule: AccountOrderingRule,
): AccountInfo[] {
  switch (rule.kind) {
    case "prefer_plans": {
      const planSet = new Set(rule.plans);
      const preferred = accounts.filter((a) => planSet.has(a.planType));
      const remaining = accounts.filter((a) => !planSet.has(a.planType));
      return [...preferred, ...remaining];
    }
    
    case "exclude_plans": {
      const planSet = new Set(rule.plans);
      return accounts.filter((a) => !planSet.has(a.planType));
    }
    
    case "prefer_free": {
      const free = accounts.filter((a) => a.planType === "free");
      const nonFree = accounts.filter((a) => a.planType !== "free");
      return [...free, ...nonFree];
    }
    
    case "custom_weight":
      return sortAccountsByPlanWeight(accounts, rule.weights);
    
    default:
      return [...accounts];
  }
}

function findMatchingRoutingRule(
  model: ModelInfo,
  rules: readonly ModelRoutingRule[],
): ModelRoutingRule | undefined {
  const modelId = model.routedModel;
  
  for (const rule of rules) {
    if (matchesPattern(modelId, rule.modelPattern)) {
      return rule;
    }
  }
  
  return undefined;
}

function findMatchingProviderPreferenceRule(
  model: ModelInfo,
  rules: readonly ModelRoutingRule[],
): ModelRoutingRule | undefined {
  const modelId = model.routedModel;

  for (const rule of rules) {
    if (!matchesPattern(modelId, rule.modelPattern)) {
      continue;
    }

    if ((rule.preferredProviders?.length ?? 0) > 0 || (rule.excludedProviders?.length ?? 0) > 0) {
      return rule;
    }
  }

  return undefined;
}

function orderProvidersByRule(
  providerIds: readonly ProviderId[],
  rule: ModelRoutingRule | undefined,
): ProviderId[] {
  if (providerIds.length <= 1) {
    return [...providerIds];
  }

  const originalOrder = new Map(providerIds.map((providerId, index) => [providerId, index]));
  const excludedProviders = new Set(rule?.excludedProviders ?? []);
  const filteredProviderIds = providerIds.filter((providerId) => !excludedProviders.has(providerId));
  const preferredProviders = rule?.preferredProviders ?? [];
  if (preferredProviders.length === 0) {
    return [...filteredProviderIds];
  }

  const preferredOrder = new Map(preferredProviders.map((providerId, index) => [providerId, index]));

  return [...filteredProviderIds].sort((left, right) => {
    const leftPriority = preferredOrder.get(left) ?? preferredProviders.length;
    const rightPriority = preferredOrder.get(right) ?? preferredProviders.length;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0);
  });
}

export interface AccountOrderingResult {
  readonly ordered: readonly AccountInfo[];
  readonly appliesConstraint: boolean;
  readonly constraintReason?: string;
}

export interface PolicyEngine {
  orderAccounts(
    providerId: ProviderId,
    accounts: readonly AccountInfo[],
    model: ModelInfo,
  ): AccountOrderingResult;

  orderProviders(
    providerIds: readonly ProviderId[],
    model: ModelInfo,
  ): readonly ProviderId[];
  
  selectStrategy(
    strategies: readonly StrategyInfo[],
    providerId: ProviderId,
  ): StrategyInfo | undefined;
  
  getFallbackBehavior(): FallbackBehavior;
  getPlanWeights(): Record<PlanType, number>;
  getModelConstraints(modelId: string): PolicyConfig["accountPreferences"]["modelConstraints"][string] | undefined;
}

function createAccountOrdering(
  accounts: readonly AccountInfo[],
  model: ModelInfo,
  config: PolicyConfig,
): AccountOrderingResult {
  const rule = findMatchingRoutingRule(model, config.modelRouting.rules);
  const orderingRule = rule?.accountOrdering ?? config.modelRouting.defaultAccountOrdering;
  const constraints = config.accountPreferences.modelConstraints[model.routedModel];
  
  if (constraints) {
    if (constraints.requiresPlan?.length) {
      const requiredPlans = new Set(constraints.requiresPlan);
      const hasMatchingAccount = accounts.some((a) => requiredPlans.has(a.planType));
      if (hasMatchingAccount) {
        const qualified = accounts.filter((a) => requiredPlans.has(a.planType));
        const ordered = applyAccountOrdering(qualified, orderingRule);
        return {
          ordered,
          appliesConstraint: true,
          constraintReason: `Model ${model.routedModel} requires ${constraints.requiresPlan.join(" or ")} plan`,
        };
      }
    }
    
    if (constraints.excludesPlan?.length) {
      const excludedSet = new Set(constraints.excludesPlan);
      const filtered = accounts.filter((a) => !excludedSet.has(a.planType));
      if (filtered.length > 0) {
        const ordered = applyAccountOrdering(filtered, orderingRule);
        return {
          ordered,
          appliesConstraint: true,
          constraintReason: `Model ${model.routedModel} excludes ${constraints.excludesPlan.join(", ")} plans`,
        };
      }
    }
  }
  
  const ordered = applyAccountOrdering(accounts, orderingRule);
  return {
    ordered,
    appliesConstraint: false,
  };
}

export function createPolicyEngine(config: PolicyConfig): PolicyEngine {
  return {
    orderAccounts(
      providerId: ProviderId,
      accounts: readonly AccountInfo[],
      model: ModelInfo,
    ): AccountOrderingResult {
      return createAccountOrdering(accounts, model, config);
    },

    orderProviders(
      providerIds: readonly ProviderId[],
      model: ModelInfo,
    ): readonly ProviderId[] {
      const rule = findMatchingProviderPreferenceRule(model, config.modelRouting.rules);
      return orderProvidersByRule(providerIds, rule);
    },
     
    selectStrategy(
      strategies: readonly StrategyInfo[],
      providerId: ProviderId,
    ): StrategyInfo | undefined {
      const providerRules = config.strategySelection.rules.filter((rule) =>
        matchesPattern(providerId, rule.providerPattern),
      );
      
      for (const rule of providerRules) {
        if (rule.preferredStrategies) {
          for (const preferredMode of rule.preferredStrategies) {
            const match = strategies.find((s) => s.mode === preferredMode);
            if (match) return match;
          }
        }
        
        if (rule.excludedStrategies) {
          const excluded = new Set(rule.excludedStrategies);
          const allowed = strategies.filter((s) => !excluded.has(s.mode));
          if (allowed.length > 0) return allowed[0];
        }
      }
      
      for (const defaultMode of config.strategySelection.defaultOrder) {
        const match = strategies.find((s) => s.mode === defaultMode);
        if (match) return match;
      }
      
      return strategies[0];
    },
    
    getFallbackBehavior(): FallbackBehavior {
      return config.fallback;
    },
    
    getPlanWeights(): Record<PlanType, number> {
      return config.accountPreferences.planWeights;
    },
    
    getModelConstraints(modelId: string): PolicyConfig["accountPreferences"]["modelConstraints"][string] | undefined {
      return config.accountPreferences.modelConstraints[modelId];
    },
  };
}

export type { ProviderId, AccountId, PlanType, ModelInfo, AccountInfo } from "./types.js";

export { DEFAULT_POLICY_CONFIG, DEFAULT_PLAN_WEIGHTS, DEFAULT_FALLBACK_BEHAVIOR } from "./types.js";
