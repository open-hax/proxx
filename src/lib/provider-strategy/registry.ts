import { kernels } from "../cljs-kernels.js";
import { selectionFacts, type ProviderStrategy, type StrategyRequestContext, type UpstreamMode } from "./shared.js";

/*
 * Which strategy handles a request, and in which priority order, is declared in
 * 78-strategy-registry.edn and decided by proxx.strategy.select. The strategies
 * themselves are built from that registry in CLJS (proxx.runtime.strategies);
 * this module only asks for them by id.
 */

/** Priority order (highest first), the registry's own order. */
export const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = kernels.allStrategies();

export const strategyForId = (id: string): ProviderStrategy => kernels.strategyForId(id);

export function selectProviderStrategyForContext(
  context: StrategyRequestContext,
): ProviderStrategy {
  return strategyForId(kernels.selectStrategy(selectionFacts(context), {}, context.config.cljsPolicyManifestPath));
}

export function allProviderStrategyInfos(): Array<{ readonly mode: UpstreamMode; readonly isLocal: boolean; readonly priority: number }> {
  return kernels.allStrategyInfos() as Array<{ readonly mode: UpstreamMode; readonly isLocal: boolean; readonly priority: number }>;
}

export function selectRemoteProviderStrategyForRoute(
  context: StrategyRequestContext,
  providerId: string,
  policyPreferredStrategyMode?: UpstreamMode,
): ProviderStrategy {
  const facts = selectionFacts({ ...context, routeProviderId: providerId.trim().toLowerCase() });
  return strategyForId(kernels.selectRemoteStrategy(
    facts,
    providerId,
    context.config.openaiProviderId,
    policyPreferredStrategyMode,
    context.policyPreferredStrategyModeByProvider,
    context.config.cljsPolicyManifestPath,
  ));
}

export function selectExecutionStrategyForProviderRoutes(
  context: StrategyRequestContext,
  defaultStrategy: ProviderStrategy,
  providerIds: readonly string[],
  policyPreferredStrategyMode?: UpstreamMode,
): ProviderStrategy {
  // Which provider's strategy executes the plan is decided by proxx.strategy.select/execution-provider.
  const providerId = kernels.executionProvider(providerIds);
  return providerId === undefined
    ? defaultStrategy
    : selectRemoteProviderStrategyForRoute(context, providerId, policyPreferredStrategyMode);
}
