import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../../../../routes/types.js";
import type { CredentialStoreLike } from "../../../../lib/credential-store.js";
import type { KeyPool, KeyPoolAccountStatus } from "../../../../lib/key-pool.js";
import { RequestLogStore, type RequestLogEntry } from "../../../../lib/request-log-store.js";
import type { SqlRequestUsageStore } from "../../../../lib/db/sql-request-usage-store.js";
import { normalizeTenantId } from "../../../../lib/tenant-api-key.js";
import { getResolvedAuth, authCanViewTenant } from "../../../shared/ui-auth.js";
import type { ResolvedRequestAuth } from "../../../../lib/request-auth.js";

interface UsageAccountSummary {
  readonly accountId: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly authType: "api_key" | "oauth_bearer" | "local" | "none";
  readonly planType?: string;
  readonly status: "healthy" | "cooldown" | "idle";
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly avgDecodeTps: number | null;
  readonly avgTtftMs: number | null;
  readonly avgTps: number | null;
  readonly avgEndToEndTps: number | null;
  readonly healthScore: number | null;
  readonly transientDebuff: number | null;
  readonly lastUsedAt: string | null;
}

interface TrendPoint {
  readonly t: string;
  readonly v: number;
}

type UsageWindow = "daily" | "weekly" | "monthly";

interface UsageOverviewResponse {
  readonly window: UsageWindow;
  readonly generatedAt: string;
  readonly coverage: {
    readonly requestedWindowStart: string;
    readonly coverageStart: string | null;
    readonly hasFullWindowCoverage: boolean;
    readonly retainedEntryCount: number;
    readonly maxRetainedEntries: number;
  };
  readonly summary: {
    readonly requests24h: number;
    readonly tokens24h: number;
    readonly promptTokens24h: number;
    readonly completionTokens24h: number;
    readonly cachedPromptTokens24h: number;
    readonly imageCount24h: number;
    readonly imageCostUsd24h: number;
    readonly costUsd24h: number;
    readonly energyJoules24h: number;
    readonly waterEvaporatedMl24h: number;
    readonly cacheKeyUses24h: number;
    readonly cacheHitRate24h: number;
    readonly errorRate24h: number;
    readonly topModel: string | null;
    readonly topProvider: string | null;
    readonly activeAccounts: number;
    readonly routingRequests24h: {
      readonly local: number;
      readonly federated: number;
      readonly bridge: number;
      readonly distinctPeers: number;
      readonly topPeer: string | null;
    };
    readonly serviceTierRequests24h: {
      readonly fastMode: number;
      readonly priority: number;
      readonly standard: number;
    };
  };
  readonly trends: {
    readonly requests: readonly TrendPoint[];
    readonly tokens: readonly TrendPoint[];
    readonly errors: readonly TrendPoint[];
  };
  readonly accounts: readonly UsageAccountSummary[];
}

interface AnalyticsCoverageResponse {
  readonly requestedWindowStart: string;
  readonly coverageStart: string | null;
  readonly hasFullWindowCoverage: boolean;
  readonly retainedEntryCount: number;
  readonly maxRetainedEntries: number;
}

interface AnalyticsRowResponse {
  readonly providerId?: string;
  readonly model?: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly errorRate: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly cacheHitRate: number;
  readonly avgTtftMs: number | null;
  readonly avgDecodeTps: number | null;
  readonly avgTps: number | null;
  readonly avgEndToEndTps: number | null;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly providerCoverageCount?: number;
  readonly modelCoverageCount?: number;
  readonly confidenceScore: number;
  readonly suitabilityScore: number | null;
}

interface ProviderModelAnalyticsResponse {
  readonly window: UsageWindow;
  readonly generatedAt: string;
  readonly coverage: AnalyticsCoverageResponse;
  readonly models: readonly AnalyticsRowResponse[];
  readonly providers: readonly AnalyticsRowResponse[];
  readonly providerModels: readonly AnalyticsRowResponse[];
}

interface UsageScope {
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
}

export function toUsageWindow(value: unknown): UsageWindow {
  if (value === "weekly" || value === "monthly" || value === "daily") {
    return value;
  }

  if (typeof value !== "string") {
    return "daily";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "month" || normalized === "monthly" || normalized === "30d") {
    return "monthly";
  }
  if (normalized === "week" || normalized === "7d") {
    return "weekly";
  }
  return "daily";
}

export function toSafeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), max));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(parsed, max));
    }
  }

  return fallback;
}

