import type {
  AccountInfo,
  AccountOrderingRule,
  ModelInfo,
  PlanType,
  PolicyConfig,
  ProviderId,
} from "../schema.js";
import { findMatchingRoutingRule } from "./matchers.js";

export interface AccountOrderingResult {
  readonly ordered: readonly AccountInfo[];
  readonly appliesConstraint: boolean;
  readonly constraintReason?: string;
}

export function sortAccountsByPlanWeight(
  accounts: readonly AccountInfo[],
  weights: Record<PlanType, number>,
): AccountInfo[] {
  return [...accounts].sort((left, right) => {
    const leftWeight = weights[left.planType] ?? weights.unknown ?? 1;
    const rightWeight = weights[right.planType] ?? weights.unknown ?? 1;
    return rightWeight - leftWeight;
  });
}

export function applyAccountOrdering(
  accounts: readonly AccountInfo[],
  rule: AccountOrderingRule,
): AccountInfo[] {
  switch (rule.kind) {
    case "prefer_plans": {
      const planSet = new Set(rule.plans);
      const preferred = accounts.filter((account) => planSet.has(account.planType));
      const remaining = accounts.filter((account) => !planSet.has(account.planType));
      return [...preferred, ...remaining];
    }

    case "exclude_plans": {
      const planSet = new Set(rule.plans);
      return accounts.filter((account) => !planSet.has(account.planType));
    }

    case "prefer_free": {
      const free = accounts.filter((account) => account.planType === "free");
      const nonFree = accounts.filter((account) => account.planType !== "free");
      return [...free, ...nonFree];
    }

    case "custom_weight":
      return sortAccountsByPlanWeight(accounts, rule.weights);

    default:
      return [...accounts];
  }
}

export function createAccountOrdering(
  _providerId: ProviderId,
  accounts: readonly AccountInfo[],
  model: ModelInfo,
  config: PolicyConfig,
): AccountOrderingResult {
  const rule = findMatchingRoutingRule(model, config.modelRouting.rules);
  const orderingRule = rule?.accountOrdering ?? config.modelRouting.defaultAccountOrdering;
  const constraints = config.accountPreferences.modelConstraints[model.routedModel];

  // Step 1: Apply model constraints first (requiresPlan, excludesPlan)
  let qualifiedAccounts = accounts;

  if (constraints?.requiresPlan?.length) {
    const requiredPlans = new Set(constraints.requiresPlan);
    const matchingAccounts = accounts.filter((account) => requiredPlans.has(account.planType));
    if (matchingAccounts.length > 0) {
      qualifiedAccounts = matchingAccounts;
    }
  }

  if (constraints?.excludesPlan?.length && qualifiedAccounts.length > 0) {
    const excludedPlans = new Set(constraints.excludesPlan);
    const filtered = qualifiedAccounts.filter((account) => !excludedPlans.has(account.planType));
    if (filtered.length > 0) {
      qualifiedAccounts = filtered;
    }
  }

  // Step 2: Filter out quota-exhausted accounts from the qualified set
  const availableAccounts = qualifiedAccounts.filter((account) => !account.isQuotaExhausted);

  // If all qualified accounts are quota-exhausted, fall back to using them (better than nothing)
  const accountsToOrder = availableAccounts.length > 0 ? availableAccounts : qualifiedAccounts;

  // Track whether policy constraints caused exclusions (not quota)
  const constraintRequiresPlan = constraints?.requiresPlan?.length ?? 0;
  const constraintExcludesPlan = constraints?.excludesPlan?.length ?? 0;
  const hadRequiresPlan = constraintRequiresPlan > 0;
  const hadExcludesPlan = constraintExcludesPlan > 0;
  
  const policyConstraintCausedExclusion = 
    (hadRequiresPlan && qualifiedAccounts !== accounts) ||
    (hadExcludesPlan && qualifiedAccounts.length < accounts.length);

  if (policyConstraintCausedExclusion) {
    const reason = hadRequiresPlan
      ? `Model ${model.routedModel} requires ${constraints!.requiresPlan!.join(" or ")} plan`
      : `Model ${model.routedModel} excludes ${constraints!.excludesPlan!.join(", ")} plans`;

    return {
      ordered: applyAccountOrdering(accountsToOrder, orderingRule),
      appliesConstraint: true,
      constraintReason: reason,
    };
  }

  // Only set constraint info if quota caused exclusions (for logging/visibility)
  const quotaCausedExclusion = availableAccounts.length < qualifiedAccounts.length;

  return {
    ordered: applyAccountOrdering(accountsToOrder, orderingRule),
    appliesConstraint: false,
    constraintReason: quotaCausedExclusion
      ? `${qualifiedAccounts.length - availableAccounts.length} qualified account(s) excluded due to quota exhaustion`
      : undefined,
  };
}
