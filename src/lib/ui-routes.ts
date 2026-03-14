import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";

import type { ProxyConfig } from "./config.js";
import { CredentialStore, type CredentialStoreLike } from "./credential-store.js";
import type { KeyPool, KeyPoolAccountStatus } from "./key-pool.js";
import { OpenAiOAuthManager } from "./openai-oauth.js";
import { FactoryOAuthManager } from "./factory-oauth.js";
import { fetchOpenAiQuotaSnapshots } from "./openai-quota.js";
import { RequestLogStore } from "./request-log-store.js";
import { ChromaSessionIndex } from "./chroma-session-index.js";
import { SessionStore, type ChatRole } from "./session-store.js";
import { getToolSeedForModel, loadMcpSeeds } from "./tool-mcp-seed.js";
import type { ProxySettingsStore } from "./proxy-settings-store.js";

interface UiRouteDependencies {
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly requestLogStore: RequestLogStore;
  readonly credentialStore: CredentialStoreLike;
  readonly proxySettingsStore: ProxySettingsStore;
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

interface UsageOverviewResponse {
  readonly generatedAt: string;
  readonly summary: {
    readonly requests24h: number;
    readonly tokens24h: number;
    readonly promptTokens24h: number;
    readonly completionTokens24h: number;
    readonly cachedPromptTokens24h: number;
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
): Promise<UsageOverviewResponse> {
  const allLogs = requestLogStore.snapshot();
  const allStatuses: Record<string, Awaited<ReturnType<KeyPool["getStatus"]>>> = await keyPool.getAllStatuses().catch(() => ({}));
  const allAccountStatuses: Record<string, readonly KeyPoolAccountStatus[]> = await keyPool.getAllAccountStatuses().catch(() => ({}));
  const credentialProviders = await credentialStore.listProviders(false).catch(() => []);
  const providerById = new Map(credentialProviders.map((provider) => [provider.id, provider]));

  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recentLogs = allLogs.filter((entry) => entry.timestamp >= dayAgo);

  const modelTotals = new Map<string, number>();
  const providerTotals = new Map<string, number>();

  const recentBuckets = requestLogStore.snapshotHourlyBuckets(dayAgo);
  const bucketByStart = new Map(recentBuckets.map((bucket) => [bucket.startMs, bucket]));

  const totalRequests = recentBuckets.reduce((sum, bucket) => sum + bucket.requestCount, 0);
  const totalTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  const promptTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.promptTokens, 0);
  const completionTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.completionTokens, 0);
  const cachedPromptTokens = recentBuckets.reduce((sum, bucket) => sum + bucket.cachedPromptTokens, 0);
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

  for (const entry of recentLogs) {
    modelTotals.set(entry.model, (modelTotals.get(entry.model) ?? 0) + usageCount(entry.totalTokens));
    providerTotals.set(entry.providerId, (providerTotals.get(entry.providerId) ?? 0) + usageCount(entry.totalTokens));

    const mapKey = `${entry.providerId}\0${entry.accountId}`;
    const current = accountAgg.get(mapKey) ?? {
      accountId: entry.accountId,
      providerId: entry.providerId,
      authType: entry.authType,
      requestCount: 0,
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
      lastUsedAtMs: 0,
    };

    current.requestCount += 1;
    current.totalTokens += usageCount(entry.totalTokens);
    current.promptTokens += usageCount(entry.promptTokens);
    current.completionTokens += usageCount(entry.completionTokens);
    current.cachedPromptTokens += usageCount(entry.cachedPromptTokens);

    if (entry.promptCacheKeyUsed) {
      current.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit) {
      current.cacheHitCount += 1;
    }

    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
      current.ttftSum += entry.ttftMs;
      current.ttftCount += 1;
    }

    if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
      current.tpsSum += entry.tps;
      current.tpsCount += 1;
    }

    current.lastUsedAtMs = Math.max(current.lastUsedAtMs, entry.timestamp);
    accountAgg.set(mapKey, current);

    if (entry.timestamp >= now - shortWindowMs) {
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

  const bucketMs = 60 * 60 * 1000;
  const bucketCount = 24;
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

  const cacheHitRate24h = cacheKeyUses > 0 ? percentage(cacheHits, cacheKeyUses) : 0;

  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      requests24h: totalRequests,
      tokens24h: totalTokens,
      promptTokens24h: promptTokens,
      completionTokens24h: completionTokens,
      cachedPromptTokens24h: cachedPromptTokens,
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
  const oauthManager = new OpenAiOAuthManager();
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

  app.get<{ Querystring: { readonly sort?: string } }>("/api/ui/dashboard/overview", async (request, reply) => {
    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const overview = await buildUsageOverview(deps.requestLogStore, deps.keyPool, credentialStore, sort);
    reply.send(overview);
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
    Querystring: { readonly providerId?: string; readonly accountId?: string; readonly limit?: string };
  }>("/api/ui/request-logs", async (request, reply) => {
    const entries = deps.requestLogStore.list({
      providerId: request.query.providerId,
      accountId: request.query.accountId,
      limit: toSafeLimit(request.query.limit, 200, 2000),
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
}
