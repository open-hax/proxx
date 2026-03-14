import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";

import type { ProxyConfig } from "./config.js";
import type { CredentialStoreLike } from "./credential-store.js";
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
  readonly status: "healthy" | "cooldown" | "idle";
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
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
  const accountStats = new Map<string, UsageAccountSummary>();
  let fastModeTierRequests = 0;
  let priorityTierRequests = 0;
  let standardTierRequests = 0;

  for (const entry of recentLogs) {
    modelTotals.set(entry.model, (modelTotals.get(entry.model) ?? 0) + usageCount(entry.totalTokens));
    providerTotals.set(entry.providerId, (providerTotals.get(entry.providerId) ?? 0) + usageCount(entry.totalTokens));

    if (entry.serviceTierSource === "fast_mode") {
      fastModeTierRequests += 1;
    } else if (entry.serviceTier === "priority") {
      priorityTierRequests += 1;
    } else {
      standardTierRequests += 1;
    }

    const mapKey = `${entry.providerId}\0${entry.accountId}`;
    const current = accountStats.get(mapKey);
    const displayName = `${entry.providerId}/${entry.accountId}`;
    const next: UsageAccountSummary = {
      accountId: entry.accountId,
      displayName,
      providerId: entry.providerId,
      authType: entry.authType,
      status: current?.status ?? "healthy",
      requestCount: (current?.requestCount ?? 0) + 1,
      totalTokens: (current?.totalTokens ?? 0) + usageCount(entry.totalTokens),
      promptTokens: (current?.promptTokens ?? 0) + usageCount(entry.promptTokens),
      completionTokens: (current?.completionTokens ?? 0) + usageCount(entry.completionTokens),
      lastUsedAt: isoFromTimestamp(Math.max(entry.timestamp, current?.lastUsedAt ? Date.parse(current.lastUsedAt) : 0)),
    };
    accountStats.set(mapKey, next);
  }

  for (const [providerId, provider] of providerById.entries()) {
    const keyPoolStatus = allStatuses[providerId];
    const accountStatusById = new Map((allAccountStatuses[providerId] ?? []).map((entry) => [entry.accountId, entry]));

    for (const account of provider.accounts) {
      const mapKey = `${providerId}\0${account.id}`;
      const current = accountStats.get(mapKey);
      const accountStatus = accountStatusById.get(account.id);
      const status = accountStatus && !accountStatus.available
        ? "cooldown"
        : current || keyPoolStatus
          ? "healthy"
          : "idle";
      accountStats.set(mapKey, {
        accountId: account.id,
        displayName: `${providerId}/${account.id}`,
        providerId,
        authType: account.authType,
        status,
        requestCount: current?.requestCount ?? 0,
        totalTokens: current?.totalTokens ?? 0,
        promptTokens: current?.promptTokens ?? 0,
        completionTokens: current?.completionTokens ?? 0,
        lastUsedAt: current?.lastUsedAt ?? null,
      });
    }
  }

  const bucketMs = 60 * 60 * 1000;
  const bucketCount = 24;
  const requestBuckets = new Map<number, number>();
  const tokenBuckets = new Map<number, number>();
  const errorBuckets = new Map<number, number>();

  for (const entry of recentLogs) {
    const bucket = bucketStart(entry.timestamp, bucketMs);
    requestBuckets.set(bucket, (requestBuckets.get(bucket) ?? 0) + 1);
    tokenBuckets.set(bucket, (tokenBuckets.get(bucket) ?? 0) + usageCount(entry.totalTokens));
    if (entry.status >= 400 || typeof entry.error === "string") {
      errorBuckets.set(bucket, (errorBuckets.get(bucket) ?? 0) + 1);
    }
  }

  const bucketSeries = Array.from({ length: bucketCount }, (_, index) => {
    const timestamp = bucketStart(now - (bucketCount - index - 1) * bucketMs, bucketMs);
    return {
      t: new Date(timestamp).toISOString(),
      requests: requestBuckets.get(timestamp) ?? 0,
      tokens: tokenBuckets.get(timestamp) ?? 0,
      errors: errorBuckets.get(timestamp) ?? 0,
    };
  });

  const totalRequests = recentLogs.length;
  const totalTokens = recentLogs.reduce((sum, entry) => sum + usageCount(entry.totalTokens), 0);
  const promptTokens = recentLogs.reduce((sum, entry) => sum + usageCount(entry.promptTokens), 0);
  const completionTokens = recentLogs.reduce((sum, entry) => sum + usageCount(entry.completionTokens), 0);
  const totalErrors = recentLogs.filter((entry) => entry.status >= 400 || typeof entry.error === "string").length;
  const topModel = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topProvider = [...providerTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const activeAccounts = [...accountStats.values()].filter((account) => account.requestCount > 0).length;

  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      requests24h: totalRequests,
      tokens24h: totalTokens,
      promptTokens24h: promptTokens,
      completionTokens24h: completionTokens,
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
      if (b.totalTokens !== a.totalTokens) {
        return b.totalTokens - a.totalTokens;
      }
      if (b.requestCount !== a.requestCount) {
        return b.requestCount - a.requestCount;
      }
      return a.displayName.localeCompare(b.displayName);
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

  app.get("/api/ui/dashboard/overview", async (_request, reply) => {
    const overview = await buildUsageOverview(deps.requestLogStore, deps.keyPool, credentialStore);
    reply.send(overview);
  });

  app.get<{
    Querystring: { readonly accountId?: string };
  }>("/api/ui/credentials/openai/quota", async (request, reply) => {
    const overview = await fetchOpenAiQuotaSnapshots(credentialStore, {
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
        tokens.email,
        tokens.subject,
        tokens.planType,
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
        result.tokens.email,
        result.tokens.subject,
        result.tokens.planType,
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

  for (const path of ["/", "/chat", "/credentials", "/tools"] as const) {
    app.get(path, async (_request, reply) => {
      await sendUiIndex(reply);
    });
  }
}
