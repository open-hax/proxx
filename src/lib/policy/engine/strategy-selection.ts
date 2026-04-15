import type { ModelInfo, ProviderId, PolicyConfig, StrategyInfo } from "../schema.js";
import { findMatchingStrategyPreferenceRule, matchesPattern } from "./matchers.js";

export function selectStrategyByPolicy(
  strategies: readonly StrategyInfo[],
  providerId: ProviderId,
  model: ModelInfo,
  config: PolicyConfig,
): StrategyInfo | undefined {
  const modelRule = findMatchingStrategyPreferenceRule(model, config.modelRouting.rules);
  const modelPreferred = modelRule?.preferredStrategies ?? undefined;
  const modelExcluded = new Set(modelRule?.excludedStrategies ?? []);

  const providerRules = config.strategySelection.rules.filter((rule) =>
    matchesPattern(providerId, rule.providerPattern),
  );

  for (const rule of providerRules) {
    if (rule.preferredStrategies) {
      for (const preferredMode of rule.preferredStrategies) {
        const match = strategies.find((strategy) => strategy.mode === preferredMode && !modelExcluded.has(strategy.mode));
        if (match) {
          return match;
        }
      }
    }

    if (rule.excludedStrategies) {
      const excluded = new Set([...modelExcluded, ...rule.excludedStrategies]);
      const allowed = strategies.filter((strategy) => !excluded.has(strategy.mode));
      if (allowed.length > 0) {
        return allowed[0];
      }
    }
  }

  if (modelPreferred) {
    for (const preferredMode of modelPreferred) {
      const match = strategies.find((strategy) => strategy.mode === preferredMode && !modelExcluded.has(strategy.mode));
      if (match) {
        return match;
      }
    }
  }

  for (const defaultMode of config.strategySelection.defaultOrder) {
    const match = strategies.find((strategy) => strategy.mode === defaultMode && !modelExcluded.has(strategy.mode));
    if (match) {
      return match;
    }
  }

  const firstAllowed = strategies.find((strategy) => !modelExcluded.has(strategy.mode));
  return firstAllowed ?? strategies[0];
}
