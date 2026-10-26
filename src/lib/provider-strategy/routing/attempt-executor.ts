import type { FastifyReply } from "fastify";

import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { EventStore } from "../../db/event-store.js";
import type { ProviderCredential } from "../../key-pool.js";
import type { IPromptAffinityStore } from "../../db/sql-prompt-affinity-store.js";
import type { ProviderRoutePheromoneStore } from "../../provider-route-pheromone-store.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { QuotaMonitor } from "../../quota-monitor.js";
import type { ProviderRoute } from "../../provider-routing.js";
import { estimateRequestCost } from "../../model-pricing.js";
import { requestyModelProvider } from "../../model-family.js";
import { kernels } from "../../cljs-kernels.js";
import { selectRemoteProviderStrategyForRoute } from "../registry.js";
import type {
  BuildPayloadResult,
  ProviderAvailabilitySummary,
  ProviderRoutingExecutionResult,
  ProviderStrategy,
  StrategyRequestContext,
} from "../shared.js";

type RoutingKeyPool = Parameters<typeof kernels.inspectProviderAvailability>[0];

/**
 * Executes the provider routing plan: iterates over routing candidates,
 * attempts each one, and handles success/failure/rate-limit outcomes. The loop
 * is CLJS (proxx.runtime.attempt-executor), driving the pure state machine
 * proxx.strategy.executor; this entry point supplies the host collaborators it
 * cannot reach on its own: strategy selection by route, the pricing function
 * and the Requesty provider naming.
 */
export async function executeProviderRoutingPlan(
  strategy: ProviderStrategy,
  reply: FastifyReply,
  requestLogStore: RequestLogStore,
  promptAffinityStore: IPromptAffinityStore,
  providerRoutePheromoneStore: ProviderRoutePheromoneStore,
  keyPool: unknown,
  providerRoutes: readonly ProviderRoute[],
  context: StrategyRequestContext,
  payload: BuildPayloadResult,
  promptCacheKey?: string,
  refreshExpiredToken?: (credential: ProviderCredential) => Promise<ProviderCredential | null>,
  healthStore?: AccountHealthStore,
  eventStore?: EventStore,
  quotaMonitor?: QuotaMonitor,
  queueSignal?: AbortSignal,
): Promise<ProviderRoutingExecutionResult> {
  return kernels.executeProviderRoutingPlan(
    strategy, reply, requestLogStore, promptAffinityStore, providerRoutePheromoneStore, keyPool, providerRoutes,
    context, payload, promptCacheKey, refreshExpiredToken, healthStore, eventStore, quotaMonitor, queueSignal,
    {
      selectRemoteStrategy: (ctx, providerId) => selectRemoteProviderStrategyForRoute(ctx as StrategyRequestContext, providerId),
      estimateRequestCost,
      requestyModelProvider,
    },
  );
}

export async function inspectProviderAvailability(
  keyPool: {
    getStatus(providerId: string): Promise<{ readonly totalAccounts: number; readonly disabledAccounts?: number }>;
  },
  providerRoutes: readonly ProviderRoute[],
  promptCacheKey?: string,
): Promise<ProviderAvailabilitySummary> {
  return kernels.inspectProviderAvailability(keyPool as RoutingKeyPool, providerRoutes, promptCacheKey);
}
