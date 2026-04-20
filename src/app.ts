import { dirname, join } from "node:path";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { DEFAULT_MODELS, type ProxyConfig } from "./lib/config.js";
import {
  PROXY_AUTH_COOKIE_NAME,
  readCookieToken,
  readSingleHeader,
  escapeHtml,
  isTrustedLocalBridgeAddress,
  SUPPORTED_V1_ENDPOINTS,
  SUPPORTED_NATIVE_OLLAMA_ENDPOINTS,
} from "./lib/request-utils.js";
import { toErrorMessage } from "./lib/errors/index.js";
import { getTelemetry, type TelemetrySpan } from "./lib/telemetry/otel.js";

import { KeyPool, type ProviderCredential } from "./lib/key-pool.js";
import { CredentialStore } from "./lib/credential-store.js";
import { RuntimeCredentialStore } from "./lib/runtime-credential-store.js";
import { OpenAiOAuthManager } from "./lib/openai-oauth.js";

import { initializePolicyEngine, createPolicyEngine, type PolicyEngine, DEFAULT_POLICY_CONFIG } from "./lib/policy/index.js";

import {
  buildOllamaCatalogRoutes,
  buildProviderRoutesWithDynamicBaseUrls,
  createDynamicProviderBaseUrlGetter,
  parseModelIdsFromCatalogPayload,
  type ProviderRoute,
  type ResolvedModelCatalog,
} from "./lib/provider-routing.js";

import { ProviderCatalogStore } from "./lib/provider-catalog.js";
import { RequestLogStore } from "./lib/request-log-store.js";
import { RequestLogSseHub } from "./lib/observability/request-log-sse-hub.js";

import { SqlPromptAffinityStore } from "./lib/db/sql-prompt-affinity-store.js";
import { ProviderRoutePheromoneStore } from "./lib/provider-route-pheromone-store.js";
import { ProxySettingsStore } from "./lib/proxy-settings-store.js";

import { QuotaMonitor } from "./lib/quota-monitor.js";

import { createTokenRefreshManager } from "./lib/token-refresh-handlers.js";
import type { TokenRefreshManager } from "./lib/token-refresh-manager.js";

import { createSqlConnection, closeConnection, type Sql } from "./lib/db/index.js";
import { SqlCredentialStore } from "./lib/db/sql-credential-store.js";
import { AccountHealthStore } from "./lib/db/account-health-store.js";
import { EventStore } from "./lib/db/event-store.js";
import { createDefaultLabelers } from "./lib/db/event-labelers.js";
import { SqlRequestUsageStore } from "./lib/db/sql-request-usage-store.js";
import { SqlFederationStore } from "./lib/db/sql-federation-store.js";
import { SqlTenantProviderPolicyStore } from "./lib/db/sql-tenant-provider-policy-store.js";
import { SqlAuthPersistence } from "./lib/auth/sql-persistence.js";
import {
  seedApiKeyProvidersFromEnv,
  seedFromJsonFile,
  seedFromJsonValue,
  seedFactoryAuthFromFiles,
  seedModelsFromFile,
} from "./lib/db/json-seeder.js";

import { DEFAULT_TENANT_ID } from "./lib/tenant-api-key.js";
import { resolveRequestAuth, type ResolvedRequestAuth } from "./lib/request-auth.js";

import { registerUiRoutes } from "./lib/ui-routes.js";
import { registerApiV1Routes } from "./routes/api/v1/index.js";

import {
  executeFederatedRequestFallback,
} from "./lib/federation/federated-fallback.js";
import {
  executeBridgeRequestFallback,
  handleBridgeRequest,
  injectNativeBridge,
} from "./lib/federation/bridge-fallback.js";
import { createEnvFederationBridgeAgent } from "./lib/federation/bridge-agent-autostart.js";
import type { FederationBridgeRelay } from "./lib/federation/bridge-relay.js";

