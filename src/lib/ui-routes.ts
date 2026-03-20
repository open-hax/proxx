import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";

import type { ProxyConfig } from "./config.js";
import { CredentialStore, type CredentialStoreLike } from "./credential-store.js";
import type { ResolvedRequestAuth } from "./request-auth.js";
import type { KeyPool, KeyPoolAccountStatus } from "./key-pool.js";
import { OpenAiOAuthManager } from "./openai-oauth.js";
import { FactoryOAuthManager } from "./factory-oauth.js";
import { fetchOpenAiQuotaSnapshots } from "./openai-quota.js";
import { RequestLogStore } from "./request-log-store.js";
import { ChromaSessionIndex } from "./chroma-session-index.js";
import { SessionStore, type ChatRole } from "./session-store.js";
import { getToolSeedForModel, loadMcpSeeds } from "./tool-mcp-seed.js";
import type { ProxySettingsStore } from "./proxy-settings-store.js";
import type { EventStore } from "./db/event-store.js";
import type { SqlCredentialStore } from "./db/sql-credential-store.js";

interface UiRouteDependencies {
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly requestLogStore: RequestLogStore;
  readonly credentialStore: CredentialStoreLike;
  readonly sqlCredentialStore?: SqlCredentialStore;
  readonly proxySettingsStore: ProxySettingsStore;
  readonly eventStore?: EventStore;
  readonly refreshOpenAiOauthAccounts?: (accountId?: string) => Promise<{
    readonly totalAccounts: number;
    readonly refreshedCount: number;
    readonly failedCount: number;
  }>;
}

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
  readonly avgTtftMs: number | null;
  readonly avgTps: number | null;
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
  readonly avgTps: number | null;
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

function toUsageWindow(value: unknown): UsageWindow {
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

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to next candidate.
    }
  }

  return undefined;
}

async function loadUiIndexHtml(): Promise<string | undefined> {
  const indexPath = await firstExistingPath([
    resolve(process.cwd(), "web/dist/index.html"),
    resolve(process.cwd(), "dist/web/index.html"),
    resolve(process.cwd(), "../web/dist/index.html"),
  ]);

  if (!indexPath) {
    return undefined;
  }

  return readFile(indexPath, "utf8");
}

async function resolveUiAssetPath(assetPath: string): Promise<string | undefined> {
  const normalized = assetPath.replace(/^\/+/, "");
  const candidates = [
    resolve(process.cwd(), "web/dist", normalized),
    resolve(process.cwd(), "dist/web", normalized),
    resolve(process.cwd(), "../web/dist", normalized),
  ];

  return firstExistingPath(candidates);
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getResolvedAuth(request: { readonly openHaxAuth?: unknown }): ResolvedRequestAuth | undefined {
  const auth = request.openHaxAuth;
  return typeof auth === "object" && auth !== null ? auth as ResolvedRequestAuth : undefined;
}

function authCanViewTenant(auth: ResolvedRequestAuth | undefined, tenantId: string): boolean {
  if (!auth) {
    return false;
  }

  if (auth.kind === "legacy_admin") {
    return true;
  }

  return auth.tenantId === tenantId;
}

function authCanManageTenantKeys(auth: ResolvedRequestAuth | undefined, tenantId: string): boolean {
  if (!auth) {
    return false;
  }

  if (auth.kind === "legacy_admin") {
    return true;
  }

  return (auth.role === "owner" || auth.role === "admin") && auth.tenantId === tenantId;
}

function toChatRole(value: unknown): ChatRole {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }

  return "user";
}

