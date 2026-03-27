import type { FastifyInstance } from "fastify";

import type { RequestLogEntry } from "../../lib/request-log-store.js";
import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

interface PromptCacheAuditRow {
  readonly promptCacheKeyHash: string;
  readonly providerId: string;
  readonly requestCount: number;
  readonly accountCount: number;
  readonly accountIds: readonly string[];
  readonly cacheHitCount: number;
  readonly cachedPromptTokens: number;
  readonly promptTokens: number;
  readonly latestModel?: string;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
}

interface PromptCacheAuditOverview {
  readonly generatedAt: string;
  readonly scannedEntryCount: number;
  readonly distinctHashCount: number;
  readonly crossAccountHashCount: number;
  readonly rows: readonly PromptCacheAuditRow[];
}

type MutablePromptCacheAuditAccumulator = {
  promptCacheKeyHash: string;
  providerId: string;
  requestCount: number;
  accountIds: Set<string>;
  cacheHitCount: number;
  cachedPromptTokens: number;
  promptTokens: number;
  latestModel?: string;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
};

const DEFAULT_ROW_LIMIT = 40;
const MAX_ROW_LIMIT = 200;
const DEFAULT_SCAN_LIMIT = 5000;
const MAX_SCAN_LIMIT = 20000;

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

function toIso(value: number | null): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

async function loadRecentOpenAiPromptCacheEntries(
  deps: UiRouteDependencies,
  scanLimit: number,
): Promise<RequestLogEntry[]> {
  if (deps.sqlRequestUsageStore) {
    const entries = await deps.sqlRequestUsageStore.listEntries({
      providerId: deps.config.openaiProviderId,
      limit: scanLimit,
    });

    return entries.filter((entry) => entry.authType === "oauth_bearer");
  }

  return deps.requestLogStore.list({
    providerId: deps.config.openaiProviderId,
    limit: scanLimit,
  }).filter((entry) => entry.authType === "oauth_bearer");
}

function buildPromptCacheAudit(entries: readonly RequestLogEntry[], rowLimit: number): PromptCacheAuditOverview {
  const grouped = new Map<string, MutablePromptCacheAuditAccumulator>();

  for (const entry of entries) {
    if (entry.providerId !== "openai") {
      continue;
    }

    const promptCacheKeyHash = entry.promptCacheKeyHash?.trim();
    if (!promptCacheKeyHash) {
      continue;
    }

    const current = grouped.get(promptCacheKeyHash) ?? {
      promptCacheKeyHash,
      providerId: entry.providerId,
      requestCount: 0,
      accountIds: new Set<string>(),
      cacheHitCount: 0,
      cachedPromptTokens: 0,
      promptTokens: 0,
      latestModel: undefined,
      firstSeenAtMs: null,
      lastSeenAtMs: null,
    };

    current.requestCount += 1;
    current.accountIds.add(entry.accountId);
    current.cacheHitCount += entry.cacheHit === true ? 1 : 0;
    current.cachedPromptTokens += typeof entry.cachedPromptTokens === "number" && Number.isFinite(entry.cachedPromptTokens)
      ? entry.cachedPromptTokens
      : 0;
    current.promptTokens += typeof entry.promptTokens === "number" && Number.isFinite(entry.promptTokens)
      ? entry.promptTokens
      : 0;
    current.latestModel = entry.model;
    current.firstSeenAtMs = current.firstSeenAtMs === null ? entry.timestamp : Math.min(current.firstSeenAtMs, entry.timestamp);
    current.lastSeenAtMs = current.lastSeenAtMs === null ? entry.timestamp : Math.max(current.lastSeenAtMs, entry.timestamp);
    grouped.set(promptCacheKeyHash, current);
  }

  const rows: PromptCacheAuditRow[] = [...grouped.values()]
    .map((group) => ({
      promptCacheKeyHash: group.promptCacheKeyHash,
      providerId: group.providerId,
      requestCount: group.requestCount,
      accountCount: group.accountIds.size,
      accountIds: [...group.accountIds].sort((left, right) => left.localeCompare(right)),
      cacheHitCount: group.cacheHitCount,
      cachedPromptTokens: group.cachedPromptTokens,
      promptTokens: group.promptTokens,
      latestModel: group.latestModel,
      firstSeenAt: toIso(group.firstSeenAtMs),
      lastSeenAt: toIso(group.lastSeenAtMs),
    }))
    .sort((left, right) => {
      if (right.accountCount !== left.accountCount) {
        return right.accountCount - left.accountCount;
      }

      const rightLastSeen = right.lastSeenAt ? Date.parse(right.lastSeenAt) : 0;
      const leftLastSeen = left.lastSeenAt ? Date.parse(left.lastSeenAt) : 0;
      if (rightLastSeen !== leftLastSeen) {
        return rightLastSeen - leftLastSeen;
      }

      return right.requestCount - left.requestCount || left.promptCacheKeyHash.localeCompare(right.promptCacheKeyHash);
    })
    .slice(0, rowLimit);

  return {
    generatedAt: new Date().toISOString(),
    scannedEntryCount: entries.length,
    distinctHashCount: grouped.size,
    crossAccountHashCount: rows.filter((row) => row.accountCount > 1).length,
    rows,
  };
}

export async function registerOpenAiPromptCacheAuditUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  _ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.get<{
    Querystring: { readonly limit?: string; readonly scanLimit?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/prompt-cache-audit", options), async (request, reply) => {
    const rowLimit = toSafeLimit(request.query.limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
    const scanLimit = toSafeLimit(request.query.scanLimit, DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
    const entries = await loadRecentOpenAiPromptCacheEntries(deps, scanLimit);
    reply.send(buildPromptCacheAudit(entries, rowLimit));
  });
}
