import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { UiRouteDependencies } from "../routes/types.js";
import type { CredentialStoreLike } from "./credential-store.js";
import { CredentialStore } from "./credential-store.js";
import {
  collectLocalHostDashboardSnapshot,
  fetchRemoteHostDashboardSnapshot,
  inferSelfHostDashboardTargetId,
  loadHostDashboardTargetsFromEnv,
  resolveHostDashboardTargetToken,
} from "./host-dashboard.js";
import { resolveRequestAuth, type ResolvedRequestAuth } from "./request-auth.js";
import type { KeyPool, KeyPoolAccountStatus } from "./key-pool.js";
import { RequestLogStore, type RequestLogEntry } from "./request-log-store.js";
import { registerCredentialUiRoutes } from "../routes/credentials/index.js";
import { registerFederationUiRoutes } from "../routes/federation/index.js";
import type { FederationAccountsResponse, FederationCredentialExport } from "../routes/federation/account-knowledge.js";
import {
  buildFederationAccountKnowledge,
  findCredentialForFederationExport,
} from "../routes/federation/account-knowledge.js";
import {
  extractPeerCredential,
  fetchFederationJson,
  projectedAccountAllowsCredentialImport,
} from "../routes/federation/remote.js";
import { createSessionUiRouteContext, registerSessionUiRoutes } from "../routes/sessions/index.js";
import type { ChatRole } from "./session-store.js";
import { registerSettingsUiRoutes } from "../routes/settings/index.js";
import {
  authCanManageFederation,
  authCanManageTenantKeys,
  authCanViewTenant,
  getResolvedAuth,
  parseBoolean,
  parseOptionalProviderIds,
  parseOptionalRequestsPerMinute,
  parseOptionalPositiveInteger,
  readCookieValue,
  toVisibleTenants,
} from "../routes/shared/ui-auth.js";
import { getToolSeedForModel, loadMcpSeeds } from "./tool-mcp-seed.js";
import type { SqlRequestUsageStore } from "./db/sql-request-usage-store.js";
import { shouldWarmImportProjectedAccount } from "./db/sql-federation-store.js";
import { normalizeTenantId, DEFAULT_TENANT_ID } from "./tenant-api-key.js";
import type { FederationBridgeRelay } from "./federation/bridge-relay.js";
import type { RequestLogWsSubscription } from "./observability/request-log-ws-hub.js";
import {
  normalizeTenantProviderKind,
  normalizeTenantProviderShareMode,
  normalizeTenantProviderTrustTier,
} from "./tenant-provider-policy.js";
import { registerUsageAnalyticsRoutes, toUsageWindow, resolveUsageScopeFromAuth, buildUsageOverview, buildProviderModelAnalytics } from "../routes/api/ui/analytics/usage.js";
import { registerHostDashboardRoutes } from "../routes/api/ui/hosts/index.js";
import { registerEventRoutes } from "../routes/api/ui/events/index.js";
import { registerMcpSeedRoutes } from "../routes/api/ui/mcp/index.js";
import { registerStaticAssetRoutes } from "../routes/api/ui/assets.js";
import { registerWebSocketRoutes } from "../routes/api/ui/ws.js";
import { htmlError, htmlSuccess, inferBaseUrl, createCredentialRouteContext, resolveOpenAiProbeEndpoint } from "../routes/credentials/context.js";
import { OpenAiOAuthManager } from "./openai-oauth.js";
import { FactoryOAuthManager } from "./factory-oauth.js";
import { fetchOpenAiQuotaSnapshots, probeOpenAiAccount } from "./openai-quota.js";



function parseRequestLogRouteKind(value: string | undefined): RequestLogWsSubscription["routeKind"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "federated" || normalized === "bridge" || normalized === "routed" || normalized === "any") {
    return normalized;
  }
  return undefined;
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