import { registerChatRoutes } from "./routes/chat.js";
import { registerResponsesRoutes } from "./routes/responses.js";
import { registerImagesRoutes } from "./routes/images.js";
import { registerWebsearchRoutes } from "./routes/websearch.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerEmbeddingsRoutes } from "./routes/embeddings.js";
import { registerNativeOllamaRoutes } from "./routes/native-ollama.js";
import { registerHealthRoutes } from "./routes/health.js";
import { sendOpenAiError } from "./lib/provider-utils.js";
import { isAtDid } from "./lib/federation/owner-credential.js";

import type { AppDeps } from "./lib/app-deps.js";

function inferWebConsoleUrl(request: FastifyRequest): string {
  const forwardedHost = readSingleHeader(request.headers as Record<string, unknown>, "x-forwarded-host")?.trim();
  const host = forwardedHost
    || readSingleHeader(request.headers as Record<string, unknown>, "host")?.trim()
    || "localhost";
  const forwardedProto = readSingleHeader(request.headers as Record<string, unknown>, "x-forwarded-proto")?.trim();
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

function renderPublicLandingPage(request: FastifyRequest): string {
  const webUrl = inferWebConsoleUrl(request);
  const safeWebUrl = escapeHtml(webUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proxx</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; padding: 2rem; }
      code { background: #f4f4f5; padding: 0.15rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Proxx</h1>
    <p>OpenAI-compatible proxy.</p>
    <ul>
      <li>UI: <a href="${safeWebUrl}">${safeWebUrl}</a></li>
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

export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 300 * 1024 * 1024,
  });

  // Enable raw zip uploads for ChatGPT export import.
  app.addContentTypeParser(["application/zip"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  let sql: Sql | undefined;
  let sqlCredentialStore: SqlCredentialStore | undefined;
  let sqlAuthPersistence: SqlAuthPersistence | undefined;
  let accountHealthStore: AccountHealthStore | undefined;
  let eventStore: EventStore | undefined;
  let sqlRequestUsageStore: SqlRequestUsageStore | undefined;
  let sqlFederationStore: SqlFederationStore | undefined;
  let sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;

  if (config.databaseUrl) {
    sql = createSqlConnection({ connectionString: config.databaseUrl });
    app.log.info("connecting to database");

    sqlCredentialStore = new SqlCredentialStore(sql, { defaultTenantId: DEFAULT_TENANT_ID });
    await sqlCredentialStore.init();

    accountHealthStore = new AccountHealthStore(sql);
    await accountHealthStore.init();

    eventStore = new EventStore(sql);
    await eventStore.init();
    for (const labeler of createDefaultLabelers()) {
      eventStore.registerLabeler(labeler);
    }

    sqlRequestUsageStore = new SqlRequestUsageStore(sql);
    await sqlRequestUsageStore.init();

    sqlFederationStore = new SqlFederationStore(sql);
    await sqlFederationStore.init();

    try {
      sqlTenantProviderPolicyStore = new SqlTenantProviderPolicyStore(sql);
      await sqlTenantProviderPolicyStore.init();
    } catch (error) {
      sqlTenantProviderPolicyStore = undefined;
      app.log.warn({ error: toErrorMessage(error) }, "failed to initialize tenant provider policy store; continuing with policy store disabled");
    }

    sqlAuthPersistence = new SqlAuthPersistence(sql);
    await sqlAuthPersistence.init();

    if (config.keysFilePath) {
      try {
        const seedResult = await seedFromJsonFile(sql, config.keysFilePath, config.upstreamProviderId, {
          skipExistingProviders: true,
        });
        app.log.info({ providers: seedResult.providers, accounts: seedResult.accounts }, "seeded credentials from json file");
      } catch (error) {
        app.log.warn({ error: toErrorMessage(error) }, "failed to seed credentials from json file; continuing with existing data");
      }
    }

    const inlineKeysJson = process.env.PROXY_KEYS_JSON ?? process.env.UPSTREAM_KEYS_JSON ?? process.env.VIVGRID_KEYS_JSON;
    if (typeof inlineKeysJson === "string" && inlineKeysJson.trim().length > 0) {
      try {
        const parsedInlineKeys: unknown = JSON.parse(inlineKeysJson);
        const seedResult = await seedFromJsonValue(sql, parsedInlineKeys, config.upstreamProviderId, {
          skipExistingProviders: true,
        });
        app.log.info({ providers: seedResult.providers, accounts: seedResult.accounts }, "seeded credentials from inline json env");
      } catch (error) {
        app.log.warn({ error: toErrorMessage(error) }, "failed to seed credentials from inline json env; continuing with existing data");
      }
    }

    try {
      const envSeedResult = await seedApiKeyProvidersFromEnv(sql);
      if (envSeedResult.providers > 0 || envSeedResult.accounts > 0) {
        app.log.info({ providers: envSeedResult.providers, accounts: envSeedResult.accounts }, "seeded api-key providers from env into database");
      }
    } catch (error) {
      app.log.warn({ error: toErrorMessage(error) }, "failed to seed api-key providers from env; continuing with existing data");
    }

    try {
      const factorySeed = await seedFactoryAuthFromFiles(sql);
      if (factorySeed.seeded) {
        app.log.info("seeded Factory OAuth credentials from auth.v2 files into database");
      }
    } catch (error) {
      app.log.warn({ error: toErrorMessage(error) }, "failed to seed Factory OAuth credentials from auth.v2 files");
    }

    if (config.modelsFilePath) {
      try {
        const modelSeed = await seedModelsFromFile(sql, config.modelsFilePath, DEFAULT_MODELS);
        if (modelSeed.seeded) {
          app.log.info({ count: modelSeed.count }, "seeded models from file into database");
        }
      } catch (error) {
        app.log.warn({ error: toErrorMessage(error) }, "failed to seed models from file");
      }
    }

    const removedLegacyOpenAiAccounts = await sqlCredentialStore.cleanupLegacyOpenAiDuplicates();
    if (removedLegacyOpenAiAccounts > 0) {
      app.log.warn({ count: removedLegacyOpenAiAccounts }, "removed legacy duplicate OpenAI account rows after seeding");
    }
  }

  const dynamicProviderBaseUrlGetterRaw = createDynamicProviderBaseUrlGetter(sqlCredentialStore);

  const keyPool = new KeyPool({
    keysFilePath: config.keysFilePath,
    reloadIntervalMs: config.keyReloadMs,
    defaultCooldownMs: config.keyCooldownMs,
    defaultProviderId: config.upstreamProviderId,
    accountStore: sqlCredentialStore,
    cooldownStore: sqlCredentialStore,
    disabledStore: sqlCredentialStore,
    preferAccountStoreProviders: sqlCredentialStore !== undefined,
    cooldownJitterFactor: config.keyCooldownJitterFactor,
    enableRandomWalk: config.enableKeyRandomWalk,
  });

  try {
    await keyPool.warmup();
  } catch (error) {
    app.log.warn({ error: toErrorMessage(error) }, "failed to warm up provider accounts; non-keyed routes may still work");
  }

  const requestLogStore = new RequestLogStore(
    config.requestLogsFilePath,
    config.requestLogsMaxEntries,
    config.requestLogsFlushMs,
    sqlRequestUsageStore,
  );
  await requestLogStore.warmup();

  const requestLogSseHub = new RequestLogSseHub(requestLogStore);

  const promptAffinityStore = new SqlPromptAffinityStore(sql);
  await promptAffinityStore.init();

  const providerRoutePheromoneStore = new ProviderRoutePheromoneStore(
    join(dirname(config.requestLogsFilePath), "provider-route-pheromones.json"),
    config.promptAffinityFlushMs,
  );
  await providerRoutePheromoneStore.warmup();

  const proxySettingsStore = new ProxySettingsStore(config.settingsFilePath, sql);
  await proxySettingsStore.warmup();

  let policyEngine: PolicyEngine;
  try {
    policyEngine = await initializePolicyEngine(config.policyConfigPath);
    app.log.info({ policyConfigPath: config.policyConfigPath }, "policy engine initialized");
  } catch (error) {
    app.log.warn({ error: toErrorMessage(error) }, "failed to load policy config; using defaults");
    policyEngine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
  }

  const credentialStore = new CredentialStore(config.keysFilePath, config.upstreamProviderId);
  const runtimeCredentialStore = new RuntimeCredentialStore(credentialStore, sqlCredentialStore);

  const oauthManager = new OpenAiOAuthManager({
    oauthScopes: config.openaiOauthScopes,
    clientId: config.openaiOauthClientId,
    issuer: config.openaiOauthIssuer,
    clientSecret: config.openaiOauthClientSecret,
  });

  const tokenRefreshManager: TokenRefreshManager = createTokenRefreshManager({
    keyPool,
    runtimeCredentialStore,
    oauthManager,
    sqlCredentialStore,
    log: app.log,
    config: {
      maxConcurrency: config.oauthRefreshMaxConcurrency,
      backgroundIntervalMs: config.oauthRefreshBackgroundIntervalMs,
      expiryBufferMs: 60_000,
      proactiveRefreshWindowMs: config.oauthRefreshProactiveWindowMs,
      maxConsecutiveFailures: 3,
    },
  });

  tokenRefreshManager.startBackgroundRefresh(() => keyPool.getExpiringAccounts(config.oauthRefreshProactiveWindowMs));

  const ensureFreshAccounts = async (providerId: string): Promise<void> => {
    const expired = keyPool.getExpiredAccountsWithRefreshTokens(providerId);
    if (expired.length === 0) {
      return;
    }
    await tokenRefreshManager.refreshBatch(expired);
  };

  const refreshExpiredOAuthAccount = async (credential: ProviderCredential): Promise<ProviderCredential | null> => {
    if (credential.authType !== "oauth_bearer") {
      return null;
    }
    return tokenRefreshManager.refresh(credential);
  };

  const refreshFactoryAccount = async (credential: ProviderCredential): Promise<void> => {
    if (credential.providerId !== "factory") {
      return;
    }
    await tokenRefreshManager.refresh(credential);
  };

  async function refreshOpenAiOauthAccounts(accountId?: string): Promise<{
    readonly totalAccounts: number;
    readonly refreshedCount: number;
    readonly failedCount: number;
  }> {
    const allOpenAiAccounts = await keyPool.getAllAccounts(config.openaiProviderId).catch(() => [] as ProviderCredential[]);
    const normalizedAccountId = typeof accountId === "string" && accountId.trim().length > 0
      ? accountId.trim()
      : undefined;

    const candidates = allOpenAiAccounts.filter((account) => {
      if (account.authType !== "oauth_bearer") return false;
      if (typeof account.refreshToken !== "string" || account.refreshToken.trim().length === 0) return false;
      return normalizedAccountId === undefined || account.accountId === normalizedAccountId;
    });

    for (const account of candidates) {
      tokenRefreshManager.clearFailures(account);
    }

    const results = await tokenRefreshManager.refreshBatch(candidates);
    const refreshedCount = results.filter((result): result is ProviderCredential => result !== null).length;

    return {
      totalAccounts: candidates.length,
      refreshedCount,
      failedCount: candidates.length - refreshedCount,
    };
  }

  const quotaMonitor = new QuotaMonitor(
    runtimeCredentialStore,
    {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
    {
      checkIntervalMs: 20 * 60 * 1000,
      providerId: config.openaiProviderId.trim() || "openai",
      quotaWarningThreshold: 90,
      quotaCriticalThreshold: 98,
    },
    accountHealthStore,
  );
  quotaMonitor.start();

  const ollamaCatalogRoutes = buildOllamaCatalogRoutes(config);
  const providerCatalogRoutes = (await buildProviderRoutesWithDynamicBaseUrls(config, false, dynamicProviderBaseUrlGetterRaw, true))
    .filter((route) => route.providerId !== "factory" || !config.disabledProviderIds.includes("factory"));
  const providerCatalogStore = new ProviderCatalogStore(
    config,
    keyPool,
    providerCatalogRoutes,
    ollamaCatalogRoutes,
  );

  async function getResolvedModelCatalog(forceRefresh = false): Promise<ResolvedModelCatalog> {
    const resolved = await providerCatalogStore.getCatalog(forceRefresh);
    return resolved.catalog;
  }

  let bridgeRelay: FederationBridgeRelay | undefined;

  async function getBridgeAdvertisedModelIds(): Promise<string[]> {
    if (!bridgeRelay) {
      return [];
    }

    const connectedSessions = bridgeRelay.listSessions().filter((session) => session.state === "connected");
    if (connectedSessions.length === 0) {
      return [];
    }

    const advertisedModels = new Set<string>();
    for (const session of connectedSessions) {
      for (const capability of session.capabilities) {
        for (const model of capability.models) {
          advertisedModels.add(model);
        }
      }
    }

    if (advertisedModels.size > 0) {
      return [...advertisedModels];
    }

    const remoteModelLists = await Promise.all(connectedSessions.map(async (session) => {
      try {
        const response = await bridgeRelay!.requestJson(session.sessionId, {
          path: "/v1/models",
          timeoutMs: Math.min(config.requestTimeoutMs, 10_000),
          headers: { accept: "application/json" },
        });
        return parseModelIdsFromCatalogPayload(response.json);
      } catch (error) {
        app.log.warn({ error: toErrorMessage(error), sessionId: session.sessionId }, "failed to fetch bridge model inventory from connected session");
        return [];
      }
    }));

    return [...new Set(remoteModelLists.flat())];
  }

  async function getMergedModelIds(forceRefresh = false): Promise<string[]> {
    const localCatalog = await getResolvedModelCatalog(forceRefresh);
    const bridgedModels = await getBridgeAdvertisedModelIds();
    return [...new Set([...localCatalog.modelIds, ...bridgedModels])];
  }

  if (config.allowUnauthenticated) {
    app.log.warn("proxy auth disabled via PROXY_ALLOW_UNAUTHENTICATED=true");
  }

  type DecoratedAppRequest = FastifyRequest & {
    openHaxAuth: ResolvedRequestAuth | null;
    _otelSpan: TelemetrySpan | null;
  };

  const tenantRpmWindow = new Map<string, { windowStartMs: number; count: number }>();
  const RATE_LIMITED_TENANT_PATHS = new Set<string>([
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/images/generations",
    "/v1/embeddings",
    "/api/chat",
    "/api/generate",
    "/api/embed",
    "/api/embeddings",
  ]);

  app.decorateRequest("openHaxAuth", null);
  app.decorateRequest("_otelSpan", null);

  const FEDERATION_OWNER_SUBJECT_HEADER = "x-open-hax-federation-owner-subject";
  const FEDERATION_BRIDGE_TENANT_HEADER = "x-open-hax-bridge-tenant-id";

  app.addHook("onRequest", async (request, reply) => {
    const decoratedRequest = request as DecoratedAppRequest;
    const origin = request.headers.origin;
    reply.header("Access-Control-Allow-Origin", origin ?? "*");
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With, Cookie");
    reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

    if (request.method === "OPTIONS") {
      return;
    }

    const rawPath = (request.raw.url ?? request.url).split("?", 1)[0] ?? request.url;
    const allowUnauthenticatedRoute = rawPath === "/" || rawPath === "/favicon.ico" || rawPath === "/health";
    const allowUiSessionAuth = rawPath.startsWith("/api/ui/") || rawPath === "/api/v1" || rawPath.startsWith("/api/v1/") || rawPath.startsWith("/auth/");

    if (allowUnauthenticatedRoute) {
      return;
    }

    let bridgeResolvedAuth: ResolvedRequestAuth | undefined;
    const bridgeAuthHeader = request.headers["x-open-hax-bridge-auth"];
    const internalOwnerSubject = typeof request.headers[FEDERATION_OWNER_SUBJECT_HEADER] === "string"
      ? request.headers[FEDERATION_OWNER_SUBJECT_HEADER].trim()
      : undefined;
    const internalTenantId = typeof request.headers[FEDERATION_BRIDGE_TENANT_HEADER] === "string"
      ? request.headers[FEDERATION_BRIDGE_TENANT_HEADER].trim()
      : undefined;

    if (
      bridgeAuthHeader === "internal"
      && rawPath.startsWith("/v1/")
      && internalOwnerSubject
      && isTrustedLocalBridgeAddress(request.raw.socket.remoteAddress)
    ) {
      bridgeResolvedAuth = {
        kind: "legacy_admin",
        tenantId: internalTenantId || DEFAULT_TENANT_ID,
        role: "owner",
        source: "none",
        subject: internalOwnerSubject,
      };
    }

    const resolvedAuth = bridgeResolvedAuth ?? await resolveRequestAuth({
      allowUnauthenticated: config.allowUnauthenticated,
      proxyAuthToken: config.proxyAuthToken,
      authorization: request.headers.authorization,
      cookieToken: readCookieToken(request.headers.cookie, PROXY_AUTH_COOKIE_NAME),
      oauthAccessToken: allowUiSessionAuth ? readCookieToken(request.headers.cookie, "proxy_auth") : undefined,
      resolveTenantApiKey: sqlCredentialStore
        ? async (token) => sqlCredentialStore!.resolveTenantApiKey(token, config.proxyTokenPepper)
        : undefined,
      resolveUiSession: sqlCredentialStore && sqlAuthPersistence
        ? async (token) => {
          const accessToken = await sqlAuthPersistence!.getAccessToken(token);
          if (!accessToken) {
            return undefined;
          }
          const activeTenantId = typeof accessToken.extra?.activeTenantId === "string"
            ? accessToken.extra.activeTenantId
            : undefined;
          return sqlCredentialStore!.resolveUiSession(accessToken.subject, activeTenantId);
        }
        : undefined,
    });

    decoratedRequest.openHaxAuth = resolvedAuth ?? null;

    if (!resolvedAuth && !config.allowUnauthenticated) {
      sendOpenAiError(reply, 401, "Unauthorized", "invalid_request_error", "unauthorized");
      return;
    }

    const tenantId = resolvedAuth?.tenantId;
    if (tenantId && request.method === "POST") {
      const path = (request.raw.url ?? request.url).split("?", 1)[0] ?? request.url;
      if (RATE_LIMITED_TENANT_PATHS.has(path)) {
        const settings = await proxySettingsStore.getForTenant(tenantId);
        const requestsPerMinute = settings.requestsPerMinute;
        if (typeof requestsPerMinute === "number" && Number.isFinite(requestsPerMinute) && requestsPerMinute > 0) {
          const now = Date.now();
          const windowMs = 60_000;
          const entry = tenantRpmWindow.get(tenantId);
          const windowStartMs = entry && now - entry.windowStartMs < windowMs ? entry.windowStartMs : now;
          const count = entry && windowStartMs === entry.windowStartMs ? entry.count : 0;

          if (count >= requestsPerMinute) {
            const retryAfterSeconds = Math.ceil((windowStartMs + windowMs - now) / 1000);
            reply.header("retry-after", Math.max(1, retryAfterSeconds));
            sendOpenAiError(
              reply,
              429,
              "Tenant requests-per-minute quota exceeded.",
              "rate_limit_error",
              "tenant_quota_exceeded",
            );
            return;
          }

          tenantRpmWindow.set(tenantId, { windowStartMs, count: count + 1 });
        }
      }
    }
  });

  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS") return;
    const span = getTelemetry().startSpan("http.request", {
      "http.method": request.method,
      "http.path": (request.raw.url ?? request.url).split("?")[0],
    });
    (request as DecoratedAppRequest)._otelSpan = span;
  });

  app.addHook("onResponse", async (request, reply) => {
    const span = (request as DecoratedAppRequest)._otelSpan;
    if (!span) return;
    span.setAttribute("http.status_code", reply.statusCode);
    if (reply.statusCode >= 400) span.setStatus("error", `HTTP ${reply.statusCode}`);
    else span.setStatus("ok");
    span.end();
  });

  for (const path of [
    "/",
    "/health",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/images/generations",
    "/v1/embeddings",
    "/v1/models",
    "/v1/models/:model",
    "/api/chat",
    "/api/generate",
    "/api/embed",
    "/api/embeddings",
    "/api/tags",
    "/api/ui",
    "/api/ui/*",
    "/api/v1",
    "/api/v1/*",
  ]) {
    app.options(path, async (_request, reply) => {
      reply.code(204).send();
    });
  }

  // NOTE: the UI router owns GET / (and friends) to serve the SPA.
  // Defining it here would duplicate routes and break app construction.

  const uiBridgeRelay = await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
    refreshOpenAiOauthAccounts,
  });

  await registerApiV1Routes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
    refreshOpenAiOauthAccounts,
    bridgeRelay: uiBridgeRelay,
  });

  bridgeRelay = uiBridgeRelay;

  const fedDeps = { app, sqlFederationStore, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore };
  const bridgeDeps = { bridgeRelay, app, config, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore };

  const bridgeAgent = createEnvFederationBridgeAgent({
    config,
    keyPool,
    credentialStore: runtimeCredentialStore,
    logger: app.log,
    getResolvedModelCatalog: () => getResolvedModelCatalog(false),
    handleBridgeRequest: (input) => handleBridgeRequest(bridgeDeps, input),
  });

  if (bridgeAgent) {
    await bridgeAgent.start();
  }

  const deps: AppDeps = {
    app,
    config,
    keyPool,
    credentialStore,
    runtimeCredentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    accountHealthStore,
    eventStore,
    requestLogStore,
    promptAffinityStore,
    providerRoutePheromoneStore,
    proxySettingsStore,
    policyEngine,
    providerCatalogStore,
    tokenRefreshManager,
    dynamicProviderBaseUrlGetter: async (providerId: string) => {
      if (!dynamicProviderBaseUrlGetterRaw) {
        return undefined;
      }
      return (await dynamicProviderBaseUrlGetterRaw(providerId)) ?? undefined;
    },
    bridgeRelay,
    quotaMonitor,
    refreshFactoryAccount,
    ensureFreshAccounts,
    refreshExpiredOAuthAccount,
    getMergedModelIds,
    executeFederatedRequestFallback: async (input) => executeFederatedRequestFallback(fedDeps, input),
    injectNativeBridge: async (url, payload, headers) => injectNativeBridge(bridgeDeps, url, payload, headers),
  };

  registerHealthRoutes(deps, app);
  registerModelsRoutes(deps, app);
  registerWebsearchRoutes(deps, app);
  registerChatRoutes(deps, app);
  registerResponsesRoutes(deps, app);
  registerImagesRoutes(deps, app);
  registerEmbeddingsRoutes(deps, app);
  registerNativeOllamaRoutes(deps, app);

  app.addHook("onClose", async () => {
    if (bridgeAgent) {
      await bridgeAgent.stop();
    }

    await tokenRefreshManager.stopAndWait();
    quotaMonitor.stop();

    if (accountHealthStore) {
      await accountHealthStore.close();
    }
    if (eventStore) {
      await eventStore.close();
    }

    await requestLogSseHub.close();
    await promptAffinityStore.close();
    await providerRoutePheromoneStore.close();
    await requestLogStore.close();
    await credentialStore.close();
    if (sql) {
      await closeConnection(sql);
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    const path = rawUrl.split("?", 1)[0] ?? rawUrl;

    if (path.startsWith("/v1/")) {
      sendOpenAiError(
        reply,
        404,
        `Unsupported endpoint: ${request.method} ${path}. Supported endpoints: ${SUPPORTED_V1_ENDPOINTS.join(", ")}`,
        "invalid_request_error",
        "unsupported_endpoint",
      );
      return;
    }

    if (path.startsWith("/api/v1/")) {
      sendOpenAiError(
        reply,
        404,
        `Unsupported endpoint: ${request.method} ${path}. Supported API v1 endpoints begin with /api/v1 and are routed through the canonical control surface.`,
        "invalid_request_error",
        "unsupported_endpoint",
      );
      return;
    }

    if (path.startsWith("/api/")) {
      reply.code(404).send({
        error: `Unsupported endpoint: ${request.method} ${path}. Supported native endpoints: ${SUPPORTED_NATIVE_OLLAMA_ENDPOINTS.join(", ")}`,
      });
      return;
    }

    reply.code(404).send({ ok: false, error: "Not Found" });
  });

  return app;
}
