import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../../../../routes/types.js";
import type { CredentialStoreLike } from "../../../../lib/credential-store.js";
import type { KeyPool, KeyPoolAccountStatus } from "../../../../lib/key-pool.js";
import { kernels } from "../../../../lib/cljs-kernels.js";
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
  return kernels.usageToWindow(value) as UsageWindow;
}

export function toSafeLimit(value: unknown, fallback: number, max: number): number {
  return kernels.usageToSafeLimit(value, fallback, max);
}

// Every number below is a pure fold in proxx.analytics.usage; this module
// fetches the facts (log entries, rollups, credential and key-pool state),
// picks the source, and hands them over.

function hasUsageScope(scope: UsageScope | undefined): boolean {
  return kernels.usageScopeActive(scope);
}

function resolveUsageWindowConfig(window: UsageWindow, now: number): {
  readonly bucketMs: number;
  readonly bucketCount: number;
  readonly bucketWindowStart: number;
  readonly entryWindowStart: number;
} {
  return kernels.usageWindowConfig(window, now);
}

function entriesInScope(entries: readonly RequestLogEntry[], scope: UsageScope | undefined): RequestLogEntry[] {
  return kernels.usageFilterEntries(entries as RequestLogEntry[], scope);
}

function earliestTimestamp(entries: readonly RequestLogEntry[]): number | null {
  return entries.reduce<number | null>((current, entry) => current === null ? entry.timestamp : Math.min(current, entry.timestamp), null);
}

function providerFacts(providers: Awaited<ReturnType<CredentialStoreLike["listProviders"]>>): unknown {
  return providers.map((provider) => ({
    id: provider.id,
    accounts: provider.accounts.map((account) => ({ id: account.id, authType: account.authType, planType: account.planType })),
  }));
}

function statusFacts(statuses: Record<string, readonly KeyPoolAccountStatus[]>): unknown {
  return Object.fromEntries(
    Object.entries(statuses).map(([providerId, list]) => [providerId, list.map((status) => ({ accountId: status.accountId, available: status.available }))]),
  );
}

type EntryCoverage = {
  readonly coverageStartMs: number | null;
  readonly retainedEntryCount: number;
  readonly maxRetainedEntries: number;
};

async function buildUsageOverviewFromEntries(
  entries: readonly RequestLogEntry[],
  keyPool: KeyPool,
  credentialStore: CredentialStoreLike,
  sort: string | undefined,
  window: UsageWindow,
  now: number,
  coverage: EntryCoverage,
): Promise<UsageOverviewResponse> {
  const statuses: Record<string, readonly KeyPoolAccountStatus[]> = await keyPool.getAllAccountStatuses().catch(() => ({}));
  const providers = await credentialStore.listProviders(false).catch(() => []);
  return kernels.usageOverviewFromEntries(entries as RequestLogEntry[], {
    window,
    now,
    sort,
    providers: providerFacts(providers),
    statuses: statusFacts(statuses),
    coverage,
  }) as UsageOverviewResponse;
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
    const allLogs = entriesInScope(requestLogStore.snapshot(), scope);
    return buildUsageOverviewFromEntries(allLogs, keyPool, credentialStore, sort, window, now, {
      coverageStartMs: earliestTimestamp(allLogs),
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
      coverageStartMs: earliestTimestamp(allLogs),
      retainedEntryCount: allLogs.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  await keyPool.getAllStatuses().catch(() => ({}));
  const statuses: Record<string, readonly KeyPoolAccountStatus[]> = await keyPool.getAllAccountStatuses().catch(() => ({}));
  const providers = await credentialStore.listProviders(false).catch(() => []);
  const { bucketWindowStart } = resolveUsageWindowConfig(window, now);

  return kernels.usageOverviewFromRollups({
    window,
    now,
    sort,
    providers: providerFacts(providers),
    statuses: statusFacts(statuses),
    entries: allLogs,
    buckets: window === "daily"
      ? requestLogStore.snapshotHourlyBuckets(bucketWindowStart)
      : requestLogStore.snapshotDailyBuckets(bucketWindowStart),
    modelBuckets: requestLogStore.snapshotDailyModelBuckets(bucketWindowStart),
    accountBuckets: window === "daily" ? [] : requestLogStore.snapshotDailyAccountBuckets(bucketWindowStart),
    coverage: requestLogStore.getCoverage(),
  }) as UsageOverviewResponse;
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
  const fromEntries = (entries: readonly RequestLogEntry[], coverage: EntryCoverage): ProviderModelAnalyticsResponse =>
    kernels.usageAnalyticsFromEntries(entries as RequestLogEntry[], { window, sort, now, coverage }) as ProviderModelAnalyticsResponse;

  if (sqlRequestUsageStore) {
    const [entries, coverage] = await Promise.all([
      sqlRequestUsageStore.listEntriesSince(entryWindowStart, scope),
      sqlRequestUsageStore.getCoverage(scope),
    ]);
    return fromEntries(entries, {
      coverageStartMs: coverage.earliestEntryAtMs,
      retainedEntryCount: coverage.retainedEntryCount,
      maxRetainedEntries: coverage.maxRetainedEntries,
    });
  }

  if (hasUsageScope(scope)) {
    const relevantEntries = entriesInScope(requestLogStore.snapshot(), scope);
    return fromEntries(relevantEntries, {
      coverageStartMs: earliestTimestamp(relevantEntries),
      retainedEntryCount: relevantEntries.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  const allLogs = requestLogStore.snapshot();
  if (allLogs.length > 0) {
    return fromEntries(allLogs, {
      coverageStartMs: earliestTimestamp(allLogs),
      retainedEntryCount: allLogs.length,
      maxRetainedEntries: requestLogStore.getCoverage().maxEntries,
    });
  }

  return kernels.usageAnalyticsFromRollups({
    window,
    sort,
    now,
    entries: requestLogStore.snapshot(),
    modelBuckets: requestLogStore.snapshotDailyModelBuckets(bucketWindowStart),
    coverage: requestLogStore.getCoverage(),
  }) as ProviderModelAnalyticsResponse;
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
