import type { ProviderId, PolicyConfig, RequestContext, StrategyInfo } from "../schema.js";
import { findMatchingStrategyPreferenceRule, matchesPattern } from "./matchers.js";

export function selectStrategyByPolicy(
  strategies: readonly StrategyInfo[],
  providerId: ProviderId,
  request: RequestContext,
  config: PolicyConfig,
): StrategyInfo | undefined {
  const modelRule = findMatchingStrategyPreferenceRule(request.model, config.modelRouting.rules);
  const modelPreferred = modelRule?.preferredStrategies ?? undefined;
  const modelExcluded = new Set(modelRule?.excludedStrategies ?? []);

  const providerRules = config.strategySelection.rules.filter((rule) =>
    matchesPattern(providerId, rule.providerPattern)
      && (rule.requestKind === undefined || rule.requestKind === request.requestKind),
  );

  const providerExcluded = new Set<StrategyInfo["mode"]>();
  const providerPreferred: StrategyInfo["mode"][] = [];

  for (const rule of providerRules) {
    for (const mode of rule.excludedStrategies ?? []) {
      providerExcluded.add(mode);
    }
    for (const mode of rule.preferredStrategies ?? []) {
      providerPreferred.push(mode);
    }
  }

  const excluded = new Set<StrategyInfo["mode"]>([...modelExcluded, ...providerExcluded]);
  const allowed = strategies.filter((strategy) => !excluded.has(strategy.mode));
  if (allowed.length === 0) {
    return strategies[0];
  }

  const preferenceOrder: StrategyInfo["mode"][] = [
    ...providerPreferred,
    ...(modelPreferred ?? []),
    ...config.strategySelection.defaultOrder,
  ];

  for (const preferredMode of preferenceOrder) {
    const match = allowed.find((strategy) => strategy.mode === preferredMode);
    if (match) {
      return match;
    }
  }

  return [...allowed].sort((left, right) => right.priority - left.priority)[0];
}
