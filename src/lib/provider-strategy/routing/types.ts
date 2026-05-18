import type { FastifyReply } from "fastify";

import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { EventStore } from "../../db/event-store.js";
import type { ProviderCredential } from "../../key-pool.js";
import type { PolicyEngine } from "../../policy/index.js";
import type { IPromptAffinityStore } from "../../db/sql-prompt-affinity-store.js";
import type { ProviderRoutePheromoneStore } from "../../provider-route-pheromone-store.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { QuotaMonitor } from "../../quota-monitor.js";
import type { ProviderRoute } from "../../provider-routing.js";
import type {
  BuildPayloadResult,
  RoutingAccumulator,
  ProviderRoutingExecutionResult,
  ProviderStrategy,
  StrategyRequestContext,
} from "../shared.js";

export function clampRouteQuality(latencyMs: number): number {
  const clampedLatency = Math.min(Math.max(latencyMs, 250), 30_000);
  return Math.max(0.05, 1 - ((clampedLatency - 250) / (30_000 - 250)));
}

export interface RoutingKeyPool {
  getRequestOrder(providerId: string): Promise<ProviderCredential[]>;
  markInFlight(credential: ProviderCredential): () => void;
  markRateLimited(credential: ProviderCredential, retryAfterMs?: number): void;
  markModelUnsupported?(credential: ProviderCredential, modelId: string, retryAfterMs?: number): void;
  isModelUnsupported?(providerId: string, accountId: string, modelId: string): boolean;
  clearModelUnsupported?(providerId: string, accountId: string, modelId: string): void;
  isAccountExpired?(credential: ProviderCredential): boolean;
  clearAccountCooldown?(providerId: string, accountId: string): void;
  disableAccount?(providerId: string, accountId: string): void;
}

export interface RoutingDeps {
  readonly strategy: ProviderStrategy;
  readonly reply: FastifyReply;
  readonly requestLogStore: RequestLogStore;
  readonly promptAffinityStore: IPromptAffinityStore;
  readonly providerRoutePheromoneStore: ProviderRoutePheromoneStore;
  readonly keyPool: RoutingKeyPool;
  readonly providerRoutes: readonly ProviderRoute[];
  readonly context: StrategyRequestContext;
  readonly payload: BuildPayloadResult;
  readonly promptCacheKey?: string;
  readonly refreshExpiredToken?: (credential: ProviderCredential) => Promise<ProviderCredential | null>;
  readonly policy?: PolicyEngine;
  readonly healthStore?: AccountHealthStore;
  readonly eventStore?: EventStore;
  readonly quotaMonitor?: QuotaMonitor;
}

export interface RoutingCandidate {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly account: ProviderCredential;
  readonly paths?: Readonly<Record<string, string>>;
}

export function createAccumulator(): RoutingAccumulator {
  return {
    sawRateLimit: false,
    sawRequestError: false,
    sawUpstreamServerError: false,
    sawUpstreamInvalidRequest: false,
    sawModelNotFound: false,
    sawModelNotSupportedForAccount: false,
    attempts: 0,
  };
}

export function emptyResult(candidateCount: number): ProviderRoutingExecutionResult {
  return {
    handled: false,
    candidateCount,
    summary: createAccumulator(),
  };
}

export function successResult(
  candidateCount: number,
  accumulator: RoutingAccumulator,
  deps: RoutingDeps,
  candidate: RoutingCandidate,
  latencyMs: number,
  preferredAffinity: { readonly providerId: string; readonly accountId: string } | undefined,
  preferredReassignmentAllowed: boolean,
): Promise<ProviderRoutingExecutionResult> {
  const { promptAffinityStore, providerRoutePheromoneStore, promptCacheKey, context } = deps;

  void providerRoutePheromoneStore.noteSuccess(
    candidate.providerId,
    context.routedModel,
    clampRouteQuality(latencyMs),
  );

  if (
    promptCacheKey
    && (
      preferredAffinity === undefined
      || preferredReassignmentAllowed
      || (candidate.providerId === preferredAffinity.providerId && candidate.account.accountId === preferredAffinity.accountId)
    )
  ) {
    void promptAffinityStore.noteSuccess(promptCacheKey, candidate.providerId, candidate.account.accountId);
  }

  return Promise.resolve({
    handled: true,
    candidateCount,
    summary: accumulator,
  });
}