function toSafeLimit(value: unknown, fallback: number, max: number): number {
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

function bucketStart(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

async function buildUsageOverview(
  requestLogStore: RequestLogStore,
  keyPool: KeyPool,
  credentialStore: CredentialStoreLike,
  sort?: string,
  window: UsageWindow = "daily",
): Promise<UsageOverviewResponse> {
  const allLogs = requestLogStore.snapshot();
  const allStatuses: Record<string, Awaited<ReturnType<KeyPool["getStatus"]>>> = await keyPool.getAllStatuses().catch(() => ({}));
  const allAccountStatuses: Record<string, readonly KeyPoolAccountStatus[]> = await keyPool.getAllAccountStatuses().catch(() => ({}));
  const credentialProviders = await credentialStore.listProviders(false).catch(() => []);
  const providerById = new Map(credentialProviders.map((provider) => [provider.id, provider]));

  const now = Date.now();

  const bucketMs = window === "daily" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const bucketCount = window === "monthly" ? 30 : window === "weekly" ? 7 : 24;
  const bucketWindowStart = bucketStart(now - (bucketCount - 1) * bucketMs, bucketMs);

  const recentLogs = allLogs.filter((entry) => entry.timestamp >= bucketWindowStart);
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
  const healthScoreFor = (agg: AccountAgg, status: "healthy" | "cooldown" | "idle"): { score: number | null; debuff: number | null; avgTtftMs: number | null; avgTps: number | null } => {
    if (status === "cooldown") {
      return { score: 0, debuff: 1, avgTtftMs: null, avgTps: null };
    }

    const avgTtftMs = agg.ttftCount > 0 ? agg.ttftSum / agg.ttftCount : null;
    const avgTps = agg.tpsCount > 0 ? agg.tpsSum / agg.tpsCount : null;

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
    return { score, debuff, avgTtftMs, avgTps };
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
        avgTtftMs: health.avgTtftMs,
        avgTps: health.avgTps,
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
        case "tps": {
          const tpsA = a.avgTps ?? Number.NEGATIVE_INFINITY;
          const tpsB = b.avgTps ?? Number.NEGATIVE_INFINITY;
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
    avgTps,
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
      case "tps": {
        const leftValue = left.avgTps ?? Number.NEGATIVE_INFINITY;
        const rightValue = right.avgTps ?? Number.NEGATIVE_INFINITY;
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

async function buildProviderModelAnalytics(
  requestLogStore: RequestLogStore,
  window: UsageWindow = "weekly",
  sort?: string,
): Promise<ProviderModelAnalyticsResponse> {
  const now = Date.now();
  const bucketMs = window === "daily" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const bucketCount = window === "monthly" ? 30 : window === "weekly" ? 7 : 24;
  const bucketWindowStart = bucketStart(now - (bucketCount - 1) * bucketMs, bucketMs);
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
    for (const entry of requestLogStore.snapshot().filter((item) => item.timestamp >= bucketWindowStart)) {
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
      agg.costUsd += usageCount(entry.costUsd);
      agg.energyJoules += usageCount(entry.energyJoules);
      agg.waterEvaporatedMl += usageCount(entry.waterEvaporatedMl);
      agg.firstSeenAtMs = agg.firstSeenAtMs === null ? entry.timestamp : Math.min(agg.firstSeenAtMs, entry.timestamp);
      agg.lastSeenAtMs = agg.lastSeenAtMs === null ? entry.timestamp : Math.max(agg.lastSeenAtMs, entry.timestamp);
    }
  } else {
    for (const bucket of requestLogStore.snapshotDailyModelBuckets(bucketWindowStart)) {
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

export function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlSuccess(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html>
  <head>
    <title>Open Hax OAuth Success</title>
    <style>
      body { font-family: "IBM Plex Sans", "Fira Sans", sans-serif; background: radial-gradient(circle at top, #12313b 0%, #0b161c 60%); color: #e9f7fb; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      .card { background: rgba(17, 33, 42, 0.86); border: 1px solid rgba(145, 212, 232, 0.35); padding: 28px; border-radius: 14px; width: min(560px, 90vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }
      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }
      p { margin: 0; color: #bce2ec; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Authorization Successful</h1>
      <p>${safe}</p>
    </section>
    <script>setTimeout(() => window.close(), 1500)</script>
  </body>
</html>`;
}

function htmlError(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html>
  <head>
    <title>Open Hax OAuth Failed</title>
    <style>
      body { font-family: "IBM Plex Sans", "Fira Sans", sans-serif; background: radial-gradient(circle at top, #381613 0%, #1a0f0e 60%); color: #ffe8e4; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      .card { background: rgba(42, 18, 16, 0.9); border: 1px solid rgba(255, 158, 143, 0.4); padding: 28px; border-radius: 14px; width: min(560px, 90vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }
      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }
      p { margin: 0; color: #ffc6bb; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Authorization Failed</h1>
      <p>${safe}</p>
    </section>
  </body>
</html>`;
}

function inferBaseUrl(request: {
  readonly protocol: string;
  readonly headers: Record<string, unknown>;
}): string | undefined {
  const forwardedHost = typeof request.headers["x-forwarded-host"] === "string"
    ? request.headers["x-forwarded-host"]
    : undefined;
  const host = typeof request.headers.host === "string" ? request.headers.host : forwardedHost;
  if (!host) {
    return undefined;
  }

  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"]
    : undefined;
  const protocol = forwardedProto ?? request.protocol;
  return `${protocol}://${host}`;
}

export async function registerUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<void> {
  const sessionStore = new SessionStore(resolve(process.cwd(), "data/sessions.json"));
  const sessionIndex = new ChromaSessionIndex({
    url: process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
    collectionName: process.env.CHROMA_COLLECTION ?? "open_hax_proxy_sessions",
    ollamaBaseUrl: deps.config.ollamaBaseUrl,
    embeddingModel: process.env.CHROMA_EMBED_MODEL ?? "nomic-embed-text:latest",
  });
  const credentialStore = deps.credentialStore;
  const oauthManager = new OpenAiOAuthManager({
    oauthScopes: deps.config.openaiOauthScopes,
    clientId: deps.config.openaiOauthClientId,
    issuer: deps.config.openaiOauthIssuer,
    clientSecret: deps.config.openaiOauthClientSecret,
  });
  const factoryOAuthManager = new FactoryOAuthManager();
  const ecosystemsDir = await firstExistingPath([
    resolve(process.cwd(), "../../ecosystems"),
    resolve(process.cwd(), "../ecosystems"),
    resolve(process.cwd(), "ecosystems"),
  ]);

  let initialSemanticIndexSync: Promise<void> | undefined;
  const ensureInitialSemanticIndexSync = async (): Promise<void> => {
    if (!initialSemanticIndexSync) {
      initialSemanticIndexSync = (async () => {
        try {
          const existingDocuments = await sessionStore.collectSearchDocuments();
          for (const message of existingDocuments) {
            await sessionIndex.indexMessage(message);
          }
        } catch (error) {
          app.log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "failed to warm semantic session index from stored sessions",
          );
        }
      })();
    }

    await initialSemanticIndexSync;
  };

  let mcpSeedCache: { readonly loadedAt: number; readonly seeds: Awaited<ReturnType<typeof loadMcpSeeds>> } | undefined;

  const loadCachedMcpSeeds = async () => {
    const now = Date.now();
    if (mcpSeedCache && now - mcpSeedCache.loadedAt < 30_000) {
      return mcpSeedCache.seeds;
    }

    if (!ecosystemsDir) {
      return [];
    }

    const seeds = await loadMcpSeeds(ecosystemsDir).catch(() => []);
    mcpSeedCache = {
      loadedAt: now,
      seeds,
    };
    return seeds;
  };

  app.get("/api/ui/settings", async (_request, reply) => {
    reply.send(deps.proxySettingsStore.get());
  });

  app.get("/api/ui/me", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const tenants = deps.sqlCredentialStore
      ? auth.kind === "legacy_admin"
        ? await deps.sqlCredentialStore.listTenants()
        : auth.tenantId
          ? (await deps.sqlCredentialStore.listTenants()).filter((tenant) => tenant.id === auth.tenantId)
          : []
      : [];

    reply.send({
      auth,
      activeTenantId: auth.tenantId ?? null,
      tenants,
    });
  });

  app.get("/api/ui/tenants", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(501).send({ error: "tenant_store_not_supported" });
      return;
    }

    const tenants = await deps.sqlCredentialStore.listTenants();
    const visibleTenants = auth.kind === "legacy_admin"
      ? tenants
      : auth.tenantId
        ? tenants.filter((tenant) => tenant.id === auth.tenantId)
        : [];

    reply.send({ tenants: visibleTenants });
  });

  app.get<{ Params: { readonly tenantId: string } }>("/api/ui/tenants/:tenantId/api-keys", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(501).send({ error: "tenant_store_not_supported" });
      return;
    }

    if (!authCanManageTenantKeys(auth, request.params.tenantId)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const keys = await deps.sqlCredentialStore.listTenantApiKeys(request.params.tenantId);
    reply.send({ tenantId: request.params.tenantId, keys });
  });

  app.post<{
    Params: { readonly tenantId: string };
    Body: { readonly label?: string; readonly scopes?: readonly string[] };
  }>("/api/ui/tenants/:tenantId/api-keys", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(501).send({ error: "tenant_store_not_supported" });
      return;
    }

    if (!authCanManageTenantKeys(auth, request.params.tenantId)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    if (label.length === 0) {
      reply.code(400).send({ error: "label_required" });
      return;
    }

    const scopes = Array.isArray(request.body?.scopes)
      ? request.body.scopes.filter((scope): scope is string => typeof scope === "string")
      : ["proxy:use"];

    const created = await deps.sqlCredentialStore.createTenantApiKey(
      request.params.tenantId,
      label,
      scopes,
      deps.config.proxyTokenPepper,
    );

    reply.code(201).send(created);
  });

  app.delete<{ Params: { readonly tenantId: string; readonly keyId: string } }>("/api/ui/tenants/:tenantId/api-keys/:keyId", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(501).send({ error: "tenant_store_not_supported" });
      return;
    }

    if (!authCanManageTenantKeys(auth, request.params.tenantId)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const revoked = await deps.sqlCredentialStore.revokeTenantApiKey(request.params.tenantId, request.params.keyId);
    if (!revoked) {
      reply.code(404).send({ error: "tenant_api_key_not_found" });
      return;
    }

    reply.send({ ok: true, tenantId: request.params.tenantId, keyId: request.params.keyId });
  });

  app.post<{ Body: { readonly fastMode?: unknown } }>("/api/ui/settings", async (request, reply) => {
    const nextSettings = await deps.proxySettingsStore.set({
      fastMode: parseBoolean(request.body?.fastMode),
    });

    app.log.info({ fastMode: nextSettings.fastMode }, "updated proxy UI settings");
    reply.send(nextSettings);
  });

  app.get("/api/ui/sessions", async (_request, reply) => {
    const sessions = await sessionStore.listSessions();
    reply.send({ sessions });
  });

  app.post<{ Body: { readonly title?: string } }>("/api/ui/sessions", async (request, reply) => {
    const session = await sessionStore.createSession(request.body?.title);
    reply.code(201).send({ session });
  });

  app.get<{ Params: { readonly sessionId: string } }>("/api/ui/sessions/:sessionId", async (request, reply) => {
    const session = await sessionStore.getSession(request.params.sessionId);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    reply.send({ session });
  });

  app.get<{ Params: { readonly sessionId: string } }>("/api/ui/sessions/:sessionId/cache-key", async (request, reply) => {
    const session = await sessionStore.getSession(request.params.sessionId);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    reply.send({ sessionId: session.id, promptCacheKey: session.promptCacheKey });
  });

  app.post<{
    Params: { readonly sessionId: string };
    Body: { readonly role?: ChatRole; readonly content?: string; readonly reasoningContent?: string; readonly model?: string };
  }>("/api/ui/sessions/:sessionId/messages", async (request, reply) => {
    const content = typeof request.body?.content === "string" ? request.body.content : "";
    if (content.trim().length === 0) {
      reply.code(400).send({ error: "message_content_required" });
      return;
    }

    try {
      const { session, message } = await sessionStore.appendMessage(request.params.sessionId, {
        role: toChatRole(request.body?.role),
        content,
        reasoningContent: typeof request.body?.reasoningContent === "string" ? request.body.reasoningContent : undefined,
        model: request.body?.model,
      });

      await sessionIndex.indexMessage({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      });

      reply.code(201).send({ message, sessionId: session.id });
    } catch (error) {
      reply.code(404).send({ error: "session_not_found", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Params: { readonly sessionId: string };
    Body: { readonly messageId?: string };
  }>("/api/ui/sessions/:sessionId/fork", async (request, reply) => {
    try {
      const session = await sessionStore.forkSession(request.params.sessionId, request.body?.messageId);

      for (const message of session.messages) {
        await sessionIndex.indexMessage({
          sessionId: session.id,
          sessionTitle: session.title,
          messageId: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        });
      }

      reply.code(201).send({ session });
    } catch (error) {
      reply.code(404).send({ error: "fork_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { readonly query?: string; readonly limit?: number };
  }>("/api/ui/sessions/search", async (request, reply) => {
    await ensureInitialSemanticIndexSync();

    const query = typeof request.body?.query === "string" ? request.body.query.trim() : "";
    if (query.length === 0) {
      reply.send({ source: "none", results: [] });
      return;
    }

    const limit = toSafeLimit(request.body?.limit, 8, 50);
    const semantic = await sessionIndex.search(query, limit);
    if (semantic.length > 0) {
      reply.send({ source: "chroma", results: semantic });
      return;
    }

    const fallback = await sessionStore.searchLexical(query, limit);
    reply.send({
      source: "fallback",
      results: fallback.map((result) => ({
        ...result,
        distance: 0,
      })),
    });
  });

  app.get<{ Querystring: { readonly reveal?: string } }>("/api/ui/credentials", async (request, reply) => {
    const reveal = parseBoolean(request.query.reveal);
    const providers = await credentialStore.listProviders(reveal);
    const requestLogSummary = deps.requestLogStore.providerSummary();
    const keyPoolStatuses = await deps.keyPool.getAllStatuses().catch(() => ({}));

    reply.send({
      providers,
      keyPoolStatuses,
      requestLogSummary,
    });
  });

  app.get<{ Querystring: { readonly sort?: string; readonly window?: string } }>("/api/ui/dashboard/overview", async (request, reply) => {
    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const window = toUsageWindow(request.query.window);
    const overview = await buildUsageOverview(deps.requestLogStore, deps.keyPool, credentialStore, sort, window);
    reply.send(overview);
  });

  app.get<{ Querystring: { readonly sort?: string; readonly window?: string } }>("/api/ui/analytics/provider-model", async (request, reply) => {
    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const window = toUsageWindow(request.query.window);
    const analytics = await buildProviderModelAnalytics(deps.requestLogStore, window, sort);
    reply.send(analytics);
  });

  app.get<{
    Querystring: { readonly accountId?: string };
  }>("/api/ui/credentials/openai/quota", async (request, reply) => {
    const overview = await fetchOpenAiQuotaSnapshots(credentialStore as CredentialStore, {
      providerId: deps.config.openaiProviderId,
      accountId: typeof request.query.accountId === "string" && request.query.accountId.trim().length > 0
        ? request.query.accountId.trim()
        : undefined,
      logger: app.log,
    });

    reply.send(overview);
  });

  app.post<{
    Body: { readonly accountId?: string };
  }>("/api/ui/credentials/openai/oauth/refresh", async (request, reply) => {
    if (!deps.refreshOpenAiOauthAccounts) {
      reply.code(501).send({ error: "oauth_refresh_not_supported" });
      return;
    }

    const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
      ? request.body.accountId.trim()
      : undefined;

    const result = await deps.refreshOpenAiOauthAccounts(accountId);
    reply.send(result);
  });

  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string; readonly credentialValue?: string; readonly apiKey?: string };
  }>("/api/ui/credentials/api-key", async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string"
      ? request.body.providerId
      : deps.config.upstreamProviderId;
    const credentialValueRaw = typeof request.body?.credentialValue === "string"
      ? request.body.credentialValue
      : request.body?.apiKey;
    const apiKey = typeof credentialValueRaw === "string" ? credentialValueRaw.trim() : "";
    if (apiKey.length === 0) {
      reply.code(400).send({ error: "api_key_required" });
      return;
    }

    const accountId =
      typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
        ? request.body.accountId.trim()
        : `${providerId}-${Date.now()}`;

    await credentialStore.upsertApiKeyAccount(providerId, accountId, apiKey);
    await deps.keyPool.warmup().catch(() => undefined);
    reply.code(201).send({ ok: true, providerId, accountId });
  });

  app.delete<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>("/api/ui/credentials/account", async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";

    if (providerId.length === 0 || accountId.length === 0) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    if (!credentialStore.removeAccount) {
      reply.code(501).send({ error: "remove_account_not_supported" });
      return;
    }

    const removed = await credentialStore.removeAccount(providerId, accountId);
    if (!removed) {
      reply.code(404).send({ error: "account_not_found" });
      return;
    }

    await deps.keyPool.warmup().catch(() => undefined);
    app.log.info({ providerId, accountId }, "removed credential account");
    reply.send({ ok: true, providerId, accountId });
  });

  app.post<{
    Body: { readonly redirectBaseUrl?: string };
  }>("/api/ui/credentials/openai/oauth/browser/start", async (request, reply) => {
    const requestBaseUrl = inferBaseUrl(request);
    const redirectBaseUrl =
      typeof request.body?.redirectBaseUrl === "string" && request.body.redirectBaseUrl.trim().length > 0
        ? request.body.redirectBaseUrl.trim()
        : requestBaseUrl;

    if (!redirectBaseUrl) {
      reply.code(400).send({ error: "redirect_base_url_required" });
      return;
    }

    const payload = await oauthManager.startBrowserFlow(redirectBaseUrl);
    reply.send(payload);
  });

  const handleOpenAiBrowserCallback = async (
    request: { readonly query: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string } },
    reply: { header: (name: string, value: string) => void; send: (value: unknown) => void },
  ) => {
    const error = request.query.error;
    if (typeof error === "string" && error.length > 0) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(request.query.error_description ?? error));
      return;
    }

    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";

    if (state.length === 0 || code.length === 0) {
      reply.header("content-type", "text/html");
      reply.send(htmlError("Missing OAuth callback state or code."));
      return;
    }

    try {
      const tokens = await oauthManager.completeBrowserFlow(state, code);
      await credentialStore.upsertOAuthAccount(
        deps.config.openaiProviderId,
        tokens.accountId,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        tokens.chatgptAccountId,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: deps.config.openaiProviderId,
        accountId: tokens.accountId,
        chatgptAccountId: tokens.chatgptAccountId,
      }, "saved OpenAI OAuth account from browser flow");

      reply.header("content-type", "text/html");
      reply.send(htmlSuccess(`Saved OpenAI OAuth account ${tokens.chatgptAccountId ?? tokens.accountId}.`));
    } catch (oauthError) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(oauthError instanceof Error ? oauthError.message : String(oauthError)));
    }
  };

  app.get<{
    Querystring: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string };
  }>("/api/ui/credentials/openai/oauth/browser/callback", handleOpenAiBrowserCallback);

  app.get<{
    Querystring: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string };
  }>("/auth/callback", handleOpenAiBrowserCallback);

  app.post("/api/ui/credentials/openai/oauth/device/start", async (_request, reply) => {
    try {
      const payload = await oauthManager.startDeviceFlow();
      reply.send(payload);
    } catch (error) {
      reply.code(502).send({ error: "device_flow_start_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { readonly deviceAuthId?: string; readonly userCode?: string };
  }>("/api/ui/credentials/openai/oauth/device/poll", async (request, reply) => {
    const deviceAuthId = typeof request.body?.deviceAuthId === "string" ? request.body.deviceAuthId : "";
    const userCode = typeof request.body?.userCode === "string" ? request.body.userCode : "";

    if (deviceAuthId.length === 0 || userCode.length === 0) {
      reply.code(400).send({ error: "device_auth_id_and_user_code_required" });
      return;
    }

    const result = await oauthManager.pollDeviceFlow(deviceAuthId, userCode);
    if (result.state === "authorized") {
      await credentialStore.upsertOAuthAccount(
        deps.config.openaiProviderId,
        result.tokens.accountId,
        result.tokens.accessToken,
        result.tokens.refreshToken,
        result.tokens.expiresAt,
        result.tokens.chatgptAccountId,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: deps.config.openaiProviderId,
        accountId: result.tokens.accountId,
        chatgptAccountId: result.tokens.chatgptAccountId,
      }, "saved OpenAI OAuth account from device flow");
    }

    reply.send(result);
  });

  // ─── Factory.ai OAuth Routes ────────────────────────────────────────────

  app.post("/api/ui/credentials/factory/oauth/device/start", async (_request, reply) => {
    try {
      const payload = await factoryOAuthManager.startDeviceFlow();
      reply.send(payload);
    } catch (error) {
      reply.code(502).send({ error: "device_flow_start_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { readonly deviceAuthId?: string };
  }>("/api/ui/credentials/factory/oauth/device/poll", async (request, reply) => {
    const deviceAuthId = typeof request.body?.deviceAuthId === "string" ? request.body.deviceAuthId : "";

    if (deviceAuthId.length === 0) {
      reply.code(400).send({ error: "device_auth_id_required" });
      return;
    }

    const result = await factoryOAuthManager.pollDeviceFlow(deviceAuthId);
    if (result.state === "authorized") {
      await credentialStore.upsertOAuthAccount(
        "factory",
        result.tokens.accountId,
        result.tokens.accessToken,
        result.tokens.refreshToken,
        result.tokens.expiresAt,
        undefined,
        result.tokens.email,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: "factory",
        accountId: result.tokens.accountId,
        email: result.tokens.email,
      }, "saved Factory OAuth account from device flow");
    }

    reply.send(result);
  });

  app.post<{
    Body: { readonly redirectBaseUrl?: string };
  }>("/api/ui/credentials/factory/oauth/browser/start", async (request, reply) => {
    const requestBaseUrl = inferBaseUrl(request);
    const redirectBaseUrl =
      typeof request.body?.redirectBaseUrl === "string" && request.body.redirectBaseUrl.trim().length > 0
        ? request.body.redirectBaseUrl.trim()
        : requestBaseUrl;

    if (!redirectBaseUrl) {
      reply.code(400).send({ error: "redirect_base_url_required" });
      return;
    }

    const redirectUri = new URL("/auth/factory/callback", redirectBaseUrl).toString();
    const payload = factoryOAuthManager.startBrowserFlow(redirectUri);
    reply.send(payload);
  });

  app.get<{
    Querystring: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string };
  }>("/auth/factory/callback", async (request, reply) => {
    const error = request.query.error;
    if (typeof error === "string" && error.length > 0) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(request.query.error_description ?? error));
      return;
    }

    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";

    if (state.length === 0 || code.length === 0) {
      reply.header("content-type", "text/html");
      reply.send(htmlError("Missing OAuth callback state or code."));
      return;
    }

    try {
      const tokens = await factoryOAuthManager.completeBrowserFlow(state, code);
      await credentialStore.upsertOAuthAccount(
        "factory",
        tokens.accountId,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        undefined,
        tokens.email,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: "factory",
        accountId: tokens.accountId,
        email: tokens.email,
      }, "saved Factory OAuth account from browser flow");

      reply.header("content-type", "text/html");
      reply.send(htmlSuccess(`Saved Factory.ai OAuth account${tokens.email ? ` (${tokens.email})` : ""}.`));
    } catch (oauthError) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(oauthError instanceof Error ? oauthError.message : String(oauthError)));
    }
  });

  app.get<{
    Querystring: { readonly providerId?: string; readonly accountId?: string; readonly limit?: string; readonly before?: string };
  }>("/api/ui/request-logs", async (request, reply) => {
    const entries = deps.requestLogStore.list({
      providerId: request.query.providerId,
      accountId: request.query.accountId,
      limit: toSafeLimit(request.query.limit, 200, 2000),
      before: typeof request.query.before === "string" && request.query.before.length > 0
        ? request.query.before
        : undefined,
    });

    reply.send({ entries });
  });

  app.get<{
    Querystring: { readonly model?: string };
  }>("/api/ui/tools", async (request, reply) => {
    const model = typeof request.query.model === "string" && request.query.model.trim().length > 0
      ? request.query.model.trim()
      : "gpt-5.3-codex";

    reply.send({
      model,
      tools: getToolSeedForModel(model),
    });
  });

  app.get("/api/ui/mcp-servers", async (_request, reply) => {
    const seeds = await loadCachedMcpSeeds();
    reply.send({
      count: seeds.length,
      servers: seeds,
    });
  });

  app.get<{ Params: { readonly assetPath: string } }>("/assets/:assetPath", async (request, reply) => {
    const filePath = await resolveUiAssetPath(`assets/${request.params.assetPath}`);
    if (!filePath) {
      reply.code(404).send({ error: "asset_not_found" });
      return;
    }

    const ext = filePath.split(".").pop()?.toLowerCase();
    if (ext === "js") {
      reply.type("application/javascript; charset=utf-8");
    } else if (ext === "css") {
      reply.type("text/css; charset=utf-8");
    }

    reply.send(await readFile(filePath));
  });

  const sendUiIndex = async (reply: { type: (value: string) => void; send: (value: unknown) => void }) => {
    const html = await loadUiIndexHtml();
    if (!html) {
      reply.send({ ok: true, name: "open-hax-openai-proxy", version: "0.1.0" });
      return;
    }

    reply.type("text/html; charset=utf-8");
    reply.send(html);
  };

  for (const path of ["/", "/chat", "/images", "/credentials", "/tools"] as const) {
    app.get(path, async (_request, reply) => {
      await sendUiIndex(reply);
    });
  }

  // Event store query API
  app.get<{
    Querystring: {
      kind?: string;
      entry_id?: string;
      provider_id?: string;
      model?: string;
      status?: string;
      status_gte?: string;
      status_lt?: string;
      tag?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/ui/events", async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available (no database connection)" });
      return;
    }

    const q = request.query;
    const events = await deps.eventStore.query({
      kind: q.kind as "request" | "response" | "error" | "label" | "metric" | undefined,
      entryId: q.entry_id,
      providerId: q.provider_id,
      model: q.model,
      status: q.status ? parseInt(q.status, 10) : undefined,
      statusGte: q.status_gte ? parseInt(q.status_gte, 10) : undefined,
      statusLt: q.status_lt ? parseInt(q.status_lt, 10) : undefined,
      tag: q.tag,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : 50,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });

    reply.send({ events, count: events.length });
  });

  app.get("/api/ui/events/tags", async (_request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days
    const tags = await deps.eventStore.countByTag(since);
    reply.send({ tags, since: since.toISOString() });
  });

  app.post<{
    Params: { id: string };
    Body: { tag: string };
  }>("/api/ui/events/:id/tag", async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const tag = typeof request.body === "object" && request.body !== null && "tag" in request.body
      ? String((request.body as Record<string, unknown>).tag)
      : undefined;
    if (!tag) {
      reply.code(400).send({ error: "Missing tag field" });
      return;
    }

    await deps.eventStore.addTag(request.params.id, tag);
    reply.send({ ok: true });
  });

  app.delete<{
    Params: { id: string };
    Body: { tag: string };
  }>("/api/ui/events/:id/tag", async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const tag = typeof request.body === "object" && request.body !== null && "tag" in request.body
      ? String((request.body as Record<string, unknown>).tag)
      : undefined;
    if (!tag) {
      reply.code(400).send({ error: "Missing tag field" });
      return;
    }

    await deps.eventStore.removeTag(request.params.id, tag);
    reply.send({ ok: true });
  });
}