function isoFromTimestamp(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function usageCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percentage(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Number(((part / total) * 100).toFixed(2));
}

function isRequestLogError(entry: {
  readonly status: number;
  readonly error?: string;
}): boolean {
  return entry.status >= 400 || typeof entry.error === "string";
}

function cacheKeyUseCountForEntry(entry: {
  readonly promptCacheKeyUsed?: boolean;
  readonly status: number;
  readonly error?: string;
}): number {
  return entry.promptCacheKeyUsed === true && !isRequestLogError(entry) ? 1 : 0;
}

function cacheHitCountForEntry(entry: {
  readonly cacheHit?: boolean;
  readonly status: number;
  readonly error?: string;
}): number {
  return entry.cacheHit === true && !isRequestLogError(entry) ? 1 : 0;
}

function summarizeRouting(entries: readonly RequestLogEntry[]): {
  readonly local: number;
  readonly federated: number;
  readonly bridge: number;
  readonly distinctPeers: number;
  readonly topPeer: string | null;
} {
  let local = 0;
  let federated = 0;
  let bridge = 0;
  const peerCounts = new Map<string, number>();

  for (const entry of entries) {
    const routeKind = entry.routeKind ?? "local";
    if (routeKind === "federated") {
      federated += 1;
    } else if (routeKind === "bridge") {
      bridge += 1;
    } else {
      local += 1;
    }

    const peerKey = entry.routedPeerLabel?.trim() || entry.routedPeerId?.trim();
    if (peerKey) {
      peerCounts.set(peerKey, (peerCounts.get(peerKey) ?? 0) + 1);
    }
  }

  const topPeer = [...peerCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;

  return {
    local,
    federated,
    bridge,
    distinctPeers: peerCounts.size,
    topPeer,
  };
}

function bucketStart(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function hasUsageScope(scope: UsageScope | undefined): boolean {
  return Boolean(scope?.tenantId || scope?.issuer || scope?.keyId);
}

function entryMatchesUsageScope(entry: {
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
}, scope: UsageScope | undefined): boolean {
  if (!scope) {
    return true;
  }

  if (scope.tenantId && entry.tenantId !== scope.tenantId) {
    return false;
  }

  if (scope.issuer && entry.issuer !== scope.issuer) {
    return false;
  }

  if (scope.keyId && entry.keyId !== scope.keyId) {
    return false;
  }

  return true;
}

export async function resolveUsageScopeFromAuth(input: {
  readonly auth: ResolvedRequestAuth;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
}): Promise<UsageScope | { readonly error: string; readonly statusCode: number }> {
  const requestedTenantId = typeof input.tenantId === "string" && input.tenantId.trim().length > 0
    ? normalizeTenantId(input.tenantId)
    : undefined;
  const requestedIssuer = typeof input.issuer === "string" && input.issuer.trim().length > 0
    ? input.issuer.trim()
    : undefined;
  const requestedKeyId = typeof input.keyId === "string" && input.keyId.trim().length > 0
    ? input.keyId.trim()
    : undefined;

  if (input.auth.kind === "legacy_admin" || input.auth.kind === "unauthenticated") {
    return {
      tenantId: requestedTenantId,
      issuer: requestedIssuer,
      keyId: requestedKeyId,
    };
  }

  const tenantId = requestedTenantId ?? input.auth.tenantId;
  if (tenantId && !authCanViewTenant(input.auth, tenantId)) {
    return { error: "forbidden", statusCode: 403 };
  }

  if (input.auth.kind === "tenant_api_key") {
    if (requestedKeyId && input.auth.keyId && requestedKeyId !== input.auth.keyId) {
      return { error: "forbidden", statusCode: 403 };
    }

    return {
      tenantId,
      issuer: requestedIssuer,
      keyId: input.auth.keyId,
    };
  }

  return {
    tenantId,
    issuer: requestedIssuer,
    keyId: requestedKeyId,
  };
}

function resolveUsageWindowConfig(window: UsageWindow, now: number): {
  readonly bucketMs: number;
  readonly bucketCount: number;
  readonly bucketWindowStart: number;
  readonly entryWindowStart: number;
} {
  const bucketMs = window === "daily" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const bucketCount = window === "monthly" ? 30 : window === "weekly" ? 7 : 24;
  const bucketWindowStart = bucketStart(now - (bucketCount - 1) * bucketMs, bucketMs);
  const entryWindowStart = now - bucketCount * bucketMs;

  return {
    bucketMs,
    bucketCount,
    bucketWindowStart,
    entryWindowStart,
  };
}

async function buildUsageOverviewFromEntries(
  entries: readonly RequestLogEntry[],
  keyPool: KeyPool,
  credentialStore: CredentialStoreLike,
  sort: string | undefined,
  window: UsageWindow,
  now: number,
  coverage: {
    readonly coverageStartMs: number | null;
    readonly retainedEntryCount: number;
    readonly maxRetainedEntries: number;
  },
): Promise<UsageOverviewResponse> {
  const allAccountStatuses: Record<string, readonly KeyPoolAccountStatus[]> = await keyPool.getAllAccountStatuses().catch(() => ({}));
  const credentialProviders = await credentialStore.listProviders(false).catch(() => []);
  const providerById = new Map(credentialProviders.map((provider) => [provider.id, provider]));
  const { bucketMs, bucketCount, bucketWindowStart, entryWindowStart } = resolveUsageWindowConfig(window, now);
  const recentLogs = entries.filter((entry) => entry.timestamp >= entryWindowStart);
  const routingSummary = summarizeRouting(recentLogs);

  const bucketAgg = new Map<number, {
    requests: number;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    imageCount: number;
    imageCostUsd: number;
    costUsd: number;
    energyJoules: number;
    waterEvaporatedMl: number;
    cacheHits: number;
    cacheKeyUses: number;
    errors: number;
    fastMode: number;
    priority: number;
    standard: number;
  }>();
  const modelTotals = new Map<string, number>();
  const providerTotals = new Map<string, number>();
  const accountAgg = new Map<string, {
    accountId: string;
    providerId: string;
    authType: "api_key" | "oauth_bearer" | "local" | "none";
    requestCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    imageCount: number;
    imageCostUsd: number;
    costUsd: number;
    energyJoules: number;
    waterEvaporatedMl: number;
    cacheHitCount: number;
    cacheKeyUseCount: number;
    ttftSum: number;
    ttftCount: number;
    tpsSum: number;
    tpsCount: number;
    endToEndTpsSum: number;
    endToEndTpsCount: number;
    lastUsedAtMs: number;
  }>();
  const shortAgg = new Map<string, { ttftSum: number; ttftCount: number; tpsSum: number; tpsCount: number }>();
  const shortWindowMs = 2 * 60 * 1000;

  for (const entry of recentLogs) {
    const cacheHits = cacheHitCountForEntry(entry);
    const cacheKeyUses = cacheKeyUseCountForEntry(entry);
    const seriesBucket = bucketAgg.get(bucketStart(entry.timestamp, bucketMs)) ?? {
      requests: 0,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      imageCount: 0,
      imageCostUsd: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      cacheHits: 0,
      cacheKeyUses: 0,
      errors: 0,
      fastMode: 0,
      priority: 0,
      standard: 0,
    };
    seriesBucket.requests += 1;
    seriesBucket.tokens += usageCount(entry.totalTokens);
    seriesBucket.promptTokens += usageCount(entry.promptTokens);
    seriesBucket.completionTokens += usageCount(entry.completionTokens);
    seriesBucket.cachedPromptTokens += usageCount(entry.cachedPromptTokens);
    seriesBucket.imageCount += usageCount(entry.imageCount);
    seriesBucket.imageCostUsd += usageCount(entry.imageCostUsd);
    seriesBucket.costUsd += usageCount(entry.costUsd);
    seriesBucket.energyJoules += usageCount(entry.energyJoules);
    seriesBucket.waterEvaporatedMl += usageCount(entry.waterEvaporatedMl);
    seriesBucket.cacheHits += cacheHits;
    seriesBucket.cacheKeyUses += cacheKeyUses;
    if (isRequestLogError(entry)) {
      seriesBucket.errors += 1;
    }
    if (entry.serviceTierSource === "fast_mode") {
      seriesBucket.fastMode += 1;
    } else if (entry.serviceTier === "priority") {
      seriesBucket.priority += 1;
    } else {
      seriesBucket.standard += 1;
    }
    bucketAgg.set(bucketStart(entry.timestamp, bucketMs), seriesBucket);

    modelTotals.set(entry.model, (modelTotals.get(entry.model) ?? 0) + usageCount(entry.totalTokens));
    providerTotals.set(entry.providerId, (providerTotals.get(entry.providerId) ?? 0) + usageCount(entry.totalTokens));

    const accountKey = `${entry.providerId}\0${entry.accountId}`;
    const account = accountAgg.get(accountKey) ?? {
      accountId: entry.accountId,
      providerId: entry.providerId,
      authType: entry.authType,
      requestCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      imageCount: 0,
      imageCostUsd: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      lastUsedAtMs: 0,
    };
    account.requestCount += 1;
    account.totalTokens += usageCount(entry.totalTokens);
    account.promptTokens += usageCount(entry.promptTokens);
    account.completionTokens += usageCount(entry.completionTokens);
    account.cachedPromptTokens += usageCount(entry.cachedPromptTokens);
    account.imageCount += usageCount(entry.imageCount);
    account.imageCostUsd += usageCount(entry.imageCostUsd);
    account.costUsd += usageCount(entry.costUsd);
    account.energyJoules += usageCount(entry.energyJoules);
    account.waterEvaporatedMl += usageCount(entry.waterEvaporatedMl);
    account.cacheHitCount += cacheHits;
    account.cacheKeyUseCount += cacheKeyUses;
    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
      account.ttftSum += entry.ttftMs;
      account.ttftCount += 1;
    }
    if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
      account.tpsSum += entry.tps;
      account.tpsCount += 1;
    }
    if (typeof entry.endToEndTps === "number" && Number.isFinite(entry.endToEndTps)) {
      account.endToEndTpsSum += entry.endToEndTps;
      account.endToEndTpsCount += 1;
    }
    account.lastUsedAtMs = Math.max(account.lastUsedAtMs, entry.timestamp);
    accountAgg.set(accountKey, account);

    if (entry.timestamp >= now - shortWindowMs) {
      const short = shortAgg.get(accountKey) ?? { ttftSum: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0 };
      if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
        short.ttftSum += entry.ttftMs;
        short.ttftCount += 1;
      }
      if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
        short.tpsSum += entry.tps;
        short.tpsCount += 1;
      }
      shortAgg.set(accountKey, short);
    }
  }

  const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
  const healthScoreFor = (account: {
    providerId: string;
    accountId: string;
    requestCount: number;
    totalTokens: number;
    ttftSum: number;
    ttftCount: number;
    tpsSum: number;
    tpsCount: number;
    endToEndTpsSum: number;
    endToEndTpsCount: number;
  }, status: "healthy" | "cooldown" | "idle") => {
    if (status === "cooldown") {
      return { score: 0, debuff: 1, avgTtftMs: null, avgTps: null, avgEndToEndTps: null };
    }

    const avgTtftMs = account.ttftCount > 0 ? account.ttftSum / account.ttftCount : null;
    const avgTps = account.tpsCount > 0 ? account.tpsSum / account.tpsCount : null;
    const avgEndToEndTps = account.endToEndTpsCount > 0 ? account.endToEndTpsSum / account.endToEndTpsCount : null;
    const recent = shortAgg.get(`${account.providerId}\0${account.accountId}`);
    const recentTtft = recent && recent.ttftCount > 0 ? recent.ttftSum / recent.ttftCount : null;
    const recentTps = recent && recent.tpsCount > 0 ? recent.tpsSum / recent.tpsCount : null;

    let debuff = 0;
    if (avgTtftMs !== null && recentTtft !== null && recentTtft > avgTtftMs * 1.3) {
      debuff = Math.max(debuff, clamp01((recentTtft / avgTtftMs - 1) * 0.6));
    }
    if (avgTps !== null && recentTps !== null && recentTps < avgTps * 0.7) {
      debuff = Math.max(debuff, clamp01((avgTps / Math.max(1e-9, recentTps) - 1) * 0.25));
    }

    const ttftScore = avgTtftMs !== null ? 1 / (1 + avgTtftMs / 800) : 0.5;
    const tpsScore = avgTps !== null ? clamp01(avgTps / 50) : 0.5;
    const usageScore = clamp01(Math.log10(1 + account.totalTokens) / 6);
    return {
      score: clamp01(0.65 * ttftScore + 0.25 * tpsScore + 0.10 * usageScore - debuff * 0.35),
      debuff,
      avgTtftMs,
      avgTps,
      avgEndToEndTps,
    };
  };

  // Ensure all configured provider accounts appear in accountAgg, even if idle (zero requests).
  for (const provider of credentialProviders) {
    for (const providerAccount of provider.accounts) {
      const accountKey = `${provider.id}\0${providerAccount.id}`;
      if (!accountAgg.has(accountKey)) {
        accountAgg.set(accountKey, {
          accountId: providerAccount.id,
          providerId: provider.id,
          authType: providerAccount.authType,
          requestCount: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedPromptTokens: 0,
          imageCount: 0,
          imageCostUsd: 0,
          costUsd: 0,
          energyJoules: 0,
          waterEvaporatedMl: 0,
          cacheHitCount: 0,
          cacheKeyUseCount: 0,
          ttftSum: 0,
          ttftCount: 0,
          tpsSum: 0,
          tpsCount: 0,
          endToEndTpsSum: 0,
          endToEndTpsCount: 0,
          lastUsedAtMs: 0,
        });
      }
    }
  }

  const accountStats = [...accountAgg.values()].map((account) => {
    const provider = providerById.get(account.providerId);
    const providerAccount = provider?.accounts.find((candidate) => candidate.id === account.accountId);
    const accountStatus = (allAccountStatuses[account.providerId] ?? []).find((candidate) => candidate.accountId === account.accountId);
    const status = accountStatus && !accountStatus.available
      ? "cooldown"
      : account.requestCount > 0
        ? "healthy"
        : "idle";
    const health = healthScoreFor(account, status);

    return {
      accountId: account.accountId,
      displayName: `${account.providerId}/${account.accountId}`,
      providerId: account.providerId,
      authType: providerAccount?.authType ?? account.authType,
      planType: providerAccount?.planType,
      status,
      requestCount: account.requestCount,
      totalTokens: account.totalTokens,
      promptTokens: account.promptTokens,
      completionTokens: account.completionTokens,
      cachedPromptTokens: account.cachedPromptTokens,
      imageCount: account.imageCount,
      imageCostUsd: account.imageCostUsd,
      costUsd: account.costUsd,
      energyJoules: account.energyJoules,
      waterEvaporatedMl: account.waterEvaporatedMl,
      cacheHitCount: account.cacheHitCount,
      cacheKeyUseCount: account.cacheKeyUseCount,
      avgDecodeTps: health.avgTps,
      avgTtftMs: health.avgTtftMs,
      avgTps: health.avgTps,
      avgEndToEndTps: health.avgEndToEndTps,
      healthScore: health.score,
      transientDebuff: health.debuff,
      lastUsedAt: isoFromTimestamp(account.lastUsedAtMs),
    } satisfies UsageAccountSummary;
  });

  const bucketSeries = Array.from({ length: bucketCount }, (_, index) => {
    const timestamp = bucketStart(now - (bucketCount - index - 1) * bucketMs, bucketMs);
    const bucket = bucketAgg.get(timestamp);
    return {
      t: new Date(timestamp).toISOString(),
      requests: bucket?.requests ?? 0,
      tokens: bucket?.tokens ?? 0,
      errors: bucket?.errors ?? 0,
    };
  });

  const totals = [...bucketAgg.values()].reduce((acc, bucket) => ({
    requests: acc.requests + bucket.requests,
    tokens: acc.tokens + bucket.tokens,
    promptTokens: acc.promptTokens + bucket.promptTokens,
    completionTokens: acc.completionTokens + bucket.completionTokens,
    cachedPromptTokens: acc.cachedPromptTokens + bucket.cachedPromptTokens,
    imageCount: acc.imageCount + bucket.imageCount,
    imageCostUsd: acc.imageCostUsd + bucket.imageCostUsd,
    costUsd: acc.costUsd + bucket.costUsd,
    energyJoules: acc.energyJoules + bucket.energyJoules,
    waterEvaporatedMl: acc.waterEvaporatedMl + bucket.waterEvaporatedMl,
    cacheHits: acc.cacheHits + bucket.cacheHits,
    cacheKeyUses: acc.cacheKeyUses + bucket.cacheKeyUses,
    errors: acc.errors + bucket.errors,
    fastMode: acc.fastMode + bucket.fastMode,
    priority: acc.priority + bucket.priority,
    standard: acc.standard + bucket.standard,
  }), {
    requests: 0,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    imageCount: 0,
    imageCostUsd: 0,
    costUsd: 0,
    energyJoules: 0,
    waterEvaporatedMl: 0,
    cacheHits: 0,
    cacheKeyUses: 0,
    errors: 0,
    fastMode: 0,
    priority: 0,
    standard: 0,
  });

  return {
    window,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      requestedWindowStart: new Date(bucketWindowStart).toISOString(),
      coverageStart: coverage.coverageStartMs !== null ? new Date(coverage.coverageStartMs).toISOString() : null,
      hasFullWindowCoverage: coverage.coverageStartMs !== null && coverage.coverageStartMs <= bucketWindowStart,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxRetainedEntries,
    },
    summary: {
      requests24h: totals.requests,
      tokens24h: totals.tokens,
      promptTokens24h: totals.promptTokens,
      completionTokens24h: totals.completionTokens,
      cachedPromptTokens24h: totals.cachedPromptTokens,
      imageCount24h: totals.imageCount,
      imageCostUsd24h: totals.imageCostUsd,
      costUsd24h: totals.costUsd,
      energyJoules24h: totals.energyJoules,
      waterEvaporatedMl24h: totals.waterEvaporatedMl,
      cacheKeyUses24h: totals.cacheKeyUses,
      cacheHitRate24h: totals.cacheKeyUses > 0 ? percentage(totals.cacheHits, totals.cacheKeyUses) : 0,
      errorRate24h: percentage(totals.errors, totals.requests),
      topModel: [...modelTotals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null,
      topProvider: [...providerTotals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null,
      activeAccounts: accountStats.filter((account) => account.requestCount > 0).length,
      routingRequests24h: routingSummary,
      serviceTierRequests24h: {
        fastMode: totals.fastMode,
        priority: totals.priority,
        standard: totals.standard,
      },
    },
    trends: {
      requests: bucketSeries.map((point) => ({ t: point.t, v: point.requests })),
      tokens: bucketSeries.map((point) => ({ t: point.t, v: point.tokens })),
      errors: bucketSeries.map((point) => ({ t: point.t, v: point.errors })),
    },
    accounts: [...accountStats].sort((a, b) => {
      const sortKey = (sort ?? "health").trim().toLowerCase();
      const byTokens = (): number => {
        if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
        if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
        return a.displayName.localeCompare(b.displayName);
      };

      switch (sortKey) {
        case "tokens":
          return byTokens();
        case "requests":
          if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
          return byTokens();
        case "ttft": {
          const leftValue = a.avgTtftMs ?? Number.POSITIVE_INFINITY;
          const rightValue = b.avgTtftMs ?? Number.POSITIVE_INFINITY;
          if (leftValue !== rightValue) return leftValue - rightValue;
          return byTokens();
        }
        case "tps":
        case "decode-tps": {
          const leftValue = a.avgTps ?? Number.NEGATIVE_INFINITY;
          const rightValue = b.avgTps ?? Number.NEGATIVE_INFINITY;
          if (leftValue !== rightValue) return rightValue - leftValue;
          return byTokens();
        }
        case "e2e-tps": {
          const leftValue = a.avgEndToEndTps ?? Number.NEGATIVE_INFINITY;
          const rightValue = b.avgEndToEndTps ?? Number.NEGATIVE_INFINITY;
          if (leftValue !== rightValue) return rightValue - leftValue;
          return byTokens();
        }
        case "health":
        default: {
          const leftValue = a.healthScore ?? -1;
          const rightValue = b.healthScore ?? -1;
          if (leftValue !== rightValue) return rightValue - leftValue;
          return byTokens();
        }
      }
    }),
  };
}

