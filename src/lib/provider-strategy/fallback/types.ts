import type { FastifyReply } from "fastify";

import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { EventStore } from "../../db/event-store.js";
import type { ProviderCredential } from "../../key-pool.js";
import type { PolicyEngine } from "../../policy/index.js";
import type { PromptAffinityStore } from "../../prompt-affinity-store.js";
import type { ProviderRoutePheromoneStore } from "../../provider-route-pheromone-store.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { QuotaMonitor } from "../../quota-monitor.js";
import type { ProviderRoute } from "../../provider-routing.js";
import type {
  BuildPayloadResult,
  FallbackAccumulator,
  ProviderFallbackExecutionResult,
  ProviderStrategy,
  StrategyRequestContext,
} from "../shared.js";

export function clampRouteQuality(latencyMs: number): number {
  const clampedLatency = Math.min(Math.max(latencyMs, 250), 30_000);
  return Math.max(0.05, 1 - ((clampedLatency - 250) / (30_000 - 250)));
}

export interface FallbackKeyPool {
  getRequestOrder(providerId: string): Promise<ProviderCredential[]>;
  markInFlight(credential: ProviderCredential): () => void;
  markRateLimited(credential: ProviderCredential, retryAfterMs?: number): void;
  isAccountExpired?(credential: ProviderCredential): boolean;
  clearAccountCooldown?(providerId: string, accountId: string): void;
  disableAccount?(providerId: string, accountId: string): void;
}

export interface FallbackDeps {
  readonly strategy: ProviderStrategy;
  readonly reply: FastifyReply;
  readonly requestLogStore: RequestLogStore;
  readonly promptAffinityStore: PromptAffinityStore;
  readonly providerRoutePheromoneStore: ProviderRoutePheromoneStore;
  readonly keyPool: FallbackKeyPool;
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

export interface FallbackCandidate {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly account: ProviderCredential;
}

export function createAccumulator(): FallbackAccumulator {
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

export function emptyResult(candidateCount: number): ProviderFallbackExecutionResult {
  return {
    handled: false,
    candidateCount,
    summary: createAccumulator(),
  };
}

export function successResult(
  candidateCount: number,
  accumulator: FallbackAccumulator,
  deps: FallbackDeps,
  candidate: FallbackCandidate,
  latencyMs: number,
  preferredAffinity: { readonly providerId: string; readonly accountId: string } | undefined,
  preferredReassignmentAllowed: boolean,
): Promise<ProviderFallbackExecutionResult> {
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
