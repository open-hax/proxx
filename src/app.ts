import { dirname, join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import "./lib/fastify-types.js";

import type { ProxyConfig } from "./lib/config.js";
import { getActiveCljsRuntime } from "./lib/cljs-runtime.js";
import { kernels } from "./lib/cljs-kernels.js";
import { PROXY_AUTH_COOKIE_NAME } from "./lib/request-utils.js";

import { KeyPool } from "./lib/key-pool.js";
import { CredentialStore } from "./lib/credential-store.js";
import { OpenAiOAuthManager } from "./lib/openai-oauth.js";
import { ProviderCatalogStore } from "./lib/provider-catalog.js";
import {
  buildOllamaCatalogRoutes,
  parseModelIdsFromCatalogPayload,
  type ResolvedModelCatalog,
  createDynamicProviderBaseUrlGetter,
  getDeclaredProviderRoutes,
} from "./lib/provider-routing.js";
import { isOpenAiHttpError } from "./lib/provider-utils.js";
import { toErrorMessage } from "./lib/errors/index.js";
import { getTelemetry } from "./lib/telemetry/otel.js";
import { RequestLogStore } from "./lib/request-log-store.js";
import { SqlPromptAffinityStore } from "./lib/db/sql-prompt-affinity-store.js";
import { ProviderRoutePheromoneStore } from "./lib/provider-route-pheromone-store.js";
import { ProxySettingsStore } from "./lib/proxy-settings-store.js";
import { QuotaMonitor } from "./lib/quota-monitor.js";
import { RequestLogSseHub } from "./lib/observability/request-log-sse-hub.js";
import { registerWebSocketRoutes } from "./routes/api/ui/ws.js";
import { registerBridgeSseRoutes } from "./routes/api/ui/bridge-sse.js";
import { registerRequestLogSseRoutes } from "./routes/api/ui/request-log-sse.js";
import { registerApiV1Routes } from "./routes/api/v1/index.js";
import { registerObservabilityRoutes } from "./routes/observability/index.js";
import { modelIdsToNativeTags } from "./lib/ollama-native.js";
import { createSqlConnection, closeConnection, type Sql } from "./lib/db/index.js";
import { SqlCredentialStore } from "./lib/db/sql-credential-store.js";
import { AccountHealthStore } from "./lib/db/account-health-store.js";
import { EventStore } from "./lib/db/event-store.js";
import { createDefaultLabelers } from "./lib/db/event-labelers.js";
import { SqlRequestUsageStore } from "./lib/db/sql-request-usage-store.js";
import { SqlFederationStore } from "./lib/db/sql-federation-store.js";
import { SqlTenantProviderPolicyStore } from "./lib/db/sql-tenant-provider-policy-store.js";
import { SqlAuthPersistence } from "./lib/auth/sql-persistence.js";
import { RuntimeCredentialStore } from "./lib/runtime-credential-store.js";
import {
  createTokenRefreshRuntime,
} from "./lib/token-refresh-handlers.js";
import { DEFAULT_TENANT_ID } from "./lib/tenant-api-key.js";
import { createEnvFederationBridgeAgent } from "./lib/federation/bridge-agent-autostart.js";
import type { FederationBridgeRelay } from "./lib/federation/bridge-relay.js";
import { type AppDeps } from "./lib/app-deps.js";
import {
  executeFederatedRequestRouting,
} from "./lib/federation/federated-routing.js";
import {
  handleBridgeRequest,
  injectNativeBridge,
} from "./lib/federation/bridge-routing.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerResponsesRoutes } from "./routes/responses.js";
import { registerImagesRoutes } from "./routes/images.js";
import { registerMediaGenerationRoutes } from "./routes/media-generations.js";
import { registerWebsearchRoutes } from "./routes/websearch.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerEmbeddingsRoutes } from "./routes/embeddings.js";
import { registerNativeOllamaRoutes } from "./routes/native-ollama.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 300 * 1024 * 1024
  });

  kernels.installErrorHandler(app, { isOpenAiHttpError });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Proxx API",
        description: "OpenAI-compatible proxy with provider account rotation",
        version: "1.0.0",
      },
      servers: [{ url: `/` }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    staticCSP: true,
  });

  app.get("/api/v1/openapi.json", async (_request, reply) => {
    const swaggerJson = ((app as unknown) as { swagger: () => unknown }).swagger();
    return reply.header("content-type", "application/json").send(swaggerJson);
  });

  app.get("/api/docs", async (_request, reply) => {
    return reply.redirect("/docs");
  });

  let sql: Sql | undefined;
  let sqlCredentialStore: SqlCredentialStore | undefined;
  let sqlAuthPersistence: SqlAuthPersistence | undefined;
  let accountHealthStore: AccountHealthStore | undefined;
  let eventStore: EventStore | undefined;
  let sqlRequestUsageStore: SqlRequestUsageStore | undefined;
  let sqlFederationStore: SqlFederationStore | undefined;
  let sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;

  const plan = kernels.appWiringPlan(config);

  if (plan.database) {
    try {
      sql = createSqlConnection({ connectionString: config.databaseUrl! });
      app.log.info("connecting to database");

      const connection = sql;
      const storeInitializers: Record<string, { readonly init: () => Promise<void>; readonly reset?: () => void }> = {
        credential: {
          init: async () => {
            sqlCredentialStore = new SqlCredentialStore(connection, { defaultTenantId: DEFAULT_TENANT_ID });
            await sqlCredentialStore.init();
          },
        },
        accountHealth: {
          init: async () => {
            accountHealthStore = new AccountHealthStore(connection);
            await accountHealthStore.init();
          },
        },
        event: {
          init: async () => {
            eventStore = new EventStore(connection);
            await eventStore.init();
            for (const labeler of createDefaultLabelers()) {
              eventStore.registerLabeler(labeler);
            }
          },
        },
        requestUsage: {
          init: async () => {
            sqlRequestUsageStore = new SqlRequestUsageStore(connection);
            await sqlRequestUsageStore.init();
          },
        },
        federation: {
          init: async () => {
            sqlFederationStore = new SqlFederationStore(connection);
            await sqlFederationStore.init();
          },
          reset: () => { sqlFederationStore = undefined; },
        },
        tenantProviderPolicy: {
          init: async () => {
            sqlTenantProviderPolicyStore = new SqlTenantProviderPolicyStore(connection);
            await sqlTenantProviderPolicyStore.init();
          },
          reset: () => { sqlTenantProviderPolicyStore = undefined; },
        },
        authPersistence: {
          init: async () => {
            sqlAuthPersistence = new SqlAuthPersistence(connection);
            await sqlAuthPersistence.init();
          },
        },
      };

      for (const store of plan.storeInit) {
        const initializer = storeInitializers[store.id]!;
        if (store.required) {
          await initializer.init();
          app.log.info(store.started);
          continue;
        }
        try {
          await initializer.init();
          app.log.info(store.started);
        } catch (error) {
          initializer.reset?.();
          app.log.warn({ error: toErrorMessage(error) }, store.failed!);
        }
      }

      const removedLegacyOpenAiAccounts = await sqlCredentialStore!.cleanupLegacyOpenAiDuplicates();
      if (removedLegacyOpenAiAccounts > 0) {
        app.log.warn({ count: removedLegacyOpenAiAccounts }, "removed legacy duplicate OpenAI account rows after seeding");
      }

      app.log.info("database connection established");
    } catch (error) {
      app.log.error({ error: toErrorMessage(error) }, "failed to initialize database connection");
      throw error;
    }
  }

  const dynamicProviderBaseUrlGetter = createDynamicProviderBaseUrlGetter(sqlCredentialStore);

  const keyPool = new KeyPool({
    keysFilePath: config.keysFilePath,
    reloadIntervalMs: config.keyReloadMs,
    defaultCooldownMs: config.keyCooldownMs,
    defaultProviderId: config.upstreamProviderId,
    accountStore: sqlCredentialStore,
    cooldownStore: sqlCredentialStore,
    disabledStore: sqlCredentialStore,
    preferAccountStoreProviders: plan.preferAccountStoreProviders,
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
    join(dirname(config.requestLogsFilePath), plan.pheromoneFileName),
    config.promptAffinityFlushMs,
  );
  await providerRoutePheromoneStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(config.settingsFilePath, sql);
  await proxySettingsStore.warmup();

  if (getActiveCljsRuntime()) {
    app.log.info("CLJS policy router runtime boundary available");
  }

  const credentialStore = new CredentialStore(config.keysFilePath, config.upstreamProviderId);
  const runtimeCredentialStore = new RuntimeCredentialStore(credentialStore, sqlCredentialStore);
  const oauthManager = new OpenAiOAuthManager({
    oauthScopes: config.openaiOauthScopes,
    clientId: config.openaiOauthClientId,
    issuer: config.openaiOauthIssuer,
    clientSecret: config.openaiOauthClientSecret,
  });

  const {
    tokenRefreshManager,
    refreshExpiredOAuthAccount,
    refreshFactoryAccount,
    ensureFreshAccounts,
  } = createTokenRefreshRuntime({
    keyPool,
    runtimeCredentialStore,
    oauthManager,
    sqlCredentialStore,
    log: app.log,
    config: plan.tokenRefresh,
  });

  tokenRefreshManager.startBackgroundRefresh(() => {
    const expiring = keyPool.getExpiringAccounts(config.oauthRefreshProactiveWindowMs);
    const expired = keyPool.getAllExpiredWithRefreshTokens();
    return [...expired, ...expiring];
  });

  const refreshOpenAiOauthAccounts = kernels.createRefreshOpenAiOauthAccounts(keyPool, tokenRefreshManager, config.openaiProviderId);

  const quotaMonitor = new QuotaMonitor(
    runtimeCredentialStore,
    {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
    plan.quotaMonitor,
    accountHealthStore,
    keyPool,
  );
  quotaMonitor.start();

  const ollamaCatalogRoutes = buildOllamaCatalogRoutes(config);
  const providerCatalogRoutes = getDeclaredProviderRoutes(config).filter(
    (route) => route.providerId !== "factory" || plan.includeFactoryCatalogRoutes,
  );
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

  // Declared separately to allow closure capture before assignment
  // eslint-disable-next-line prefer-const
  let bridgeRelay: FederationBridgeRelay | undefined;

  async function getBridgeAdvertisedModelIds(): Promise<string[]> {
    if (!bridgeRelay) {
      return [];
    }

    const connectedSessions = bridgeRelay.listSessions().filter((session) => session.state === "connected");
    if (connectedSessions.length === 0) {
      return [];
    }

    // Prefer advertised capabilities when available (avoids fan-out overhead).
    // Fall back to /v1/models fan-out when capabilities are not yet advertised.
    const advertisedModels = kernels.advertisedModelIds(connectedSessions);
    if (advertisedModels.length > 0) {
      return advertisedModels;
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
    return kernels.mergeModelIds(localCatalog.modelIds, bridgedModels);
  }
  const fedDeps = { app, cljsPolicyManifestPath: config.cljsPolicyManifestPath, sqlFederationStore, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore };
  const getBridgeDeps = () => ({ bridgeRelay, app, config, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore });

  const bridgeAgent = createEnvFederationBridgeAgent({
    config,
    keyPool,
    credentialStore: runtimeCredentialStore,
    logger: app.log,
    getResolvedModelCatalog: () => getResolvedModelCatalog(false),
    handleBridgeRequest: (input) => handleBridgeRequest(getBridgeDeps(), input),
  });

  if (config.allowUnauthenticated) {
    app.log.warn("proxy auth disabled via PROXY_ALLOW_UNAUTHENTICATED=true");
  }

  kernels.installRequestHook(app, {
    config,
    sqlCredentialStore,
    sqlAuthPersistence,
    proxySettingsStore,
    requestLogStore,
    defaultTenantId: DEFAULT_TENANT_ID,
    cookieName: PROXY_AUTH_COOKIE_NAME,
  });

  // Attach a telemetry span to each request
  app.decorateRequest("_otelSpan", null);

  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS") return;
    const span = getTelemetry().startSpan("http.request", {
      "http.method": request.method,
      "http.path": (request.raw.url ?? request.url).split("?")[0],
    });
    request._otelSpan = span;
  });

  app.addHook("onResponse", async (request, reply) => {
    const span = request._otelSpan;
    if (!span) return;
    span.setAttribute("http.status_code", reply.statusCode);
    if (reply.statusCode >= 400) span.setStatus("error", `HTTP ${reply.statusCode}`);
    else span.setStatus("ok");
    span.end();
  });

  kernels.installPublicRoutes(app, (process.env.PROXY_WEB_PORT ?? "5174").trim() || "5174");

  const deps: AppDeps = {
    app, config, keyPool, credentialStore, runtimeCredentialStore,
    sqlCredentialStore, sqlFederationStore, sqlTenantProviderPolicyStore,
    accountHealthStore, eventStore, requestLogStore, promptAffinityStore, providerRoutePheromoneStore,
    proxySettingsStore,  providerCatalogStore, tokenRefreshManager,
    dynamicProviderBaseUrlGetter: dynamicProviderBaseUrlGetter
      ? async (id: string) => (await dynamicProviderBaseUrlGetter(id)) ?? undefined
      : async () => undefined, bridgeRelay, quotaMonitor,
    refreshExpiredOAuthAccount,
    refreshFactoryAccount,
    ensureFreshAccounts,
    getMergedModelIds,
    executeFederatedRequestRouting: async (input) => executeFederatedRequestRouting(fedDeps, input),
    injectNativeBridge: async (url, payload, headers) => injectNativeBridge(getBridgeDeps(), url, payload, headers),
  };

  registerHealthRoutes(deps, app);
  registerModelsRoutes(deps, app);
  registerWebsearchRoutes(deps, app);
  registerChatRoutes(deps, app);
  registerResponsesRoutes(deps, app);
  registerImagesRoutes(deps, app);
  registerMediaGenerationRoutes(deps, app);
  registerEmbeddingsRoutes(deps, app);
  registerNativeOllamaRoutes(deps, app);

  const { bridgeRelay: wsBridgeRelay } = await registerWebSocketRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore: runtimeCredentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    sqlRequestUsageStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
  });

  bridgeRelay = wsBridgeRelay;
  (deps as { bridgeRelay: FederationBridgeRelay | undefined }).bridgeRelay = wsBridgeRelay;

  await registerBridgeSseRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore: runtimeCredentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    sqlRequestUsageStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
  }, wsBridgeRelay);

  await registerRequestLogSseRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore: runtimeCredentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    sqlRequestUsageStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
  }, requestLogSseHub);

  await registerApiV1Routes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore: runtimeCredentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    sqlRequestUsageStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
    refreshOpenAiOauthAccounts,
    bridgeRelay: wsBridgeRelay,
  });

  // Legacy /api/ui analytics + request logs used by Knoxx admin.
  // NOTE: These routes are auth-gated by Proxx request auth middleware.
  await registerObservabilityRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore: runtimeCredentialStore,
    sqlCredentialStore,
    sqlFederationStore,
    sqlTenantProviderPolicyStore,
    sqlRequestUsageStore,
    authPersistence: sqlAuthPersistence,
    proxySettingsStore,
    eventStore,
  });

  app.get("/api/tags", async (_request, reply) => {
    try {
      reply.send(modelIdsToNativeTags(await getMergedModelIds()));
    } catch (error) {
      reply.code(500).send({ error: toErrorMessage(error) });
    }
  });

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

  kernels.installNotFoundHandler(app);

  if (bridgeAgent) {
    await bridgeAgent.start();
  }

  return app;
}