export async function buildUsageOverview(
  requestLogStore: RequestLogStore,
  keyPool: KeyPool,
  credentialStore: CredentialStoreLike,
  sort?: string,
  window: UsageWindow = "daily",
  scope?: UsageScope,
  sqlRequestUsageStore?: SqlRequestUsageStore,
): Promise<UsageOverviewResponse> {
  const now = Date.now();
  const { bucketWindowStart: sharedBucketWindowStart, entryWindowStart: sharedEntryWindowStart } = resolveUsageWindowConfig(window, now);

  if (sqlRequestUsageStore) {
    const [entries, coverage] = await Promise.all([
      sqlRequestUsageStore.listEntriesSince(sharedEntryWindowStart, scope),
      sqlRequestUsageStore.getCoverage(scope),
    ]);

    return buildUsageOverviewFromEntries(entries, keyPool, credentialStore, sort, window, now, {
      coverageStartMs: coverage.earliestEntryAtMs,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxRetainedEntries,
    });
  }

  if (hasUsageScope(scope)) {
    const allLogs = requestLogStore.snapshot().filter((entry) => entryMatchesUsageScope(entry, scope));
    return buildUsageOverviewFromEntries(allLogs, keyPool, credentialStore, sort, window, now, {
      coverageStartMs: allLogs.reduce<number | null>((current, entry) => current === null ? entry.timestamp : Math.min(current, entry.timestamp), null),
      retainedEntryCount: allLogs.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  const allLogs = requestLogStore.snapshot();
  const hasPersistedNonDailyRollups = window !== "daily" && (
    requestLogStore.snapshotDailyBuckets(sharedBucketWindowStart).length > 0
    || requestLogStore.snapshotDailyModelBuckets(sharedBucketWindowStart).length > 0
    || requestLogStore.snapshotDailyAccountBuckets(sharedBucketWindowStart).length > 0
  );

  if (allLogs.length > 0 && !hasPersistedNonDailyRollups) {
    return buildUsageOverviewFromEntries(allLogs, keyPool, credentialStore, sort, window, now, {
      coverageStartMs: allLogs.reduce<number | null>((current, entry) => current === null ? entry.timestamp : Math.min(current, entry.timestamp), null),
      retainedEntryCount: allLogs.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  const _allStatuses: Record<string, Awaited<ReturnType<KeyPool["getStatus"]>>> = await keyPool.getAllStatuses().catch(() => ({}));
  const allAccountStatuses: Record<string, readonly KeyPoolAccountStatus[]> = await keyPool.getAllAccountStatuses().catch(() => ({}));
  const credentialProviders = await credentialStore.listProviders(false).catch(() => []);
  const providerById = new Map(credentialProviders.map((provider) => [provider.id, provider]));
  const { bucketMs, bucketCount, bucketWindowStart, entryWindowStart } = resolveUsageWindowConfig(window, now);

  const recentLogs = allLogs.filter((entry) => entry.timestamp >= entryWindowStart);
  const routingSummary = summarizeRouting(recentLogs);
  const recentModelBuckets = requestLogStore.snapshotDailyModelBuckets(bucketWindowStart);
  const recentAccountBuckets = window === "daily"
    ? undefined
    : requestLogStore.snapshotDailyAccountBuckets(bucketWindowStart);
  const modelTotals = new Map<string, number>();
  const providerTotals = new Map<string, number>();

  const recentBuckets = window === "daily"
    ? requestLogStore.snapshotHourlyBuckets(bucketWindowStart)
    : requestLogStore.snapshotDailyBuckets(bucketWindowStart);
  const bucketByStart = new Map(recentBuckets.map((bucket) => [bucket.startMs, bucket]));

  const totalRequests = recentBuckets.reduce((sum, bucket) => sum + bucket.requestCount, 0);
  const totalTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  const promptTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.promptTokens, 0);
  const completionTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.completionTokens, 0);
  const cachedPromptTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.cachedPromptTokens, 0);
  const imageCount = recentBuckets.reduce((sum, bucket) => sum + bucket.imageCount, 0);
  const imageCostUsd = recentBuckets.reduce((sum, bucket) => sum + bucket.imageCostUsd, 0);
  const costUsd = recentBuckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
  const energyJoules = recentBuckets.reduce((sum, bucket) => sum + bucket.energyJoules, 0);
  const waterEvaporatedMl = recentBuckets.reduce((sum, bucket) => sum + bucket.waterEvaporatedMl, 0);
  const cacheKeyUses = recentBuckets.reduce((sum, bucket) => sum + bucket.cacheKeyUseCount, 0);
  const cacheHits = recentBuckets.reduce((sum, bucket) => sum + bucket.cacheHitCount, 0);
  const totalErrors = recentBuckets.reduce((sum, bucket) => sum + bucket.errorCount, 0);

  const fastModeTierRequests = recentBuckets.reduce((sum, bucket) => sum + bucket.fastModeRequestCount, 0);
  const priorityTierRequests = recentBuckets.reduce((sum, bucket) => sum + bucket.priorityRequestCount, 0);
  const standardTierRequests = recentBuckets.reduce((sum, bucket) => sum + bucket.standardRequestCount, 0);

  type AccountAgg = {
    accountId: string;
    providerId: string;
    authType: "api_key" | "oauth_bearer" | "local" | "none";
    requestCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    imageCount: number;
    imageCostUsd: number;
    costUsd: number;
    energyJoules: number;
    waterEvaporatedMl: number;
    cacheHitCount: number;
    cacheKeyUseCount: number;
    ttftSum: number;
    ttftCount: number;
    tpsSum: number;
    tpsCount: number;
    endToEndTpsSum: number;
    endToEndTpsCount: number;
    lastUsedAtMs: number;
  };

  const accountAgg = new Map<string, AccountAgg>();
  const shortWindowMs = 2 * 60 * 1000;
  const shortAgg = new Map<string, { ttftSum: number; ttftCount: number; tpsSum: number; tpsCount: number }>();

  if (window === "daily") {
    for (const entry of recentLogs) {
      const mapKey = `${entry.providerId}\0${entry.accountId}`;
      const existing = accountAgg.get(mapKey) ?? {
        accountId: entry.accountId,
        providerId: entry.providerId,
        authType: entry.authType,
        requestCount: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        imageCount: 0,
        imageCostUsd: 0,
        costUsd: 0,
        energyJoules: 0,
        waterEvaporatedMl: 0,
        cacheHitCount: 0,
        cacheKeyUseCount: 0,
        ttftSum: 0,
        ttftCount: 0,
        tpsSum: 0,
        tpsCount: 0,
        endToEndTpsSum: 0,
        endToEndTpsCount: 0,
        lastUsedAtMs: 0,
      };

      existing.requestCount += 1;
      existing.totalTokens += usageCount(entry.totalTokens);
      existing.promptTokens += usageCount(entry.promptTokens);
      existing.completionTokens += usageCount(entry.completionTokens);
      existing.cachedPromptTokens += usageCount(entry.cachedPromptTokens);
      existing.imageCount += usageCount(entry.imageCount);
      existing.imageCostUsd += usageCount(entry.imageCostUsd);
      existing.costUsd += usageCount(entry.costUsd);
      existing.energyJoules += usageCount(entry.energyJoules);
      existing.waterEvaporatedMl += usageCount(entry.waterEvaporatedMl);
      if (entry.cacheHit) existing.cacheHitCount += 1;
      if (entry.promptCacheKeyUsed) existing.cacheKeyUseCount += 1;
      if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
        existing.ttftSum += entry.ttftMs;
        existing.ttftCount += 1;
      }
      if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
        existing.tpsSum += entry.tps;
        existing.tpsCount += 1;
      }
      if (typeof entry.endToEndTps === "number" && Number.isFinite(entry.endToEndTps)) {
        existing.endToEndTpsSum += entry.endToEndTps;
        existing.endToEndTpsCount += 1;
      }
      existing.lastUsedAtMs = Math.max(existing.lastUsedAtMs, entry.timestamp);
      accountAgg.set(mapKey, existing);
    }
  } else {
    for (const acc of recentAccountBuckets ?? []) {
      const mapKey = `${acc.providerId}\0${acc.accountId}`;
      accountAgg.set(mapKey, {
        accountId: acc.accountId,
        providerId: acc.providerId,
        authType: acc.authType,
        requestCount: acc.requestCount,
        totalTokens: acc.totalTokens,
        promptTokens: acc.promptTokens,
        completionTokens: acc.completionTokens,
        cachedPromptTokens: acc.cachedPromptTokens,
        imageCount: acc.imageCount,
        imageCostUsd: acc.imageCostUsd,
        costUsd: acc.costUsd,
        energyJoules: acc.energyJoules,
        waterEvaporatedMl: acc.waterEvaporatedMl,
        cacheHitCount: acc.cacheHitCount,
        cacheKeyUseCount: acc.cacheKeyUseCount,
        ttftSum: acc.ttftSum,
        ttftCount: acc.ttftCount,
        tpsSum: acc.tpsSum,
        tpsCount: acc.tpsCount,
        endToEndTpsSum: acc.endToEndTpsSum,
        endToEndTpsCount: acc.endToEndTpsCount,
        lastUsedAtMs: acc.lastUsedAtMs,
      });
    }
  }

  if (window === "daily") {
    for (const entry of recentLogs) {
      modelTotals.set(entry.model, (modelTotals.get(entry.model) ?? 0) + usageCount(entry.totalTokens));
      providerTotals.set(entry.providerId, (providerTotals.get(entry.providerId) ?? 0) + usageCount(entry.totalTokens));
    }
  } else {
    for (const bucket of recentModelBuckets) {
      modelTotals.set(bucket.model, (modelTotals.get(bucket.model) ?? 0) + bucket.totalTokens);
      providerTotals.set(bucket.providerId, (providerTotals.get(bucket.providerId) ?? 0) + bucket.totalTokens);
    }
  }

  for (const entry of recentLogs) {
    if (entry.timestamp >= now - shortWindowMs) {
      const mapKey = `${entry.providerId}\0${entry.accountId}`;
      const short = shortAgg.get(mapKey) ?? { ttftSum: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0 };
      if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
        short.ttftSum += entry.ttftMs;
        short.ttftCount += 1;
      }
      if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
        short.tpsSum += entry.tps;
        short.tpsCount += 1;
      }
      shortAgg.set(mapKey, short);
    }
  }

  const accountStats = new Map<string, UsageAccountSummary>();

  const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
  const healthScoreFor = (agg: AccountAgg, status: "healthy" | "cooldown" | "idle"): { score: number | null; debuff: number | null; avgTtftMs: number | null; avgTps: number | null; avgEndToEndTps: number | null } => {
    if (status === "cooldown") {
      return { score: 0, debuff: 1, avgTtftMs: null, avgTps: null, avgEndToEndTps: null };
    }

    const avgTtftMs = agg.ttftCount > 0 ? agg.ttftSum / agg.ttftCount : null;
    const avgTps = agg.tpsCount > 0 ? agg.tpsSum / agg.tpsCount : null;
    const avgEndToEndTps = agg.endToEndTpsCount > 0 ? agg.endToEndTpsSum / agg.endToEndTpsCount : null;

    const recent = shortAgg.get(`${agg.providerId}\0${agg.accountId}`);
    const recentTtft = recent && recent.ttftCount > 0 ? recent.ttftSum / recent.ttftCount : null;
    const recentTps = recent && recent.tpsCount > 0 ? recent.tpsSum / recent.tpsCount : null;

    let debuff = 0;
    if (avgTtftMs !== null && recentTtft !== null && recentTtft > avgTtftMs * 1.3) {
      debuff = Math.max(debuff, clamp01((recentTtft / avgTtftMs - 1) * 0.6));
    }
    if (avgTps !== null && recentTps !== null && recentTps < avgTps * 0.7) {
      debuff = Math.max(debuff, clamp01((avgTps / Math.max(1e-9, recentTps) - 1) * 0.25));
    }

    const ttftScore = avgTtftMs !== null ? 1 / (1 + avgTtftMs / 800) : 0.5;
    const tpsScore = avgTps !== null ? clamp01(avgTps / 50) : 0.5;
    const usageScore = clamp01(Math.log10(1 + agg.totalTokens) / 6);

    const score = clamp01(0.65 * ttftScore + 0.25 * tpsScore + 0.10 * usageScore - debuff * 0.35);
    return { score, debuff, avgTtftMs, avgTps, avgEndToEndTps };
  };

  for (const [providerId, provider] of providerById.entries()) {
    const accountStatusById = new Map((allAccountStatuses[providerId] ?? []).map((entry) => [entry.accountId, entry]));

    for (const account of provider.accounts) {
      const mapKey = `${providerId}\0${account.id}`;
      const agg = accountAgg.get(mapKey) ?? {
        accountId: account.id,
        providerId,
        authType: account.authType,
        requestCount: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        imageCount: 0,
        imageCostUsd: 0,
        costUsd: 0,
        energyJoules: 0,
        waterEvaporatedMl: 0,
        cacheHitCount: 0,
        cacheKeyUseCount: 0,
        ttftSum: 0,
        ttftCount: 0,
        tpsSum: 0,
        tpsCount: 0,
        endToEndTpsSum: 0,
        endToEndTpsCount: 0,
        lastUsedAtMs: 0,
      };

      const accountStatus = accountStatusById.get(account.id);
      const inKeyPool = accountStatus !== undefined;
      const status = accountStatus && !accountStatus.available
        ? "cooldown"
        : agg.requestCount > 0 || inKeyPool
          ? "healthy"
          : "idle";

      const health = healthScoreFor(agg, status);

      accountStats.set(mapKey, {
        accountId: account.id,
        displayName: `${providerId}/${account.id}`,
        providerId,
        authType: account.authType,
        planType: account.planType,
        status,
        requestCount: agg.requestCount,
        totalTokens: agg.totalTokens,
        promptTokens: agg.promptTokens,
        completionTokens: agg.completionTokens,
        cachedPromptTokens: agg.cachedPromptTokens,
        imageCount: agg.imageCount,
        imageCostUsd: agg.imageCostUsd,
        costUsd: agg.costUsd,
        energyJoules: agg.energyJoules,
        waterEvaporatedMl: agg.waterEvaporatedMl,
        cacheHitCount: agg.cacheHitCount,
        cacheKeyUseCount: agg.cacheKeyUseCount,
        avgDecodeTps: health.avgTps,
        avgTtftMs: health.avgTtftMs,
        avgTps: health.avgTps,
        avgEndToEndTps: health.avgEndToEndTps,
        healthScore: health.score,
        transientDebuff: health.debuff,
        lastUsedAt: isoFromTimestamp(agg.lastUsedAtMs),
      });
    }
  }

  const bucketSeries = Array.from({ length: bucketCount }, (_, index) => {
    const timestamp = bucketStart(now - (bucketCount - index - 1) * bucketMs, bucketMs);
    const bucket = bucketByStart.get(timestamp);
    return {
      t: new Date(timestamp).toISOString(),
      requests: bucket?.requestCount ?? 0,
      tokens: bucket?.totalTokens ?? 0,
      errors: bucket?.errorCount ?? 0,
    };
  });

  const topModel = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topProvider = [...providerTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const activeAccounts = [...accountStats.values()].filter((account) => account.requestCount > 0).length;
  const coverage = requestLogStore.getCoverage();
  const relevantCoverageStarts = window === "daily"
    ? [coverage.earliestHourlyBucketAtMs, coverage.earliestEntryAtMs]
    : [coverage.earliestDailyBucketAtMs, coverage.earliestModelBreakdownAtMs, coverage.earliestAccountBreakdownAtMs];
  const coverageStartMs = relevantCoverageStarts.reduce<number | null>((current, value) => {
    if (value === null) {
      return current;
    }

    return current === null ? value : Math.max(current, value);
  }, null);
  const hasFullWindowCoverage = coverageStartMs !== null && coverageStartMs <= bucketWindowStart;

  const cacheHitRate24h = cacheKeyUses > 0 ? percentage(cacheHits, cacheKeyUses) : 0;

  return {
    window,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      requestedWindowStart: new Date(bucketWindowStart).toISOString(),
      coverageStart: coverageStartMs !== null ? new Date(coverageStartMs).toISOString() : null,
      hasFullWindowCoverage,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxEntries,
    },
    summary: {
      requests24h: totalRequests,
      tokens24h: totalTokens,
      promptTokens24h: promptTokens,
      completionTokens24h: completionTokens,
      cachedPromptTokens24h: cachedPromptTokens,
      imageCount24h: imageCount,
      imageCostUsd24h: imageCostUsd,
      costUsd24h: costUsd,
      energyJoules24h: energyJoules,
      waterEvaporatedMl24h: waterEvaporatedMl,
      cacheKeyUses24h: cacheKeyUses,
      cacheHitRate24h,
      errorRate24h: percentage(totalErrors, totalRequests),
      topModel,
      topProvider,
      activeAccounts,
      routingRequests24h: routingSummary,
      serviceTierRequests24h: {
        fastMode: fastModeTierRequests,
        priority: priorityTierRequests,
        standard: standardTierRequests,
      },
    },
    trends: {
      requests: bucketSeries.map((point) => ({ t: point.t, v: point.requests })),
      tokens: bucketSeries.map((point) => ({ t: point.t, v: point.tokens })),
      errors: bucketSeries.map((point) => ({ t: point.t, v: point.errors })),
    },
    accounts: [...accountStats.values()].sort((a, b) => {
      const sortKey = (sort ?? "health").trim().toLowerCase();

      const byTokens = (): number => {
        if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
        if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
        return a.displayName.localeCompare(b.displayName);
      };

      switch (sortKey) {
        case "tokens":
          return byTokens();
        case "requests":
          if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
          return byTokens();
        case "ttft": {
          const ttftA = a.avgTtftMs ?? Number.POSITIVE_INFINITY;
          const ttftB = b.avgTtftMs ?? Number.POSITIVE_INFINITY;
          if (ttftA !== ttftB) return ttftA - ttftB;
          return byTokens();
        }
        case "tps":
        case "decode-tps": {
          const tpsA = a.avgTps ?? Number.NEGATIVE_INFINITY;
          const tpsB = b.avgTps ?? Number.NEGATIVE_INFINITY;
          if (tpsA !== tpsB) return tpsB - tpsA;
          return byTokens();
        }
        case "e2e-tps": {
          const tpsA = a.avgEndToEndTps ?? Number.NEGATIVE_INFINITY;
          const tpsB = b.avgEndToEndTps ?? Number.NEGATIVE_INFINITY;
          if (tpsA !== tpsB) return tpsB - tpsA;
          return byTokens();
        }
        case "health":
        default: {
          const scoreA = a.healthScore ?? -1;
          const scoreB = b.healthScore ?? -1;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return byTokens();
        }
      }
    }),
  };
}

