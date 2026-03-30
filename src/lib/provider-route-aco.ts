import type { AccountHealthStore } from "./db/account-health-store.js";
import type { ProviderCredential } from "./key-pool.js";
import type { RequestLogPerfSummary, RequestLogStore } from "./request-log-store.js";
import type { ProviderRoute } from "./provider-routing.js";
import type { ProviderRoutePheromoneStore } from "./provider-route-pheromone-store.js";

const DEFAULT_ROUTE_HEALTH_MIN = 0.35;
const DEFAULT_ALPHA = 0.4;
const DEFAULT_BETA = 0.6;
const DEFAULT_HEALTH_WEIGHT = 0.55;
const DEFAULT_LATENCY_WEIGHT = 0.25;
const DEFAULT_RECENCY_WEIGHT = 0.1;
const DEFAULT_CONFIDENCE_WEIGHT = 0.1;
const DEFAULT_RECENCY_WINDOW_MS = 6 * 60 * 60 * 1000;
const MIN_WEIGHT = 0.0001;

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

interface ProviderRouteCandidate {
  readonly route: ProviderRoute;
  readonly perf: RequestLogPerfSummary | undefined;
  readonly healthScore: number;
  readonly healthyAccountCount: number;
  readonly pheromone: number;
}

function envFloat(name: string, fallback: number, min = 0, max = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function routeLooksLikeDedicatedOllama(route: ProviderRoute): boolean {
  const providerId = route.providerId.trim().toLowerCase();
  return providerId.startsWith("ollama-") && providerId !== "ollama-cloud";
}

function isCredentialHealthy(
  credential: ProviderCredential,
  healthStore: AccountHealthStore | undefined,
  minHealthScore: number,
): { readonly healthy: boolean; readonly healthScore: number } {
  const expiresAt = credential.expiresAt;
  const expired = typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= Date.now();
  const healthScore = healthStore?.getHealthScore(credential.providerId, credential.accountId, expiresAt) ?? (expired ? 0.1 : 0.5);
  const quotaExhausted = healthStore?.isQuotaExhausted(credential.providerId, credential.accountId) ?? false;
  return {
    healthy: !expired && !quotaExhausted && healthScore >= minHealthScore,
    healthScore,
  };
}

function toLatencyScore(
  perf: RequestLogPerfSummary | undefined,
  minTtftMs: number,
  maxTtftMs: number,
): number {
  if (!perf) {
    return 0.5;
  }
  if (maxTtftMs <= minTtftMs) {
    return 1;
  }
  return clamp(1 - ((perf.ewmaTtftMs - minTtftMs) / (maxTtftMs - minTtftMs)));
}

function toRecencyScore(perf: RequestLogPerfSummary | undefined): number {
  if (!perf) {
    return 0.5;
  }
  const ageMs = Math.max(0, Date.now() - perf.updatedAt);
  return clamp(1 - (ageMs / DEFAULT_RECENCY_WINDOW_MS));
}

function toConfidenceScore(perf: RequestLogPerfSummary | undefined): number {
  if (!perf) {
    return 0;
  }
  return clamp(perf.sampleCount / 10);
}

function weightedRandomOrder<T extends { readonly combinedScore: number }>(
  items: readonly T[],
  rng: () => number,
): T[] {
  const remaining = [...items];
  const ordered: T[] = [];

  while (remaining.length > 0) {
    const totalWeight = remaining.reduce((sum, item) => sum + Math.max(item.combinedScore, MIN_WEIGHT), 0);
    let target = rng() * totalWeight;
    let selectedIndex = 0;

    for (let index = 0; index < remaining.length; index += 1) {
      target -= Math.max(remaining[index]!.combinedScore, MIN_WEIGHT);
      if (target <= 0) {
        selectedIndex = index;
        break;
      }
    }

    ordered.push(remaining.splice(selectedIndex, 1)[0]!);
  }

  return ordered;
}

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
  const dedicatedRoutes = input.providerRoutes.filter(routeLooksLikeDedicatedOllama);
  const passthroughRoutes = input.providerRoutes.filter((route) => !routeLooksLikeDedicatedOllama(route));
  if (dedicatedRoutes.length <= 1) {
    return {
      orderedRoutes: [...input.providerRoutes],
      signals: dedicatedRoutes.map((route) => ({
        providerId: route.providerId,
        healthScore: 0.5,
        latencyScore: 0.5,
        recencyScore: 0.5,
        confidenceScore: 0,
        heuristicScore: 0.5,
        pheromone: input.pheromoneStore.getPheromone(route.providerId, input.model),
        combinedScore: 0.5,
        healthyAccountCount: 0,
        sampleCount: 0,
      })),
    };
  }

  const minHealthScore = envFloat("ACO_ROUTE_HEALTH_MIN", DEFAULT_ROUTE_HEALTH_MIN);
  const alpha = envFloat("ACO_ROUTING_ALPHA", DEFAULT_ALPHA);
  const beta = envFloat("ACO_ROUTING_BETA", DEFAULT_BETA);
  const wHealth = envFloat("ACO_HEURISTIC_HEALTH_WEIGHT", DEFAULT_HEALTH_WEIGHT);
  const wLatency = envFloat("ACO_HEURISTIC_LATENCY_WEIGHT", DEFAULT_LATENCY_WEIGHT);
  const wRecency = envFloat("ACO_HEURISTIC_RECENCY_WEIGHT", DEFAULT_RECENCY_WEIGHT);
  const wConfidence = envFloat("ACO_HEURISTIC_CONFIDENCE_WEIGHT", DEFAULT_CONFIDENCE_WEIGHT);

  const candidates = (await Promise.all(dedicatedRoutes.map(async (route): Promise<ProviderRouteCandidate | null> => {
    const accounts = await input.keyPool.getRequestOrder(route.providerId).catch(() => []);
    if (accounts.length === 0) {
      return null;
    }

    const healthyAccounts = accounts
      .map((credential) => isCredentialHealthy(credential, input.healthStore, minHealthScore))
      .filter((entry) => entry.healthy);
    if (healthyAccounts.length === 0) {
      return null;
    }

    const perf = input.requestLogStore.getModelPerfSummary(route.providerId, input.model, input.upstreamMode);
    return {
      route,
      perf,
      healthScore: Math.max(...healthyAccounts.map((entry) => entry.healthScore)),
      healthyAccountCount: healthyAccounts.length,
      pheromone: input.pheromoneStore.getPheromone(route.providerId, input.model),
    };
  }))).filter((candidate): candidate is ProviderRouteCandidate => candidate !== null);

  if (candidates.length === 0) {
    return { orderedRoutes: [...passthroughRoutes], signals: [] };
  }

  const ttftValues = candidates
    .map((candidate) => candidate.perf?.ewmaTtftMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const minTtftMs = ttftValues.length > 0 ? Math.min(...ttftValues) : 0;
  const maxTtftMs = ttftValues.length > 0 ? Math.max(...ttftValues) : 0;

  const scoredCandidates = candidates.map((candidate) => {
    const latencyScore = toLatencyScore(candidate.perf, minTtftMs, maxTtftMs);
    const recencyScore = toRecencyScore(candidate.perf);
    const confidenceScore = toConfidenceScore(candidate.perf);
    const heuristicScore = clamp(
      (wHealth * candidate.healthScore)
      + (wLatency * latencyScore)
      + (wRecency * recencyScore)
      + (wConfidence * confidenceScore),
    );
    const combinedScore = clamp((alpha * candidate.pheromone) + (beta * heuristicScore));

    return {
      ...candidate,
      latencyScore,
      recencyScore,
      confidenceScore,
      heuristicScore,
      combinedScore,
    };
  });

  const orderedDedicated = weightedRandomOrder(scoredCandidates, input.rng ?? Math.random);
  return {
    orderedRoutes: [...orderedDedicated.map((candidate) => candidate.route), ...passthroughRoutes],
    signals: orderedDedicated.map((candidate) => ({
      providerId: candidate.route.providerId,
      healthScore: candidate.healthScore,
      latencyScore: candidate.latencyScore,
      recencyScore: candidate.recencyScore,
      confidenceScore: candidate.confidenceScore,
      heuristicScore: candidate.heuristicScore,
      pheromone: candidate.pheromone,
      combinedScore: candidate.combinedScore,
      healthyAccountCount: candidate.healthyAccountCount,
      sampleCount: candidate.perf?.sampleCount ?? 0,
    })),
  };
}
