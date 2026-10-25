import type { AccountHealthStore } from "./db/account-health-store.js";
import type { ProviderCredential } from "./key-pool.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { ProviderRoute } from "./provider-routing.js";
import type { ProviderRoutePheromoneStore } from "./provider-route-pheromone-store.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

export interface ProviderRouteAcoSignal {
  readonly providerId: string;
  readonly healthScore: number;
  readonly latencyScore: number;
  readonly recencyScore: number;
  readonly confidenceScore: number;
  readonly heuristicScore: number;
  readonly pheromone: number;
  readonly combinedScore: number;
  readonly healthyAccountCount: number;
  readonly sampleCount: number;
}

/**
 * Order dedicated Ollama routes by ant-colony score (health, latency, recency,
 * confidence and pheromone, drawn by weighted random choice). The scoring and the
 * ordering are the CLJS kernels `proxx.routing.aco`; the edge asks the stores what
 * they know, reads the ACO_* environment and draws from `rng`.
 */
export async function rankProviderRoutesWithAco(input: {
  readonly providerRoutes: readonly ProviderRoute[];
  readonly model: string;
  readonly upstreamMode: string;
  readonly keyPool: {
    getRequestOrder(providerId: string): Promise<ProviderCredential[]>;
  };
  readonly requestLogStore: RequestLogStore;
  readonly healthStore: AccountHealthStore | undefined;
  readonly pheromoneStore: ProviderRoutePheromoneStore;
  readonly rng?: () => number;
}): Promise<{
  readonly orderedRoutes: ProviderRoute[];
  readonly signals: readonly ProviderRouteAcoSignal[];
}> {
  return await kernels.rankProviderRoutesWithAco(policyManifestPath(), input) as {
    readonly orderedRoutes: ProviderRoute[];
    readonly signals: readonly ProviderRouteAcoSignal[];
  };
}