// ===== Extracted functions from ui-routes.ts =====

type MutableAnalyticsAgg = {
  providerId?: string;
  model?: string;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  ttftSum: number;
  ttftCount: number;
  tpsSum: number;
  tpsCount: number;
  endToEndTpsSum: number;
  endToEndTpsCount: number;
  costUsd: number;
  energyJoules: number;
  waterEvaporatedMl: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
};

function clamp01Analytics(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function confidenceScoreForRequests(requestCount: number): number {
  return clamp01Analytics(Math.log10(1 + requestCount) / 3);
}

function suitabilityScoreForAgg(agg: MutableAnalyticsAgg): number | null {
  if (agg.requestCount <= 0) {
    return null;
  }

  const avgTtftMs = agg.ttftCount > 0 ? agg.ttftSum / agg.ttftCount : null;
  const avgTps = agg.tpsCount > 0 ? agg.tpsSum / agg.tpsCount : null;
  const errorRate = agg.requestCount > 0 ? agg.errorCount / agg.requestCount : 0;
  const cacheHitRate = agg.cacheKeyUseCount > 0 ? agg.cacheHitCount / agg.cacheKeyUseCount : 0;
  const ttftScore = avgTtftMs !== null ? 1 / (1 + avgTtftMs / 1000) : 0.5;
  const tpsScore = avgTps !== null ? clamp01Analytics(avgTps / 80) : 0.5;
  const successScore = 1 - clamp01Analytics(errorRate);
  const confidenceScore = confidenceScoreForRequests(agg.requestCount);
  const cacheScore = clamp01Analytics(cacheHitRate);

  return clamp01Analytics((0.40 * ttftScore + 0.25 * tpsScore + 0.20 * successScore + 0.15 * cacheScore) * (0.5 + 0.5 * confidenceScore));
}

function toAnalyticsRow(
  agg: MutableAnalyticsAgg,
  extras: {
    readonly providerCoverageCount?: number;
    readonly modelCoverageCount?: number;
  } = {},
): AnalyticsRowResponse {
  const avgTtftMs = agg.ttftCount > 0 ? agg.ttftSum / agg.ttftCount : null;
  const avgTps = agg.tpsCount > 0 ? agg.tpsSum / agg.tpsCount : null;
  const avgEndToEndTps = agg.endToEndTpsCount > 0 ? agg.endToEndTpsSum / agg.endToEndTpsCount : null;
  const errorRate = agg.requestCount > 0 ? percentage(agg.errorCount, agg.requestCount) : 0;
  const cacheHitRate = agg.cacheKeyUseCount > 0 ? percentage(agg.cacheHitCount, agg.cacheKeyUseCount) : 0;

  return {
    providerId: agg.providerId,
    model: agg.model,
    requestCount: agg.requestCount,
    errorCount: agg.errorCount,
    errorRate,
    totalTokens: agg.totalTokens,
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    cachedPromptTokens: agg.cachedPromptTokens,
    cacheHitRate,
    avgTtftMs,
    avgDecodeTps: avgTps,
    avgTps,
    avgEndToEndTps,
    costUsd: agg.costUsd,
    energyJoules: agg.energyJoules,
    waterEvaporatedMl: agg.waterEvaporatedMl,
    firstSeenAt: isoFromTimestamp(agg.firstSeenAtMs ?? undefined),
    lastSeenAt: isoFromTimestamp(agg.lastSeenAtMs ?? undefined),
    providerCoverageCount: extras.providerCoverageCount,
    modelCoverageCount: extras.modelCoverageCount,
    confidenceScore: confidenceScoreForRequests(agg.requestCount),
    suitabilityScore: suitabilityScoreForAgg(agg),
  };
}

function sortAnalyticsRows(rows: readonly AnalyticsRowResponse[], sort: string | undefined): AnalyticsRowResponse[] {
  const sortKey = typeof sort === "string" ? sort.trim().toLowerCase() : "suitability";
  const nextRows = [...rows];

  nextRows.sort((left, right) => {
    const fallback = () => {
      const labelLeft = left.model ?? left.providerId ?? "";
      const labelRight = right.model ?? right.providerId ?? "";
      return labelLeft.localeCompare(labelRight);
    };

    switch (sortKey) {
      case "requests":
        return right.requestCount - left.requestCount || right.totalTokens - left.totalTokens || fallback();
      case "tokens":
        return right.totalTokens - left.totalTokens || right.requestCount - left.requestCount || fallback();
      case "ttft": {
        const leftValue = left.avgTtftMs ?? Number.POSITIVE_INFINITY;
        const rightValue = right.avgTtftMs ?? Number.POSITIVE_INFINITY;
        return leftValue - rightValue || right.totalTokens - left.totalTokens || fallback();
      }
      case "tps":
      case "decode-tps": {
        const leftValue = left.avgTps ?? Number.NEGATIVE_INFINITY;
        const rightValue = right.avgTps ?? Number.NEGATIVE_INFINITY;
        return rightValue - leftValue || right.totalTokens - left.totalTokens || fallback();
      }
      case "e2e-tps": {
        const leftValue = left.avgEndToEndTps ?? Number.NEGATIVE_INFINITY;
        const rightValue = right.avgEndToEndTps ?? Number.NEGATIVE_INFINITY;
        return rightValue - leftValue || right.totalTokens - left.totalTokens || fallback();
      }
      case "errors":
      case "error-rate":
        return left.errorRate - right.errorRate || right.totalTokens - left.totalTokens || fallback();
      case "cost":
        return left.costUsd - right.costUsd || right.totalTokens - left.totalTokens || fallback();
      case "suitability":
      default: {
        const leftValue = left.suitabilityScore ?? -1;
        const rightValue = right.suitabilityScore ?? -1;
        return rightValue - leftValue || right.totalTokens - left.totalTokens || fallback();
      }
    }
  });

  return nextRows;
}

function buildProviderModelAnalyticsFromEntries(
  entries: readonly RequestLogEntry[],
  window: UsageWindow,
  sort: string | undefined,
  now: number,
  coverage: {
    readonly coverageStartMs: number | null;
    readonly retainedEntryCount: number;
    readonly maxRetainedEntries: number;
  },
): ProviderModelAnalyticsResponse {
  const { bucketWindowStart, entryWindowStart } = resolveUsageWindowConfig(window, now);
  const relevantEntries = entries.filter((entry) => entry.timestamp >= entryWindowStart);
  const pairAgg = new Map<string, MutableAnalyticsAgg>();

  const upsertPair = (providerId: string, model: string): MutableAnalyticsAgg => {
    const key = `${providerId}\0${model}`;
    const existing = pairAgg.get(key);
    if (existing) {
      return existing;
    }

    const created: MutableAnalyticsAgg = {
      providerId,
      model,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    };
    pairAgg.set(key, created);
    return created;
  };

  for (const entry of relevantEntries) {
    const agg = upsertPair(entry.providerId, entry.model);
    agg.requestCount += 1;
    if (isRequestLogError(entry)) {
      agg.errorCount += 1;
    }
    agg.totalTokens += usageCount(entry.totalTokens);
    agg.promptTokens += usageCount(entry.promptTokens);
    agg.completionTokens += usageCount(entry.completionTokens);
    agg.cachedPromptTokens += usageCount(entry.cachedPromptTokens);
    agg.cacheHitCount += cacheHitCountForEntry(entry);
    agg.cacheKeyUseCount += cacheKeyUseCountForEntry(entry);
    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
      agg.ttftSum += entry.ttftMs;
      agg.ttftCount += 1;
    }
    if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
      agg.tpsSum += entry.tps;
      agg.tpsCount += 1;
    }
    if (typeof entry.endToEndTps === "number" && Number.isFinite(entry.endToEndTps)) {
      agg.endToEndTpsSum += entry.endToEndTps;
      agg.endToEndTpsCount += 1;
    }
    agg.costUsd += usageCount(entry.costUsd);
    agg.energyJoules += usageCount(entry.energyJoules);
    agg.waterEvaporatedMl += usageCount(entry.waterEvaporatedMl);
    agg.firstSeenAtMs = agg.firstSeenAtMs === null ? entry.timestamp : Math.min(agg.firstSeenAtMs, entry.timestamp);
    agg.lastSeenAtMs = agg.lastSeenAtMs === null ? entry.timestamp : Math.max(agg.lastSeenAtMs, entry.timestamp);
  }

  const pairRows = [...pairAgg.values()];
  const modelAgg = new Map<string, MutableAnalyticsAgg>();
  const modelProviderCoverage = new Map<string, Set<string>>();
  const providerAgg = new Map<string, MutableAnalyticsAgg>();
  const providerModelCoverage = new Map<string, Set<string>>();

  for (const pair of pairRows) {
    const modelId = pair.model ?? "unknown";
    const providerId = pair.providerId ?? "unknown";

    const modelRow = modelAgg.get(modelId) ?? {
      model: modelId,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    } as MutableAnalyticsAgg;
    modelRow.requestCount += pair.requestCount;
    modelRow.errorCount += pair.errorCount;
    modelRow.totalTokens += pair.totalTokens;
    modelRow.promptTokens += pair.promptTokens;
    modelRow.completionTokens += pair.completionTokens;
    modelRow.cachedPromptTokens += pair.cachedPromptTokens;
    modelRow.cacheHitCount += pair.cacheHitCount;
    modelRow.cacheKeyUseCount += pair.cacheKeyUseCount;
    modelRow.ttftSum += pair.ttftSum;
    modelRow.ttftCount += pair.ttftCount;
    modelRow.tpsSum += pair.tpsSum;
    modelRow.tpsCount += pair.tpsCount;
    modelRow.endToEndTpsSum += pair.endToEndTpsSum;
    modelRow.endToEndTpsCount += pair.endToEndTpsCount;
    modelRow.costUsd += pair.costUsd;
    modelRow.energyJoules += pair.energyJoules;
    modelRow.waterEvaporatedMl += pair.waterEvaporatedMl;
    modelRow.firstSeenAtMs = modelRow.firstSeenAtMs === null ? pair.firstSeenAtMs : Math.min(modelRow.firstSeenAtMs, pair.firstSeenAtMs ?? modelRow.firstSeenAtMs);
    modelRow.lastSeenAtMs = modelRow.lastSeenAtMs === null ? pair.lastSeenAtMs : Math.max(modelRow.lastSeenAtMs, pair.lastSeenAtMs ?? modelRow.lastSeenAtMs);
    modelAgg.set(modelId, modelRow);
    const providerSet = modelProviderCoverage.get(modelId) ?? new Set<string>();
    providerSet.add(providerId);
    modelProviderCoverage.set(modelId, providerSet);

    const providerRow = providerAgg.get(providerId) ?? {
      providerId,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    } as MutableAnalyticsAgg;
    providerRow.requestCount += pair.requestCount;
    providerRow.errorCount += pair.errorCount;
    providerRow.totalTokens += pair.totalTokens;
    providerRow.promptTokens += pair.promptTokens;
    providerRow.completionTokens += pair.completionTokens;
    providerRow.cachedPromptTokens += pair.cachedPromptTokens;
    providerRow.cacheHitCount += pair.cacheHitCount;
    providerRow.cacheKeyUseCount += pair.cacheKeyUseCount;
    providerRow.ttftSum += pair.ttftSum;
    providerRow.ttftCount += pair.ttftCount;
    providerRow.tpsSum += pair.tpsSum;
    providerRow.tpsCount += pair.tpsCount;
    providerRow.endToEndTpsSum += pair.endToEndTpsSum;
    providerRow.endToEndTpsCount += pair.endToEndTpsCount;
    providerRow.costUsd += pair.costUsd;
    providerRow.energyJoules += pair.energyJoules;
    providerRow.waterEvaporatedMl += pair.waterEvaporatedMl;
    providerRow.firstSeenAtMs = providerRow.firstSeenAtMs === null ? pair.firstSeenAtMs : Math.min(providerRow.firstSeenAtMs, pair.firstSeenAtMs ?? providerRow.firstSeenAtMs);
    providerRow.lastSeenAtMs = providerRow.lastSeenAtMs === null ? pair.lastSeenAtMs : Math.max(providerRow.lastSeenAtMs, pair.lastSeenAtMs ?? providerRow.lastSeenAtMs);
    providerAgg.set(providerId, providerRow);
    const modelSet = providerModelCoverage.get(providerId) ?? new Set<string>();
    modelSet.add(modelId);
    providerModelCoverage.set(providerId, modelSet);
  }

  return {
    window,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      requestedWindowStart: new Date(bucketWindowStart).toISOString(),
      coverageStart: coverage.coverageStartMs !== null ? new Date(coverage.coverageStartMs).toISOString() : null,
      hasFullWindowCoverage: coverage.coverageStartMs !== null && coverage.coverageStartMs <= bucketWindowStart,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxRetainedEntries,
    },
    models: sortAnalyticsRows(
      [...modelAgg.entries()].map(([modelId, agg]) => toAnalyticsRow(agg, { providerCoverageCount: modelProviderCoverage.get(modelId)?.size ?? 0 })),
      sort,
    ),
    providers: sortAnalyticsRows(
      [...providerAgg.entries()].map(([providerId, agg]) => toAnalyticsRow(agg, { modelCoverageCount: providerModelCoverage.get(providerId)?.size ?? 0 })),
      sort,
    ),
    providerModels: sortAnalyticsRows(pairRows.map((agg) => toAnalyticsRow(agg)), sort),
  };
}