export async function registerUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<FederationBridgeRelay> {
  app.addHook("onRequest", async (request, reply) => {
    const rawPath = request.raw.url?.split("?")[0] ?? request.url.split("?")[0];
    if (rawPath.startsWith("/api/ui/")) {
      reply.header("Deprecation", "true");
      reply.header("Link", `</api/v1${rawPath.slice("/api/ui".length)}>; rel="successor-version"`);
    }
  });

  const sessionContext = createSessionUiRouteContext({
    ollamaBaseUrl: deps.config.ollamaBaseUrl,
    warn: (error) => {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "failed to warm semantic session index from stored sessions",
      );
    },
  });

  const { sessionStore, sessionIndex, ensureInitialSemanticIndexSync } = sessionContext;

  function toChatRole(value: unknown): ChatRole {
    if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
      return value;
    }
    return "user";
  }

  function authCanAccessHostDashboard(auth: ReturnType<typeof getResolvedAuth> | undefined): boolean {
    if (!auth) {
      return false;
    }
    if (auth.kind === "legacy_admin") {
      return true;
    }
    if (auth.kind === "ui_session") {
      return auth.role === "owner" || auth.role === "admin";
    }
    return false;
  }

  function sanitizeFederationUsageEntry(candidate: unknown): RequestLogEntry | undefined {
    if (typeof candidate !== "object" || candidate === null) {
      return undefined;
    }
    const row = candidate as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const providerId = typeof row.providerId === "string" ? row.providerId.trim() : "";
    const accountId = typeof row.accountId === "string" ? row.accountId.trim() : "";
    const authType = row.authType;
    const model = typeof row.model === "string" ? row.model.trim() : "";
    const upstreamMode = typeof row.upstreamMode === "string" ? row.upstreamMode.trim() : "";
    const upstreamPath = typeof row.upstreamPath === "string" ? row.upstreamPath.trim() : "";
    const timestamp = typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : undefined;
    const status = typeof row.status === "number" && Number.isFinite(row.status) ? row.status : undefined;
    const latencyMs = typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs) ? row.latencyMs : undefined;
    const serviceTierSource = row.serviceTierSource;
    if (!id || !providerId || !accountId || !model || !upstreamMode || !upstreamPath || timestamp === undefined || status === undefined || latencyMs === undefined) {
      return undefined;
    }
    const normalizedAuthType: RequestLogEntry["authType"] =
      authType === "api_key" || authType === "oauth_bearer" || authType === "local" || authType === "none"
        ? authType
        : "none";
    const normalizedRouteKind: RequestLogEntry["routeKind"] =
      row.routeKind === "local" || row.routeKind === "federated" || row.routeKind === "bridge"
        ? row.routeKind
        : "local";
    const normalizedServiceTierSource: RequestLogEntry["serviceTierSource"] =
      serviceTierSource === "fast_mode" || serviceTierSource === "explicit" || serviceTierSource === "none"
        ? serviceTierSource
        : "none";
    return {
      id,
      timestamp,
      tenantId: typeof row.tenantId === "string" ? row.tenantId : undefined,
      issuer: typeof row.issuer === "string" ? row.issuer : undefined,
      keyId: typeof row.keyId === "string" ? row.keyId : undefined,
      routeKind: normalizedRouteKind,
      federationOwnerSubject: typeof row.federationOwnerSubject === "string" ? row.federationOwnerSubject : undefined,
      routedPeerId: typeof row.routedPeerId === "string" ? row.routedPeerId : undefined,
      routedPeerLabel: typeof row.routedPeerLabel === "string" ? row.routedPeerLabel : undefined,
      providerId,
      accountId,
      authType: normalizedAuthType,
      model,
      upstreamMode,
      upstreamPath,
      status,
      latencyMs,
      serviceTier: typeof row.serviceTier === "string" ? row.serviceTier : undefined,
      serviceTierSource: normalizedServiceTierSource,
      promptTokens: typeof row.promptTokens === "number" && Number.isFinite(row.promptTokens) ? row.promptTokens : undefined,
      completionTokens: typeof row.completionTokens === "number" && Number.isFinite(row.completionTokens) ? row.completionTokens : undefined,
      totalTokens: typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens) ? row.totalTokens : undefined,
      cachedPromptTokens: typeof row.cachedPromptTokens === "number" && Number.isFinite(row.cachedPromptTokens) ? row.cachedPromptTokens : undefined,
      imageCount: typeof row.imageCount === "number" && Number.isFinite(row.imageCount) ? row.imageCount : undefined,
      imageCostUsd: typeof row.imageCostUsd === "number" && Number.isFinite(row.imageCostUsd) ? row.imageCostUsd : undefined,
      promptCacheKeyHash: typeof row.promptCacheKeyHash === "string" ? row.promptCacheKeyHash : undefined,
      promptCacheKeyUsed: row.promptCacheKeyUsed === true,
      cacheHit: row.cacheHit === true,
      ttftMs: typeof row.ttftMs === "number" && Number.isFinite(row.ttftMs) ? row.ttftMs : undefined,
      tps: typeof row.tps === "number" && Number.isFinite(row.tps) ? row.tps : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
      upstreamErrorCode: typeof row.upstreamErrorCode === "string" ? row.upstreamErrorCode : undefined,
      upstreamErrorType: typeof row.upstreamErrorType === "string" ? row.upstreamErrorType : undefined,
      upstreamErrorMessage: typeof row.upstreamErrorMessage === "string" ? row.upstreamErrorMessage : undefined,
      costUsd: typeof row.costUsd === "number" && Number.isFinite(row.costUsd) ? row.costUsd : undefined,
      energyJoules: typeof row.energyJoules === "number" && Number.isFinite(row.energyJoules) ? row.energyJoules : undefined,
      waterEvaporatedMl: typeof row.waterEvaporatedMl === "number" && Number.isFinite(row.waterEvaporatedMl) ? row.waterEvaporatedMl : undefined,
    };
  }

  async function firstExistingAssetPath(paths: readonly string[]): Promise<string | undefined> {
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
    const indexPath = await firstExistingAssetPath([
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
    return firstExistingAssetPath(candidates);
  }

  let mcpSeedCache: { readonly loadedAt: number; readonly seeds: Awaited<ReturnType<typeof loadMcpSeeds>> } | undefined;
  const federationRequestTimeoutMs = 5000;
  const credentialStore = deps.credentialStore;
  const credentialCtx = createCredentialRouteContext(deps);
  const oauthManager = credentialCtx.openAiOAuthManager;
  const factoryOAuthManager = credentialCtx.factoryOAuthManager;
  const { bridgeRelay } = await registerWebSocketRoutes(app, deps);
  const hostDashboardTargets = loadHostDashboardTargetsFromEnv(process.env);
  const hostDashboardDockerSocketPath = process.env.HOST_DASHBOARD_DOCKER_SOCKET_PATH?.trim() || undefined;
  const hostDashboardRuntimeRoot = process.env.HOST_DASHBOARD_RUNTIME_ROOT?.trim() || undefined;
  const hostDashboardRequestTimeoutMs = Math.max(5000, Math.min(60_000, Number(process.env.HOST_DASHBOARD_REQUEST_TIMEOUT_MS) || 10000));

  const loadCachedMcpSeeds = async () => {
    const now = Date.now();
    if (mcpSeedCache && now - mcpSeedCache.loadedAt < 30_000) {
      return mcpSeedCache.seeds;
    }

    const ecosystemsDir = await firstExistingPath([
      resolve(process.cwd(), "../../../ecosystems"),
      resolve(process.cwd(), "../../ecosystems"),
      resolve(process.cwd(), "ecosystems"),
    ]);

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

  app.get("/api/ui/settings", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const settings = await deps.proxySettingsStore.getForTenant(auth.tenantId ?? DEFAULT_TENANT_ID);
    reply.send(settings);
  });

  app.get("/api/ui/me", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const tenants = deps.sqlCredentialStore
      ? toVisibleTenants(
        auth,
        auth.kind === "legacy_admin"
          ? await deps.sqlCredentialStore.listTenants()
          : [],
      )
      : [];

    reply.send({
      auth,
      activeTenantId: auth.tenantId ?? null,
      memberships: auth.memberships ?? [],
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

    const visibleTenants = toVisibleTenants(
      auth,
      auth.kind === "legacy_admin"
        ? await deps.sqlCredentialStore.listTenants()
        : [],
    );

    reply.send({ tenants: visibleTenants });
  });

  app.post<{ Params: { readonly tenantId: string } }>("/api/ui/tenants/:tenantId/select", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.authPersistence) {
      reply.code(501).send({ error: "auth_persistence_not_supported" });
      return;
    }

    if (auth.kind !== "ui_session") {
      reply.code(400).send({ error: "ui_session_required" });
      return;
    }

    const tenantId = normalizeTenantId(request.params.tenantId);
    if (!authCanViewTenant(auth, tenantId)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const accessToken = readCookieValue(request.headers.cookie, "proxy_auth");
    if (!accessToken) {
      reply.code(401).send({ error: "session_cookie_missing" });
      return;
    }

    const storedAccessToken = await deps.authPersistence.getAccessToken(accessToken);
    if (!storedAccessToken || storedAccessToken.subject !== auth.subject) {
      reply.code(401).send({ error: "invalid_session" });
      return;
    }

    const nextAccessExtra = {
      ...(storedAccessToken.extra ?? {}),
      activeTenantId: tenantId,
    };
    await deps.authPersistence.updateAccessTokenExtra(accessToken, nextAccessExtra);

    const refreshToken = readCookieValue(request.headers.cookie, "proxy_refresh");
    if (refreshToken) {
      const storedRefreshToken = await deps.authPersistence.getRefreshToken(refreshToken);
      if (storedRefreshToken && storedRefreshToken.subject === auth.subject) {
        const nextRefreshExtra = {
          ...(storedRefreshToken.extra ?? {}),
          activeTenantId: tenantId,
        };
        await deps.authPersistence.updateRefreshTokenExtra(refreshToken, nextRefreshExtra);
      }
    }

    reply.send({ ok: true, activeTenantId: tenantId });
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

  app.post<{
    Body: {
      readonly fastMode?: unknown;
      readonly requestsPerMinute?: unknown;
      readonly allowedProviderIds?: unknown;
      readonly disabledProviderIds?: unknown;
    };
  }>("/api/ui/settings", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (auth.kind === "tenant_api_key") {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    if (auth.kind === "ui_session" && auth.role !== "owner" && auth.role !== "admin") {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const requestsPerMinute = parseOptionalRequestsPerMinute(request.body?.requestsPerMinute);
    if (request.body?.requestsPerMinute !== undefined && requestsPerMinute === undefined) {
      reply.code(400).send({ error: "invalid_requests_per_minute" });
      return;
    }

    const allowedProviderIds = parseOptionalProviderIds(request.body?.allowedProviderIds);
    if (request.body?.allowedProviderIds !== undefined && allowedProviderIds === undefined) {
      reply.code(400).send({ error: "invalid_allowed_provider_ids" });
      return;
    }

    const disabledProviderIds = parseOptionalProviderIds(request.body?.disabledProviderIds);
    if (request.body?.disabledProviderIds !== undefined && disabledProviderIds === undefined) {
      reply.code(400).send({ error: "invalid_disabled_provider_ids" });
      return;
    }

    const tenantId = auth.tenantId ?? DEFAULT_TENANT_ID;
    const nextSettings = await deps.proxySettingsStore.setForTenant({
      fastMode: request.body?.fastMode === undefined ? undefined : parseBoolean(request.body?.fastMode),
      requestsPerMinute,
      allowedProviderIds,
      disabledProviderIds,
    }, tenantId);

    app.log.info({ fastMode: nextSettings.fastMode, requestsPerMinute: nextSettings.requestsPerMinute, allowedProviderIds: nextSettings.allowedProviderIds, disabledProviderIds: nextSettings.disabledProviderIds, tenantId }, "updated proxy UI settings");
    reply.send(nextSettings);
  });

  app.get("/api/ui/sessions", async (_request, reply) => {
    const sessions = await sessionContext.sessionStore.listSessions();
    reply.send({ sessions });
  });

  app.post<{ Body: { readonly title?: string } }>("/api/ui/sessions", async (request, reply) => {
    const session = await sessionContext.sessionStore.createSession(request.body?.title);
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

  app.get<{
    Querystring: { readonly ownerSubject?: string };
  }>("/api/ui/federation/peers", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const peers = await deps.sqlFederationStore.listPeers(ownerSubject);
    reply.send({ peers });
  });

  app.get("/api/ui/federation/self", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const peerCount = deps.sqlFederationStore
      ? (await deps.sqlFederationStore.listPeers()).length
      : 0;

    reply.send({
      nodeId: process.env.FEDERATION_SELF_NODE_ID ?? null,
      groupId: process.env.FEDERATION_SELF_GROUP_ID ?? null,
      clusterId: process.env.FEDERATION_SELF_CLUSTER_ID ?? null,
      peerDid: process.env.FEDERATION_SELF_PEER_DID ?? null,
      publicBaseUrl: process.env.FEDERATION_SELF_PUBLIC_BASE_URL ?? null,
      peerCount,
    });
  });

  app.get("/api/ui/federation/bridge/ws", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    reply.code(426).header("upgrade", "websocket").send({ error: "websocket_upgrade_required" });
  });

  app.get("/api/ui/federation/bridges", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    // Scope bridge sessions to the authenticated tenant for non-global admins.
    // legacy_admin has global visibility; ui_session users see only their tenant's sessions.
    const isGlobalAdmin = auth?.kind === "legacy_admin";
    const allSessions = bridgeRelay.listSessions();
    const sessions = isGlobalAdmin
      ? allSessions
      : allSessions.filter((session) => session.tenantId === auth?.tenantId);

    reply.send({ sessions });
  });

  app.get<{ Params: { readonly sessionId: string } }>("/api/ui/federation/bridges/:sessionId", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const session = bridgeRelay.getSession(request.params.sessionId);
    if (!session) {
      reply.code(404).send({ error: "bridge_session_not_found" });
      return;
    }

    // Scope single session access to authenticated tenant
    const isGlobalAdmin = auth?.kind === "legacy_admin";
    if (!isGlobalAdmin && session.tenantId !== auth?.tenantId) {
      reply.code(404).send({ error: "bridge_session_not_found" });
      return;
    }

    reply.send({ session });
  });

  app.post<{
    Body: {
      readonly id?: string;
      readonly ownerCredential?: string;
      readonly peerDid?: string;
      readonly label?: string;
      readonly baseUrl?: string;
      readonly controlBaseUrl?: string;
      readonly auth?: Record<string, unknown>;
      readonly capabilities?: Record<string, unknown>;
      readonly status?: string;
    };
  }>("/api/ui/federation/peers", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerCredential = typeof request.body?.ownerCredential === "string" ? request.body.ownerCredential.trim() : "";
    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    const baseUrl = typeof request.body?.baseUrl === "string" ? request.body.baseUrl.trim() : "";

    if (!ownerCredential || !label || !baseUrl) {
      reply.code(400).send({ error: "owner_credential_label_and_base_url_required" });
      return;
    }

    const peer = await deps.sqlFederationStore.upsertPeer({
      id: request.body?.id,
      ownerCredential,
      peerDid: request.body?.peerDid,
      label,
      baseUrl,
      controlBaseUrl: request.body?.controlBaseUrl,
      auth: request.body?.auth,
      capabilities: request.body?.capabilities,
      status: request.body?.status,
    });
    await deps.sqlFederationStore.appendDiffEvent({
      ownerSubject: peer.ownerSubject,
      entityType: "peer",
      entityKey: peer.id,
      op: "upsert",
      payload: {
        peerDid: peer.peerDid,
        label: peer.label,
        baseUrl: peer.baseUrl,
        controlBaseUrl: peer.controlBaseUrl,
        authMode: peer.authMode,
        status: peer.status,
      },
    });

    reply.code(201).send({ peer });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string; readonly afterSeq?: string; readonly limit?: string };
  }>("/api/ui/federation/diff-events", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" ? request.query.ownerSubject.trim() : "";
    if (!ownerSubject) {
      reply.code(400).send({ error: "owner_subject_required" });
      return;
    }

    const afterSeq = typeof request.query.afterSeq === "string" ? Number.parseInt(request.query.afterSeq, 10) : undefined;
    const limit = toSafeLimit(request.query.limit, 200, 500);
    const events = await deps.sqlFederationStore.listDiffEvents({ ownerSubject, afterSeq, limit });
    reply.send({ ownerSubject, events });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string };
  }>("/api/ui/federation/accounts", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const projectedAccounts = await deps.sqlFederationStore.listProjectedAccounts(ownerSubject);
    const { localAccounts, knownAccounts } = await buildFederationAccountKnowledge(credentialStore, projectedAccounts, {
      ownerSubject,
      defaultOwnerSubject: process.env.FEDERATION_DEFAULT_OWNER_SUBJECT,
    });

    reply.send({
      ownerSubject: ownerSubject ?? null,
      localAccounts,
      projectedAccounts,
      knownAccounts,
    });
  });

  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>("/api/ui/federation/accounts/export", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!providerId || !accountId) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    const account = await findCredentialForFederationExport(credentialStore, providerId, accountId);
    if (!account) {
      reply.code(404).send({ error: "credential_account_not_found" });
      return;
    }

    if (account.authType === "oauth_bearer") {
      reply.send({ account: { ...account, refreshToken: undefined } });
      return;
    }

    reply.send({ account });
  });

  app.post<{
    Body: {
      readonly accounts?: ReadonlyArray<{
        readonly sourcePeerId?: string;
        readonly ownerSubject?: string;
        readonly providerId?: string;
        readonly accountId?: string;
        readonly accountSubject?: string;
        readonly chatgptAccountId?: string;
        readonly email?: string;
        readonly planType?: string;
        readonly availabilityState?: "descriptor" | "remote_route" | "imported";
        readonly metadata?: Record<string, unknown>;
      }>;
    };
  }>("/api/ui/federation/projected-accounts/import", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const accounts = Array.isArray(request.body?.accounts) ? request.body.accounts : [];
    if (accounts.length === 0) {
      reply.code(400).send({ error: "accounts_required" });
      return;
    }

    const imported = [] as Awaited<ReturnType<typeof deps.sqlFederationStore.upsertProjectedAccount>>[];
    for (const account of accounts) {
      const sourcePeerId = typeof account?.sourcePeerId === "string" ? account.sourcePeerId.trim() : "";
      const ownerSubject = typeof account?.ownerSubject === "string" ? account.ownerSubject.trim() : "";
      const providerId = typeof account?.providerId === "string" ? account.providerId.trim() : "";
      const accountId = typeof account?.accountId === "string" ? account.accountId.trim() : "";
      if (!sourcePeerId || !ownerSubject || !providerId || !accountId) {
        reply.code(400).send({ error: "source_peer_id_owner_subject_provider_id_and_account_id_required" });
        return;
      }

      const record = await deps.sqlFederationStore.upsertProjectedAccount({
        sourcePeerId,
        ownerSubject,
        providerId,
        accountId,
        accountSubject: typeof account?.accountSubject === "string" ? account.accountSubject : undefined,
        chatgptAccountId: typeof account?.chatgptAccountId === "string" ? account.chatgptAccountId : undefined,
        email: typeof account?.email === "string" ? account.email : undefined,
        planType: typeof account?.planType === "string" ? account.planType : undefined,
        availabilityState: account?.availabilityState,
        metadata: account?.metadata,
      });
      imported.push(record);
      await deps.sqlFederationStore.appendDiffEvent({
        ownerSubject: record.ownerSubject,
        entityType: "projected_account",
        entityKey: `${record.sourcePeerId}:${record.providerId}:${record.accountId}`,
        op: "upsert",
        payload: {
          providerId: record.providerId,
          accountId: record.accountId,
          availabilityState: record.availabilityState,
          sourcePeerId: record.sourcePeerId,
          email: record.email,
          chatgptAccountId: record.chatgptAccountId,
        },
      });
    }

    reply.code(201).send({ accounts: imported });
  });

  app.post<{
    Body: { readonly sourcePeerId?: string; readonly providerId?: string; readonly accountId?: string };
  }>("/api/ui/federation/projected-accounts/routed", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }
    const sqlFederationStore = deps.sqlFederationStore;

    const sourcePeerId = typeof request.body?.sourcePeerId === "string" ? request.body.sourcePeerId.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!sourcePeerId || !providerId || !accountId) {
      reply.code(400).send({ error: "source_peer_id_provider_id_and_account_id_required" });
      return;
    }

    let account = await sqlFederationStore.noteProjectedAccountRouted({ sourcePeerId, providerId, accountId });
    if (!account) {
      reply.code(404).send({ error: "projected_account_not_found" });
      return;
    }

    let importedCredential = false;
    if (shouldWarmImportProjectedAccount(account.warmRequestCount)) {
      const importResult = await sqlFederationStore.withProjectedAccountImportLock({ sourcePeerId, providerId, accountId }, async () => {
        const latest = await sqlFederationStore.getProjectedAccount({ sourcePeerId, providerId, accountId });
        if (!latest) {
          return undefined;
        }
        if (latest.availabilityState === "imported") {
          return { account: latest, importedCredential: false };
        }

        const peer = await sqlFederationStore.getPeer(sourcePeerId);
        const credential = peer ? extractPeerCredential(peer.auth) : undefined;
        if (!peer || !credential) {
          return { account: latest, importedCredential: false };
        }

        try {
          const remoteExport = await fetchFederationJson<{ readonly account: FederationCredentialExport }>({
            url: `${peer.controlBaseUrl ?? peer.baseUrl}/api/ui/federation/accounts/export`,
            credential,
            timeoutMs: federationRequestTimeoutMs,
            method: "POST",
            body: {
              providerId: latest.providerId,
              accountId: latest.accountId,
            },
          });

          if (remoteExport.account.authType === "oauth_bearer") {
            await credentialStore.upsertOAuthAccount(
              remoteExport.account.providerId,
              remoteExport.account.accountId,
              remoteExport.account.secret,
              remoteExport.account.refreshToken,
              remoteExport.account.expiresAt,
              remoteExport.account.chatgptAccountId,
              remoteExport.account.email,
              remoteExport.account.subject,
              remoteExport.account.planType,
            );
          } else {
            await credentialStore.upsertApiKeyAccount(
              remoteExport.account.providerId,
              remoteExport.account.accountId,
              remoteExport.account.secret,
            );
          }

          const imported = await sqlFederationStore.markProjectedAccountImported({ sourcePeerId, providerId, accountId });
          return { account: imported ?? latest, importedCredential: true };
        } catch (error) {
          app.log.warn({ error: error instanceof Error ? error.message : String(error), sourcePeerId, providerId, accountId }, "failed warm federation credential import");
          return { account: latest, importedCredential: false };
        }
      });

      if (importResult) {
        account = importResult.account;
        importedCredential = importResult.importedCredential;
      } else {
        const latest = await sqlFederationStore.getProjectedAccount({ sourcePeerId, providerId, accountId });
        if (latest) {
          account = latest;
          importedCredential = latest.availabilityState === "imported";
        }
      }
    }

    await sqlFederationStore.appendDiffEvent({
      ownerSubject: account.ownerSubject,
      entityType: "projected_account",
      entityKey: `${account.sourcePeerId}:${account.providerId}:${account.accountId}`,
      op: "note_routed",
      payload: {
        providerId: account.providerId,
        accountId: account.accountId,
        availabilityState: account.availabilityState,
        warmRequestCount: account.warmRequestCount,
        importedCredential,
      },
    });

    reply.send({ account, importedCredential });
  });

  app.post<{
    Body: { readonly sourcePeerId?: string; readonly providerId?: string; readonly accountId?: string };
  }>("/api/ui/federation/projected-accounts/imported", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const sourcePeerId = typeof request.body?.sourcePeerId === "string" ? request.body.sourcePeerId.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!sourcePeerId || !providerId || !accountId) {
      reply.code(400).send({ error: "source_peer_id_provider_id_and_account_id_required" });
      return;
    }

    const existing = await deps.sqlFederationStore.getProjectedAccount({ sourcePeerId, providerId, accountId });
    if (existing && !projectedAccountAllowsCredentialImport(existing)) {
      reply.code(409).send({
        error: "credential_non_importable",
        detail: "oauth_bearer projected accounts are route-only and cannot be marked imported",
      });
      return;
    }

    const account = await deps.sqlFederationStore.markProjectedAccountImported({ sourcePeerId, providerId, accountId });
    if (!account) {
      reply.code(404).send({ error: "projected_account_not_found" });
      return;
    }

    await deps.sqlFederationStore.appendDiffEvent({
      ownerSubject: account.ownerSubject,
      entityType: "projected_account",
      entityKey: `${account.sourcePeerId}:${account.providerId}:${account.accountId}`,
      op: "mark_imported",
      payload: {
        providerId: account.providerId,
        accountId: account.accountId,
        availabilityState: account.availabilityState,
        importedAt: account.importedAt,
      },
    });

    reply.send({ account });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string; readonly subjectDid?: string };
  }>("/api/ui/federation/tenant-provider-policies", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlTenantProviderPolicyStore) {
      reply.code(503).send({ error: "tenant_provider_policy_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const subjectDid = typeof request.query.subjectDid === "string" && request.query.subjectDid.trim().length > 0
      ? request.query.subjectDid.trim()
      : undefined;

    const policies = await deps.sqlTenantProviderPolicyStore.listPolicies({ ownerSubject, subjectDid });
    reply.send({ policies });
  });

  app.post<{
    Body: {
      readonly subjectDid?: string;
      readonly providerId?: string;
      readonly providerKind?: string;
      readonly ownerSubject?: string;
      readonly shareMode?: string;
      readonly trustTier?: string;
      readonly allowedModels?: readonly string[];
      readonly maxRequestsPerMinute?: number | string | null;
      readonly maxConcurrentRequests?: number | string;
      readonly encryptedChannelRequired?: boolean;
      readonly warmImportThreshold?: number | string;
      readonly notes?: string;
    };
  }>("/api/ui/federation/tenant-provider-policies", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlTenantProviderPolicyStore) {
      reply.code(503).send({ error: "tenant_provider_policy_store_not_supported" });
      return;
    }

    const subjectDid = typeof request.body?.subjectDid === "string" ? request.body.subjectDid.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const ownerSubject = typeof request.body?.ownerSubject === "string" ? request.body.ownerSubject.trim() : "";
    if (!subjectDid || !providerId || !ownerSubject) {
      reply.code(400).send({ error: "subject_did_provider_id_and_owner_subject_required" });
      return;
    }

    const providerKind = normalizeTenantProviderKind(request.body?.providerKind) ?? "local_upstream";
    const shareMode = normalizeTenantProviderShareMode(request.body?.shareMode) ?? "deny";
    const trustTier = normalizeTenantProviderTrustTier(request.body?.trustTier) ?? "less_trusted";
    const allowedModels = Array.isArray(request.body?.allowedModels)
      ? request.body.allowedModels
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      : [];

    const maxRequestsPerMinute = parseOptionalRequestsPerMinute(request.body?.maxRequestsPerMinute);
    const maxConcurrentRequests = parseOptionalPositiveInteger(request.body?.maxConcurrentRequests);
    const warmImportThreshold = parseOptionalPositiveInteger(request.body?.warmImportThreshold);
    const notes = typeof request.body?.notes === "string" ? request.body.notes : undefined;

    const policy = await deps.sqlTenantProviderPolicyStore.upsertPolicy({
      subjectDid,
      providerId,
      providerKind,
      ownerSubject,
      shareMode,
      trustTier,
      allowedModels,
      maxRequestsPerMinute,
      maxConcurrentRequests,
      encryptedChannelRequired: request.body?.encryptedChannelRequired ?? false,
      warmImportThreshold,
      notes,
    });

    reply.code(201).send({ policy });
  });

  app.get<{
    Querystring: { readonly sinceMs?: string; readonly limit?: string; readonly afterTimestampMs?: string; readonly afterId?: string };
  }>("/api/ui/federation/usage-export", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const sinceMs = typeof request.query.sinceMs === "string" ? Number.parseInt(request.query.sinceMs, 10) : 0;
    const limit = toSafeLimit(request.query.limit, 500, 5000);
    const afterTimestampMs = typeof request.query.afterTimestampMs === "string" ? Number.parseInt(request.query.afterTimestampMs, 10) : undefined;
    const afterId = typeof request.query.afterId === "string" && request.query.afterId.trim().length > 0
      ? request.query.afterId.trim()
      : undefined;

    const safeSinceMs = Number.isFinite(sinceMs) ? sinceMs : 0;
    const after = afterId && typeof afterTimestampMs === "number" && Number.isFinite(afterTimestampMs)
      ? { timestampMs: afterTimestampMs, id: afterId }
      : undefined;
    const entries = deps.sqlRequestUsageStore
      ? await deps.sqlRequestUsageStore.listEntriesSince(safeSinceMs, {}, limit, after)
      : deps.requestLogStore.snapshotSinceWithLimit(safeSinceMs, limit, after);

    reply.send({ entries });
  });

  app.post<{
    Body: { readonly entries?: readonly unknown[] };
  }>("/api/ui/federation/usage-import", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlRequestUsageStore) {
      reply.code(503).send({ error: "request_usage_store_not_supported" });
      return;
    }

    const rawEntries = Array.isArray(request.body?.entries) ? request.body.entries : [];
    if (rawEntries.length === 0) {
      reply.code(400).send({ error: "entries_required" });
      return;
    }

    let importedCount = 0;
    for (const candidate of rawEntries) {
      const entry = sanitizeFederationUsageEntry(candidate);
      if (!entry) {
        continue;
      }
      await deps.sqlRequestUsageStore.upsertEntry(entry);
      importedCount += 1;
    }

    reply.send({ importedCount });
  });

  app.post<{
    Body: { readonly peerId?: string; readonly ownerSubject?: string; readonly sinceMs?: number; readonly pullUsage?: boolean };
  }>("/api/ui/federation/sync/pull", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const peerId = typeof request.body?.peerId === "string" ? request.body.peerId.trim() : "";
    if (!peerId) {
      reply.code(400).send({ error: "peer_id_required" });
      return;
    }

    const peer = await deps.sqlFederationStore.getPeer(peerId);
    if (!peer) {
      reply.code(404).send({ error: "peer_not_found" });
      return;
    }

    const ownerSubject = typeof request.body?.ownerSubject === "string" && request.body.ownerSubject.trim().length > 0
      ? request.body.ownerSubject.trim()
      : peer.ownerSubject;
    const credential = extractPeerCredential(peer.auth);
    if (!credential) {
      await deps.sqlFederationStore.upsertSyncState({ peerId, lastError: "peer auth credential missing" });
      reply.code(400).send({ error: "peer_auth_credential_missing" });
      return;
    }

    const controlBaseUrl = peer.controlBaseUrl ?? peer.baseUrl;
    const syncState = await deps.sqlFederationStore.getSyncState(peerId);
    const afterSeq = syncState?.lastPulledSeq ?? 0;
    const requestedSinceMs = typeof request.body?.sinceMs === "number" && Number.isFinite(request.body.sinceMs)
      ? request.body.sinceMs
      : syncState?.lastPullAt
        ? Date.parse(syncState.lastPullAt)
        : 0;

    try {
      const [remoteDiff, remoteAccounts] = await Promise.all([
        fetchFederationJson<{ readonly ownerSubject: string; readonly events: readonly { readonly seq: number }[] }>({
          url: `${controlBaseUrl}/api/ui/federation/diff-events?ownerSubject=${encodeURIComponent(ownerSubject)}&afterSeq=${afterSeq}&limit=500`,
          credential,
          timeoutMs: federationRequestTimeoutMs,
        }),
        fetchFederationJson<FederationAccountsResponse>({
          url: `${controlBaseUrl}/api/ui/federation/accounts?ownerSubject=${encodeURIComponent(ownerSubject)}`,
          credential,
          timeoutMs: federationRequestTimeoutMs,
        }),
      ]);

      const importedProjectedAccounts = [] as Awaited<ReturnType<typeof deps.sqlFederationStore.upsertProjectedAccount>>[];
      for (const account of remoteAccounts.localAccounts) {
        const record = await deps.sqlFederationStore.upsertProjectedAccount({
          sourcePeerId: peer.id,
          ownerSubject,
          providerId: account.providerId,
          accountId: account.accountId,
          accountSubject: account.subject,
          chatgptAccountId: account.chatgptAccountId,
          email: account.email,
          planType: account.planType,
          availabilityState: "descriptor",
          metadata: {
            hasCredentials: account.hasCredentials,
            knowledgeSources: account.knowledgeSources,
          },
        });
        importedProjectedAccounts.push(record);
      }

      let importedUsageCount = 0;
      const usagePageSize = 5000;
      if (request.body?.pullUsage !== false && deps.sqlRequestUsageStore) {
        let cursor: { readonly timestampMs: number; readonly id: string } | undefined;
        while (true) {
          const query = new URLSearchParams({
            sinceMs: String(Number.isFinite(requestedSinceMs) ? requestedSinceMs : 0),
            limit: String(usagePageSize),
          });
          if (cursor) {
            query.set("afterTimestampMs", String(cursor.timestampMs));
            query.set("afterId", cursor.id);
          }

          const remoteUsage = await fetchFederationJson<{ readonly entries: readonly unknown[] }>({
            url: `${controlBaseUrl}/api/ui/federation/usage-export?${query.toString()}`,
            credential,
            timeoutMs: federationRequestTimeoutMs,
          });

          let lastEntry: RequestLogEntry | undefined;
          for (const candidate of remoteUsage.entries) {
            const entry = sanitizeFederationUsageEntry(candidate);
            if (!entry) {
              continue;
            }
            await deps.sqlRequestUsageStore.upsertEntry(entry);
            importedUsageCount += 1;
            lastEntry = entry;
          }

          if (remoteUsage.entries.length < usagePageSize || !lastEntry) {
            break;
          }

          cursor = { timestampMs: lastEntry.timestamp, id: lastEntry.id };
        }
      }

      const highestSeq = remoteDiff.events.reduce((current, event) => Math.max(current, event.seq), afterSeq);
      const nextSyncState = await deps.sqlFederationStore.upsertSyncState({
        peerId,
        lastPulledSeq: highestSeq,
        lastPullAt: true,
        lastError: null,
      });

      reply.send({
        peer,
        ownerSubject,
        importedProjectedAccountsCount: importedProjectedAccounts.length,
        importedUsageCount,
        remoteDiffCount: remoteDiff.events.length,
        syncState: nextSyncState,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await deps.sqlFederationStore.upsertSyncState({ peerId, lastError: detail });
      reply.code(502).send({ error: "federation_pull_failed", detail });
    }
  });

  app.get("/api/ui/hosts/self", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanAccessHostDashboard(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const requestBaseUrl = inferBaseUrl(request);
    const selfTargetId = inferSelfHostDashboardTargetId({
      targets: hostDashboardTargets,
      explicitSelfId: process.env.HOST_DASHBOARD_SELF_ID,
      requestBaseUrl,
      requestHost: typeof request.headers.host === "string" ? request.headers.host : undefined,
    });
    const selfTarget = hostDashboardTargets.find((target) => target.id === selfTargetId) ?? hostDashboardTargets[0];
    if (!selfTarget) {
      reply.code(500).send({ error: "host_dashboard_targets_not_configured" });
      return;
    }

    const snapshot = await collectLocalHostDashboardSnapshot({
      target: selfTarget,
      dockerSocketPath: hostDashboardDockerSocketPath,
      runtimeRoot: hostDashboardRuntimeRoot,
    });
    reply.send(snapshot);
  });

  app.get("/api/ui/hosts/overview", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanAccessHostDashboard(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const requestBaseUrl = inferBaseUrl(request);
    const selfTargetId = inferSelfHostDashboardTargetId({
      targets: hostDashboardTargets,
      explicitSelfId: process.env.HOST_DASHBOARD_SELF_ID,
      requestBaseUrl,
      requestHost: typeof request.headers.host === "string" ? request.headers.host : undefined,
    });

    const hosts = await Promise.all(hostDashboardTargets.map(async (target) => {
      if (selfTargetId && target.id === selfTargetId) {
        return collectLocalHostDashboardSnapshot({
          target,
          dockerSocketPath: hostDashboardDockerSocketPath,
          runtimeRoot: hostDashboardRuntimeRoot,
        });
      }

      return fetchRemoteHostDashboardSnapshot({
        target,
        authToken: resolveHostDashboardTargetToken(target, process.env),
        timeoutMs: hostDashboardRequestTimeoutMs,
      });
    }));

    reply.send({
      generatedAt: new Date().toISOString(),
      selfTargetId: selfTargetId ?? null,
      hosts,
    });
  });

  app.get<{
    Querystring: { readonly sort?: string; readonly window?: string; readonly tenantId?: string; readonly issuer?: string; readonly keyId?: string };
  }>("/api/ui/dashboard/overview", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
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
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
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
  }>("/api/ui/credentials/openai/probe", async (request, reply) => {
    const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
      ? request.body.accountId.trim()
      : "";

    if (!accountId) {
      reply.code(400).send({ error: "account_id_required" });
      return;
    }

    try {
      const probeEndpoint = resolveOpenAiProbeEndpoint(deps.config);
      const result = await probeOpenAiAccount(credentialStore, {
        providerId: deps.config.openaiProviderId,
        accountId,
        openAiBaseUrl: probeEndpoint.openAiBaseUrl,
        openAiResponsesPath: probeEndpoint.openAiResponsesPath,
        logger: app.log,
      });

      reply.send(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const statusCode = detail.startsWith("OpenAI account not found:") ? 404 : 500;
      reply.code(statusCode).send({ error: statusCode === 404 ? "account_not_found" : "openai_probe_failed", detail });
    }
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
    Querystring: {
      readonly providerId?: string;
      readonly accountId?: string;
      readonly tenantId?: string;
      readonly issuer?: string;
      readonly keyId?: string;
      readonly limit?: string;
      readonly before?: string;
    };
  }>("/api/ui/request-logs", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    let tenantId = typeof request.query.tenantId === "string" && request.query.tenantId.trim().length > 0
      ? normalizeTenantId(request.query.tenantId)
      : undefined;
    let keyId = typeof request.query.keyId === "string" && request.query.keyId.trim().length > 0
      ? request.query.keyId.trim()
      : undefined;

    if (auth.kind !== "legacy_admin" && auth.kind !== "unauthenticated") {
      if (tenantId) {
        if (!authCanViewTenant(auth, tenantId)) {
          reply.code(403).send({ error: "forbidden" });
          return;
        }
      } else if (auth.tenantId) {
        tenantId = auth.tenantId;
      }

      if (auth.kind === "tenant_api_key") {
        if (keyId && auth.keyId && keyId !== auth.keyId) {
          reply.code(403).send({ error: "forbidden" });
          return;
        }
        keyId = auth.keyId;
      }
    }

    const entryFilters = {
      providerId: request.query.providerId,
      accountId: request.query.accountId,
      tenantId,
      issuer: typeof request.query.issuer === "string" && request.query.issuer.trim().length > 0
        ? request.query.issuer.trim()
        : undefined,
      keyId,
      limit: toSafeLimit(request.query.limit, 200, 2000),
      before: typeof request.query.before === "string" && request.query.before.length > 0
        ? request.query.before
        : undefined,
    };

    const entries = deps.sqlRequestUsageStore
      ? await deps.sqlRequestUsageStore.listEntries(entryFilters)
      : deps.requestLogStore.list(entryFilters);

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

  function inferWebConsoleUrl(request: FastifyRequest): string {
    const forwardedHost = typeof request.headers["x-forwarded-host"] === "string" ? request.headers["x-forwarded-host"].trim() : undefined;
    const hostHeader = typeof request.headers.host === "string" ? request.headers.host.trim() : undefined;
    const host = forwardedHost || hostHeader || "localhost";
    const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string" ? request.headers["x-forwarded-proto"].trim() : undefined;
    const protocol = forwardedProto || request.protocol || "http";
    const webPort = (process.env.PROXY_WEB_PORT ?? "5174").trim() || "5174";

    let hostname = "localhost";
    try {
      hostname = new URL(`http://${host}`).hostname || "localhost";
    } catch {
      hostname = host.split(":", 1)[0] || "localhost";
    }

    return `${protocol}://${hostname}:${webPort}`;
  }

  function escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderPublicLandingPage(request: FastifyRequest): string {
    const webUrl = inferWebConsoleUrl(request);
    const safeWebUrl = escapeHtml(webUrl);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Hax OpenAI Proxy</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; padding: 2rem; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.15rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Open Hax OpenAI Proxy</h1>
    <p>OpenAI-compatible proxy with a web console.</p>
    <h2>Proxy Token</h2>
    <p>
      This proxy is protected by a <strong>Proxy Token</strong>. Add it to every request as an Authorization header:
      <code>Authorization: Bearer &lt;Proxy Token&gt;</code>.
    </p>
    <ul>
      <li>Web console: <a href="${safeWebUrl}">${safeWebUrl}</a></li>
      <li>Health: <code>/health</code></li>
      <li>Models: <code>/v1/models</code></li>
      <li>Chat: <code>/v1/chat/completions</code></li>
      <li>Responses: <code>/v1/responses</code></li>
      <li>Images: <code>/v1/images/generations</code></li>
      <li>Embeddings: <code>/v1/embeddings</code></li>
    </ul>
  </body>
</html>`;
  }

  const sendUiIndexWithRootFallback = async (request: FastifyRequest, reply: { type: (value: string) => void; send: (value: unknown) => void }) => {
    const authEnabled = Boolean(deps.config.proxyAuthToken) && deps.config.allowUnauthenticated !== true;

    if (request.url === "/" && authEnabled) {
      reply.type("text/html; charset=utf-8");
      reply.send(renderPublicLandingPage(request));
      return;
    }

    const html = await loadUiIndexHtml();
    if (!html) {
      if (request.url === "/") {
        reply.type("text/html; charset=utf-8");
        reply.send(renderPublicLandingPage(request));
        return;
      }

      reply.send({ ok: true, name: "open-hax-openai-proxy", version: "0.1.0" });
      return;
    }

    reply.type("text/html; charset=utf-8");
    reply.send(html);
  };

  app.get("/", async (request, reply) => {
    await sendUiIndexWithRootFallback(request, reply);
  });

  for (const path of ["/chat", "/images", "/credentials", "/tools", "/hosts"] as const) {
    app.get(path, async (request, reply) => {
      await sendUiIndexWithRootFallback(request, reply);
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

  return bridgeRelay;
}