export async function buildProviderModelAnalytics(
  requestLogStore: RequestLogStore,
  window: UsageWindow = "weekly",
  sort?: string,
  scope?: UsageScope,
  sqlRequestUsageStore?: SqlRequestUsageStore,
): Promise<ProviderModelAnalyticsResponse> {
  const now = Date.now();
  const { bucketWindowStart, entryWindowStart } = resolveUsageWindowConfig(window, now);

  if (sqlRequestUsageStore) {
    const [entries, coverage] = await Promise.all([
      sqlRequestUsageStore.listEntriesSince(entryWindowStart, scope),
      sqlRequestUsageStore.getCoverage(scope),
    ]);
    return buildProviderModelAnalyticsFromEntries(entries, window, sort, now, {
      coverageStartMs: coverage.earliestEntryAtMs,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxRetainedEntries,
    });
  }

  if (hasUsageScope(scope)) {
    const relevantEntries = requestLogStore.snapshot().filter((entry) => entryMatchesUsageScope(entry, scope));
    return buildProviderModelAnalyticsFromEntries(relevantEntries, window, sort, now, {
      coverageStartMs: relevantEntries.reduce<number | null>((current, entry) => current === null ? entry.timestamp : Math.min(current, entry.timestamp), null),
      retainedEntryCount: relevantEntries.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  const allLogs = requestLogStore.snapshot();
  if (allLogs.length > 0) {
    return buildProviderModelAnalyticsFromEntries(allLogs, window, sort, now, {
      coverageStartMs: allLogs.reduce<number | null>((current, entry) => current === null ? entry.timestamp : Math.min(current, entry.timestamp), null),
      retainedEntryCount: allLogs.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  const { bucketWindowStart: optimizedBucketWindowStart, entryWindowStart: optimizedEntryWindowStart } = resolveUsageWindowConfig(window, now);
  const pairAgg = new Map<string, MutableAnalyticsAgg>();

  const upsertPair = (providerId: string, model: string): MutableAnalyticsAgg => {
    const key = `${providerId}\0${model}`;
    const existing = pairAgg.get(key);
    if (existing) {
      return existing;
    }

    const created: MutableAnalyticsAgg = {
      providerId,
      model,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    };

    pairAgg.set(key, created);
    return created;
  };

  if (window === "daily") {
    for (const entry of requestLogStore.snapshot().filter((item) => item.timestamp >= optimizedEntryWindowStart)) {
      const agg = upsertPair(entry.providerId, entry.model);
      agg.requestCount += 1;
      if (entry.status >= 400 || typeof entry.error === "string") {
        agg.errorCount += 1;
      }
      agg.totalTokens += usageCount(entry.totalTokens);
      agg.promptTokens += usageCount(entry.promptTokens);
      agg.completionTokens += usageCount(entry.completionTokens);
      agg.cachedPromptTokens += usageCount(entry.cachedPromptTokens);
      if (entry.cacheHit) {
        agg.cacheHitCount += 1;
      }
      if (entry.promptCacheKeyUsed) {
        agg.cacheKeyUseCount += 1;
      }
      if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
        agg.ttftSum += entry.ttftMs;
        agg.ttftCount += 1;
      }
      if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
        agg.tpsSum += entry.tps;
        agg.tpsCount += 1;
      }
      if (typeof entry.endToEndTps === "number" && Number.isFinite(entry.endToEndTps)) {
        agg.endToEndTpsSum += entry.endToEndTps;
        agg.endToEndTpsCount += 1;
      }
      agg.costUsd += usageCount(entry.costUsd);
      agg.energyJoules += usageCount(entry.energyJoules);
      agg.waterEvaporatedMl += usageCount(entry.waterEvaporatedMl);
      agg.firstSeenAtMs = agg.firstSeenAtMs === null ? entry.timestamp : Math.min(agg.firstSeenAtMs, entry.timestamp);
      agg.lastSeenAtMs = agg.lastSeenAtMs === null ? entry.timestamp : Math.max(agg.lastSeenAtMs, entry.timestamp);
    }
  } else {
    for (const bucket of requestLogStore.snapshotDailyModelBuckets(optimizedBucketWindowStart)) {
      const agg = upsertPair(bucket.providerId, bucket.model);
      agg.requestCount += bucket.requestCount;
      agg.errorCount += bucket.errorCount;
      agg.totalTokens += bucket.totalTokens;
      agg.promptTokens += bucket.promptTokens;
      agg.completionTokens += bucket.completionTokens;
      agg.cachedPromptTokens += bucket.cachedPromptTokens;
      agg.cacheHitCount += bucket.cacheHitCount;
      agg.cacheKeyUseCount += bucket.cacheKeyUseCount;
      agg.ttftSum += bucket.ttftSum;
      agg.ttftCount += bucket.ttftCount;
      agg.tpsSum += bucket.tpsSum;
      agg.tpsCount += bucket.tpsCount;
      agg.endToEndTpsSum += bucket.endToEndTpsSum;
      agg.endToEndTpsCount += bucket.endToEndTpsCount;
      agg.costUsd += bucket.costUsd;
      agg.energyJoules += bucket.energyJoules;
      agg.waterEvaporatedMl += bucket.waterEvaporatedMl;
      agg.firstSeenAtMs = agg.firstSeenAtMs === null ? bucket.startMs : Math.min(agg.firstSeenAtMs, bucket.startMs);
      agg.lastSeenAtMs = agg.lastSeenAtMs === null ? bucket.lastUsedAtMs : Math.max(agg.lastSeenAtMs, bucket.lastUsedAtMs);
    }
  }

  const pairRows = [...pairAgg.values()];
  const modelAgg = new Map<string, MutableAnalyticsAgg>();
  const modelProviderCoverage = new Map<string, Set<string>>();
  const providerAgg = new Map<string, MutableAnalyticsAgg>();
  const providerModelCoverage = new Map<string, Set<string>>();

  for (const pair of pairRows) {
    const modelId = pair.model ?? "unknown";
    const providerId = pair.providerId ?? "unknown";

    const modelRow = modelAgg.get(modelId) ?? {
      model: modelId,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    } as MutableAnalyticsAgg;
    modelRow.requestCount += pair.requestCount;
    modelRow.errorCount += pair.errorCount;
    modelRow.totalTokens += pair.totalTokens;
    modelRow.promptTokens += pair.promptTokens;
    modelRow.completionTokens += pair.completionTokens;
    modelRow.cachedPromptTokens += pair.cachedPromptTokens;
    modelRow.cacheHitCount += pair.cacheHitCount;
    modelRow.cacheKeyUseCount += pair.cacheKeyUseCount;
    modelRow.ttftSum += pair.ttftSum;
    modelRow.ttftCount += pair.ttftCount;
    modelRow.tpsSum += pair.tpsSum;
    modelRow.tpsCount += pair.tpsCount;
    modelRow.endToEndTpsSum += pair.endToEndTpsSum;
    modelRow.endToEndTpsCount += pair.endToEndTpsCount;
    modelRow.costUsd += pair.costUsd;
    modelRow.energyJoules += pair.energyJoules;
    modelRow.waterEvaporatedMl += pair.waterEvaporatedMl;
    modelRow.firstSeenAtMs = modelRow.firstSeenAtMs === null ? pair.firstSeenAtMs : Math.min(modelRow.firstSeenAtMs, pair.firstSeenAtMs ?? modelRow.firstSeenAtMs);
    modelRow.lastSeenAtMs = modelRow.lastSeenAtMs === null ? pair.lastSeenAtMs : Math.max(modelRow.lastSeenAtMs, pair.lastSeenAtMs ?? modelRow.lastSeenAtMs);
    modelAgg.set(modelId, modelRow);
    const providerSet = modelProviderCoverage.get(modelId) ?? new Set<string>();
    providerSet.add(providerId);
    modelProviderCoverage.set(modelId, providerSet);

    const providerRow = providerAgg.get(providerId) ?? {
      providerId,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      endToEndTpsSum: 0,
      endToEndTpsCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    } as MutableAnalyticsAgg;
    providerRow.requestCount += pair.requestCount;
    providerRow.errorCount += pair.errorCount;
    providerRow.totalTokens += pair.totalTokens;
    providerRow.promptTokens += pair.promptTokens;
    providerRow.completionTokens += pair.completionTokens;
    providerRow.cachedPromptTokens += pair.cachedPromptTokens;
    providerRow.cacheHitCount += pair.cacheHitCount;
    providerRow.cacheKeyUseCount += pair.cacheKeyUseCount;
    providerRow.ttftSum += pair.ttftSum;
    providerRow.ttftCount += pair.ttftCount;
    providerRow.tpsSum += pair.tpsSum;
    providerRow.tpsCount += pair.tpsCount;
    providerRow.endToEndTpsSum += pair.endToEndTpsSum;
    providerRow.endToEndTpsCount += pair.endToEndTpsCount;
    providerRow.costUsd += pair.costUsd;
    providerRow.energyJoules += pair.energyJoules;
    providerRow.waterEvaporatedMl += pair.waterEvaporatedMl;
    providerRow.firstSeenAtMs = providerRow.firstSeenAtMs === null ? pair.firstSeenAtMs : Math.min(providerRow.firstSeenAtMs, pair.firstSeenAtMs ?? providerRow.firstSeenAtMs);
    providerRow.lastSeenAtMs = providerRow.lastSeenAtMs === null ? pair.lastSeenAtMs : Math.max(providerRow.lastSeenAtMs, pair.lastSeenAtMs ?? providerRow.lastSeenAtMs);
    providerAgg.set(providerId, providerRow);
    const modelSet = providerModelCoverage.get(providerId) ?? new Set<string>();
    modelSet.add(modelId);
    providerModelCoverage.set(providerId, modelSet);
  }

  const coverage = requestLogStore.getCoverage();
  const relevantCoverageStarts = window === "daily"
    ? [coverage.earliestEntryAtMs]
    : [coverage.earliestDailyBucketAtMs, coverage.earliestModelBreakdownAtMs];
  const coverageStartMs = relevantCoverageStarts.reduce<number | null>((current, value) => {
    if (value === null) {
      return current;
    }

    return current === null ? value : Math.max(current, value);
  }, null);

  return {
    window,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      requestedWindowStart: new Date(bucketWindowStart).toISOString(),
      coverageStart: coverageStartMs !== null ? new Date(coverageStartMs).toISOString() : null,
      hasFullWindowCoverage: coverageStartMs !== null && coverageStartMs <= bucketWindowStart,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxEntries,
    },
    models: sortAnalyticsRows(
      [...modelAgg.entries()].map(([modelId, agg]) => toAnalyticsRow(agg, { providerCoverageCount: modelProviderCoverage.get(modelId)?.size ?? 0 })),
      sort,
    ),
    providers: sortAnalyticsRows(
      [...providerAgg.entries()].map(([providerId, agg]) => toAnalyticsRow(agg, { modelCoverageCount: providerModelCoverage.get(providerId)?.size ?? 0 })),
      sort,
    ),
    providerModels: sortAnalyticsRows(pairRows.map((agg) => toAnalyticsRow(agg)), sort),
  };
}

export async function registerUsageAnalyticsRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<void> {
  const credentialStore = deps.credentialStore;

  app.get<{
    Querystring: { readonly sort?: string; readonly window?: string; readonly tenantId?: string; readonly issuer?: string; readonly keyId?: string };
  }>("/api/ui/dashboard/overview", async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const scope = await resolveUsageScopeFromAuth({
      auth,
      tenantId: request.query.tenantId,
      issuer: request.query.issuer,
      keyId: request.query.keyId,
    });
    if ("error" in scope) {
      reply.code(scope.statusCode).send({ error: scope.error });
      return;
    }

    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const window = toUsageWindow(request.query.window);
    const overview = await buildUsageOverview(deps.requestLogStore, deps.keyPool, credentialStore, sort, window, scope, deps.sqlRequestUsageStore);
    reply.send(overview);
  });

  app.get<{
    Querystring: { readonly sort?: string; readonly window?: string; readonly tenantId?: string; readonly issuer?: string; readonly keyId?: string };
  }>("/api/ui/analytics/provider-model", async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const scope = await resolveUsageScopeFromAuth({
      auth,
      tenantId: request.query.tenantId,
      issuer: request.query.issuer,
      keyId: request.query.keyId,
    });
    if ("error" in scope) {
      reply.code(scope.statusCode).send({ error: scope.error });
      return;
    }

    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const window = toUsageWindow(request.query.window);
    const analytics = await buildProviderModelAnalytics(deps.requestLogStore, window, sort, scope, deps.sqlRequestUsageStore);
    reply.send(analytics);
  });
}

// Export types for external use
export type { UsageAccountSummary, UsageOverviewResponse, AnalyticsCoverageResponse, AnalyticsRowResponse, ProviderModelAnalyticsResponse, UsageScope, TrendPoint, UsageWindow };
