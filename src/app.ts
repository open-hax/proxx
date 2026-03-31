import { dirname, join } from "node:path";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

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

import { KeyPool, type ProviderCredential } from "./lib/key-pool.js";
import { CredentialStore } from "./lib/credential-store.js";
import { OpenAiOAuthManager, isTerminalOpenAiRefreshError, type OAuthTokens } from "./lib/openai-oauth.js";
import {
  factoryCredentialNeedsRefresh,
  parseJwtExpiry,
  persistFactoryAuthV2,
  refreshFactoryOAuthToken,
} from "./lib/factory-auth.js";
import { ProviderCatalogStore } from "./lib/provider-catalog.js";
import { initializePolicyEngine, createPolicyEngine, type PolicyEngine } from "./lib/policy/index.js";
import { DEFAULT_POLICY_CONFIG } from "./lib/policy/index.js";
import {
  buildOllamaCatalogRoutes,
  parseModelIdsFromCatalogPayload,
  type ResolvedModelCatalog,
  buildProviderRoutesWithDynamicBaseUrls,
  createDynamicProviderBaseUrlGetter,
} from "./lib/provider-routing.js";
import { discoverDynamicOllamaRoutes, prependDynamicOllamaRoutes } from "./lib/dynamic-ollama-routes.js";
import {
  sendOpenAiError,
  toErrorMessage,
} from "./lib/provider-utils.js";
import { getTelemetry, type TelemetrySpan } from "./lib/telemetry/otel.js";
import { RequestLogStore } from "./lib/request-log-store.js";
import { PromptAffinityStore } from "./lib/prompt-affinity-store.js";
import { ProviderRoutePheromoneStore } from "./lib/provider-route-pheromone-store.js";
import { ProxySettingsStore } from "./lib/proxy-settings-store.js";
import { QuotaMonitor } from "./lib/quota-monitor.js";
import { registerUiRoutes } from "./lib/ui-routes.js";
import { registerApiV1Routes } from "./routes/api/v1/index.js";
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
import { seedFromJsonFile, seedFromJsonValue, seedFactoryAuthFromFiles, seedModelsFromFile } from "./lib/db/json-seeder.js";
import { RuntimeCredentialStore } from "./lib/runtime-credential-store.js";
import { TokenRefreshManager } from "./lib/token-refresh-manager.js";
import { DEFAULT_TENANT_ID } from "./lib/tenant-api-key.js";
import { resolveRequestAuth, type ResolvedRequestAuth } from "./lib/request-auth.js";
import { createEnvFederationBridgeAgent } from "./lib/federation/bridge-agent-autostart.js";
import type { FederationBridgeRelay } from "./lib/federation/bridge-relay.js";
import { type AppDeps } from "./lib/app-deps.js";
import {
  executeFederatedRequestFallback,
} from "./lib/federation/federated-fallback.js";
import {
  handleBridgeRequest,
  injectNativeBridge,
} from "./lib/federation/bridge-fallback.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerResponsesRoutes } from "./routes/responses.js";
import { registerImagesRoutes } from "./routes/images.js";
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
    const swaggerJson = app.swagger();
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

  if (config.databaseUrl) {
    try {
      sql = createSqlConnection({ connectionString: config.databaseUrl });
      app.log.info("connecting to database");

      sqlCredentialStore = new SqlCredentialStore(sql, { defaultTenantId: DEFAULT_TENANT_ID });
      await sqlCredentialStore.init();
      app.log.info("credential store initialized");

      accountHealthStore = new AccountHealthStore(sql);
      await accountHealthStore.init();
      app.log.info("account health store initialized");

      eventStore = new EventStore(sql);
      await eventStore.init();
      for (const labeler of createDefaultLabelers()) {
        eventStore.registerLabeler(labeler);
      }
      app.log.info("event store initialized");

      sqlRequestUsageStore = new SqlRequestUsageStore(sql);
      await sqlRequestUsageStore.init();
      app.log.info("request usage store initialized");

      try {
        sqlFederationStore = new SqlFederationStore(sql);
        await sqlFederationStore.init();
        app.log.info("federation store initialized");
      } catch (error) {
        sqlFederationStore = undefined;
        app.log.warn({ error: toErrorMessage(error) }, "failed to initialize federation store; continuing with federation disabled");
      }

      try {
        sqlTenantProviderPolicyStore = new SqlTenantProviderPolicyStore(sql);
        await sqlTenantProviderPolicyStore.init();
        app.log.info("tenant provider policy store initialized");
      } catch (error) {
        sqlTenantProviderPolicyStore = undefined;
        app.log.warn({ error: toErrorMessage(error) }, "failed to initialize tenant provider policy store; continuing with policy store disabled");
      }

      sqlAuthPersistence = new SqlAuthPersistence(sql);
      await sqlAuthPersistence.init();
      app.log.info("auth persistence initialized");

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

      // Seed Factory OAuth credentials from encrypted auth.v2 files into the DB.
      // Only imports on first boot when no factory accounts exist in the DB yet.
      try {
        const factorySeed = await seedFactoryAuthFromFiles(sql);
        if (factorySeed.seeded) {
          app.log.info("seeded Factory OAuth credentials from auth.v2 files into database");
        }
      } catch (error) {
        app.log.warn({ error: toErrorMessage(error) }, "failed to seed Factory OAuth credentials from auth.v2 files");
      }

      // Seed models from models.json into the DB (first boot only).
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
    preferAccountStoreProviders: sqlCredentialStore !== undefined,
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
  const promptAffinityStore = new PromptAffinityStore(
    config.promptAffinityFilePath,
    config.promptAffinityFlushMs,
  );
  await promptAffinityStore.warmup();
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

  const tokenRefreshManager = new TokenRefreshManager(
    async (credential) => {
      if (!credential.refreshToken) {
        return null;
      }

      // Factory OAuth credentials use WorkOS refresh, not OpenAI OAuth
      if (credential.providerId === "factory") {
        return refreshFactoryAccount(credential);
      }

      app.log.info({ accountId: credential.accountId, providerId: credential.providerId }, "refreshing expired OAuth token");

      let newTokens: OAuthTokens;
      try {
        newTokens = await oauthManager.refreshToken(credential.refreshToken);
      } catch (error) {
        if (isTerminalOpenAiRefreshError(error)) {
          const disabledCredential: ProviderCredential = {
            ...credential,
            refreshToken: undefined,
          };

          keyPool.updateAccountCredential(credential.providerId, credential, disabledCredential);
          if (typeof credential.expiresAt === "number" && credential.expiresAt <= Date.now()) {
            keyPool.markRateLimited(disabledCredential, 24 * 60 * 60 * 1000);
          }

          await runtimeCredentialStore.upsertOAuthAccount(
            credential.providerId,
            disabledCredential.accountId,
            disabledCredential.token,
            undefined,
            disabledCredential.expiresAt,
            disabledCredential.chatgptAccountId,
            undefined,
            undefined,
            disabledCredential.planType,
          );

          app.log.warn({
            accountId: credential.accountId,
            providerId: credential.providerId,
            code: error.code,
            status: error.status,
          }, "disabled terminally invalid OpenAI refresh token; full reauth required");
        }

        throw error;
      }

      const newCredential: ProviderCredential = {
        providerId: credential.providerId,
        accountId: newTokens.accountId,
        token: newTokens.accessToken,
        authType: "oauth_bearer",
        chatgptAccountId: newTokens.chatgptAccountId ?? credential.chatgptAccountId,
        planType: newTokens.planType,
        refreshToken: newTokens.refreshToken ?? credential.refreshToken,
        expiresAt: newTokens.expiresAt,
      };

      keyPool.updateAccountCredential(credential.providerId, credential, newCredential);

      await runtimeCredentialStore.upsertOAuthAccount(
        credential.providerId,
        newCredential.accountId,
        newCredential.token,
        newCredential.refreshToken,
        newCredential.expiresAt,
        newCredential.chatgptAccountId,
        newTokens.email,
        newTokens.subject,
        newTokens.planType,
      );

      app.log.info({
        accountId: newCredential.accountId,
        providerId: newCredential.providerId,
        expiresAt: newCredential.expiresAt,
      }, "OAuth token refreshed successfully");

      return newCredential;
    },
    app.log,
    {
      maxConcurrency: config.oauthRefreshMaxConcurrency,
      backgroundIntervalMs: config.oauthRefreshBackgroundIntervalMs,
      expiryBufferMs: 60_000,
      proactiveRefreshWindowMs: config.oauthRefreshProactiveWindowMs,
      maxConsecutiveFailures: 3,
    },
  );

  async function refreshExpiredOAuthAccount(credential: ProviderCredential): Promise<ProviderCredential | null> {
    return tokenRefreshManager.refresh(credential);
  }

  async function refreshFactoryAccount(credential: ProviderCredential): Promise<ProviderCredential | null> {
    if (!credential.refreshToken) {
      return null;
    }

    try {
      app.log.info({ accountId: credential.accountId, providerId: "factory" }, "refreshing Factory OAuth token via WorkOS");

      const refreshed = await refreshFactoryOAuthToken(credential.refreshToken);
      const expiresAt = refreshed.expiresAt ?? parseJwtExpiry(refreshed.accessToken) ?? undefined;

      const newCredential: ProviderCredential = {
        providerId: "factory",
        accountId: credential.accountId,
        token: refreshed.accessToken,
        authType: "oauth_bearer",
        refreshToken: refreshed.refreshToken,
        expiresAt,
      };

      // Update the credential in the KeyPool's in-memory state
      keyPool.updateAccountCredential("factory", credential, newCredential);

      // Persist to the credential store (file or SQL)
      await runtimeCredentialStore.upsertOAuthAccount(
        "factory",
        newCredential.accountId,
        newCredential.token,
        newCredential.refreshToken,
        newCredential.expiresAt,
      );

      if (!sqlCredentialStore) {
        try {
          await persistFactoryAuthV2(refreshed.accessToken, refreshed.refreshToken);
        } catch {
          // Expected to fail on read-only container filesystems; DB has the data.
        }
      }

      app.log.info({
        accountId: newCredential.accountId,
        providerId: "factory",
        expiresAt: newCredential.expiresAt,
      }, "Factory OAuth token refreshed successfully");

      return newCredential;
    } catch (error) {
      app.log.warn({
        error: toErrorMessage(error),
        accountId: credential.accountId,
        providerId: "factory",
      }, "failed to refresh Factory OAuth token");
      return null;
    }
  }

  async function ensureFreshAccounts(providerId: string): Promise<void> {
    const expiredAccounts = keyPool.getExpiredAccountsWithRefreshTokens(providerId);

    if (expiredAccounts.length > 0) {
      await tokenRefreshManager.refreshBatch(expiredAccounts);
    }

    // Factory OAuth: proactively refresh tokens within 30-min window (before they expire)
    if (providerId === "factory") {
      const allFactoryAccounts = await keyPool.getAllAccounts("factory").catch(() => [] as ProviderCredential[]);
      for (const account of allFactoryAccounts) {
        if (factoryCredentialNeedsRefresh(account)) {
          await tokenRefreshManager.refresh(account);
        }
      }
    }
  }

  const FEDERATION_OWNER_SUBJECT_HEADER = "x-open-hax-federation-owner-subject";
  const FEDERATION_BRIDGE_TENANT_HEADER = "x-open-hax-bridge-tenant-id";

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
    const consoleUrl = inferWebConsoleUrl(request);
    const safeConsoleUrl = escapeHtml(consoleUrl);
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Hax Proxy</title>
    <style>
      body { font-family: "IBM Plex Sans", "Fira Sans", sans-serif; background: radial-gradient(circle at top, #12313b 0%, #0b161c 60%); color: #e9f7fb; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      .card { background: rgba(17, 33, 42, 0.9); border: 1px solid rgba(145, 212, 232, 0.35); padding: 28px; border-radius: 14px; width: min(680px, 92vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }
      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }
      p { margin: 0 0 10px 0; color: #bce2ec; line-height: 1.5; }
      code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; }
      a { color: #9be7ff; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
      .button { display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border-radius: 10px; background: #10313d; border: 1px solid rgba(145, 212, 232, 0.35); color: #e9f7fb; text-decoration: none; }
      .button.secondary { background: transparent; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Open Hax OpenAI Proxy</h1>
      <p>This port serves the proxy API and OAuth callback surface. The operator web console lives on a separate port.</p>
      <p>You can open the console without an API token, then paste the frontend bearer token into the <code>Proxy Token</code> field there.</p>
      <div class="actions">
        <a class="button" href="${safeConsoleUrl}">Open web console</a>
        <a class="button secondary" href="/health">View health</a>
      </div>
    </section>
  </body>
</html>`;
  }



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
      if (account.authType !== "oauth_bearer") {
        return false;
      }

      if (typeof account.refreshToken !== "string" || account.refreshToken.trim().length === 0) {
        return false;
      }

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

  tokenRefreshManager.startBackgroundRefresh(() => {
    const expiring = keyPool.getExpiringAccounts(config.oauthRefreshProactiveWindowMs);
    const expired = keyPool.getAllExpiredWithRefreshTokens();
    return [...expired, ...expiring];
  });

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
    keyPool,
  );
  quotaMonitor.start();

  const bootstrapOwnerSubject = process.env.FEDERATION_DEFAULT_OWNER_SUBJECT?.trim() || undefined;
  const federatedDynamicOllamaRoutes = await discoverDynamicOllamaRoutes(
    sqlCredentialStore,
    sqlFederationStore,
    bootstrapOwnerSubject,
  );
  const ollamaCatalogRoutes = prependDynamicOllamaRoutes(
    buildOllamaCatalogRoutes(config),
    federatedDynamicOllamaRoutes,
  );
  const providerCatalogRoutes = prependDynamicOllamaRoutes(
    (await buildProviderRoutesWithDynamicBaseUrls(config, false, dynamicProviderBaseUrlGetter, true))
      .filter((route) => route.providerId !== "factory" || !config.disabledProviderIds.includes("factory")),
    federatedDynamicOllamaRoutes,
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

    // Fallback: fan-out /v1/models to each connected session when capabilities not advertised
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
  const fedDeps = { app, sqlFederationStore, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore };
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

  type DecoratedAppRequest = FastifyRequest & {
    openHaxAuth: ResolvedRequestAuth | null;
    _otelSpan: TelemetrySpan | null;
  };

  app.decorateRequest("openHaxAuth", null);

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
    const allowUnauthenticatedRoute = rawPath === "/" || rawPath === "/favicon.ico" || rawPath === "/health" || rawPath === "/api/ui/credentials/openai/oauth/browser/callback" || rawPath === "/api/v1/credentials/openai/oauth/browser/callback"
      || rawPath === "/auth/callback" || rawPath === "/auth/factory/callback"
      || rawPath === config.githubOAuthCallbackPath || rawPath === "/auth/login"
      || rawPath === "/auth/refresh" || rawPath === "/auth/logout";
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
      resolveUiSession: allowUiSessionAuth && sqlCredentialStore && sqlAuthPersistence
        ? async (token) => {
          const accessToken = await sqlAuthPersistence.getAccessToken(token);
          if (!accessToken) {
            return undefined;
          }

          const activeTenantId = typeof accessToken.extra?.activeTenantId === "string"
            ? accessToken.extra.activeTenantId
            : undefined;
          return sqlCredentialStore.resolveUiSession(accessToken.subject, activeTenantId);
        }
        : undefined,
    });

    if (!resolvedAuth) {
      sendOpenAiError(reply, 401, "Unauthorized", "invalid_request_error", "unauthorized");
      return;
    }

    decoratedRequest.openHaxAuth = resolvedAuth;

    const enforceTenantQuotaRoute = request.method === "POST" && (
      rawPath === "/v1/chat/completions"
      || rawPath === "/v1/responses"
      || rawPath === "/v1/images/generations"
      || rawPath === "/v1/embeddings"
    );

    if (enforceTenantQuotaRoute && resolvedAuth.kind !== "unauthenticated") {
      const tenantId = resolvedAuth.tenantId ?? DEFAULT_TENANT_ID;
      const tenantSettings = await proxySettingsStore.getForTenant(tenantId);
      if (typeof tenantSettings.requestsPerMinute === "number" && tenantSettings.requestsPerMinute > 0) {
        const now = Date.now();
        const recentRequestCount = requestLogStore.countRequestsSince(now - 60_000, { tenantId });
        if (recentRequestCount >= tenantSettings.requestsPerMinute) {
          reply.header("retry-after", 60);
          sendOpenAiError(
            reply,
            429,
            `Tenant request quota exceeded for ${tenantId}. Allowed requests per minute: ${tenantSettings.requestsPerMinute}.`,
            "rate_limit_error",
            "tenant_quota_exceeded",
          );
          return;
        }
      }
    }

    if (
      resolvedAuth.kind === "tenant_api_key"
      && sqlCredentialStore
      && request.method === "POST"
      && rawPath.startsWith("/v1/")
      && resolvedAuth.tenantId
      && resolvedAuth.keyId
    ) {
      await sqlCredentialStore.touchTenantApiKeyLastUsed(resolvedAuth.tenantId, resolvedAuth.keyId);
    }
  });

  // Attach a telemetry span to each request
  app.decorateRequest("_otelSpan", null);

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

  app.options("/", async (_request, reply) => {
    reply.code(204).send();
  });

  app.get("/", async (request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    reply.send(renderPublicLandingPage(request));
  });

  app.get("/favicon.ico", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/health", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/chat/completions", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/responses", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/images/generations", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/embeddings", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/models", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/models/:model", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/chat", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/generate", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/embed", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/embeddings", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/tags", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/ui", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/ui/*", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/v1", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/v1/*", async (_request, reply) => {
    reply.code(204).send();
  });

  const deps: AppDeps = {
    app, config, keyPool, credentialStore, runtimeCredentialStore,
    sqlCredentialStore, sqlFederationStore, sqlTenantProviderPolicyStore,
    accountHealthStore, eventStore, requestLogStore, promptAffinityStore, providerRoutePheromoneStore,
    proxySettingsStore, policyEngine, providerCatalogStore, tokenRefreshManager,
    dynamicProviderBaseUrlGetter: dynamicProviderBaseUrlGetter
      ? async (id: string) => (await dynamicProviderBaseUrlGetter(id)) ?? undefined
      : async () => undefined, bridgeRelay, quotaMonitor,
    refreshFactoryAccount: async (c) => { await refreshFactoryAccount(c as never); },
    ensureFreshAccounts,
    refreshExpiredOAuthAccount: async (c) => await refreshExpiredOAuthAccount(c as never),
    getMergedModelIds,
    executeFederatedRequestFallback: async (input) => executeFederatedRequestFallback(fedDeps, input),
    injectNativeBridge: async (url, payload, headers) => injectNativeBridge(getBridgeDeps(), url, payload, headers),
  };

  registerHealthRoutes(deps, app);
  registerModelsRoutes(deps, app);
  registerWebsearchRoutes(deps, app);
  registerChatRoutes(deps, app);
  registerResponsesRoutes(deps, app);
  registerImagesRoutes(deps, app);
  registerEmbeddingsRoutes(deps, app);
  registerNativeOllamaRoutes(deps, app);

  const uiBridgeRelay = await registerUiRoutes(app, {
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
  });

  bridgeRelay = uiBridgeRelay;
  (deps as { bridgeRelay: FederationBridgeRelay | undefined }).bridgeRelay = uiBridgeRelay;

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
    bridgeRelay: uiBridgeRelay,
  });

  app.get("/api/tags", async (_request, reply) => {
    try {
      reply.send(modelIdsToNativeTags(await getMergedModelIds()));
    } catch (error) {
      reply.code(500).send({ error: toErrorMessage(error) });
    }
  });

  if (bridgeAgent) {
    await bridgeAgent.start();
  }

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
        "unsupported_endpoint"
      );
      return;
    }

    if (path.startsWith("/api/v1/")) {
      sendOpenAiError(
        reply,
        404,
        `Unsupported endpoint: ${request.method} ${path}. Supported API v1 endpoints begin with /api/v1 and are routed through the canonical control surface.`,
        "invalid_request_error",
        "unsupported_endpoint"
      );
      return;
    }

    if (path.startsWith("/api/")) {
      reply.code(404).send({
        error: `Unsupported endpoint: ${request.method} ${path}. Supported native endpoints: ${SUPPORTED_NATIVE_OLLAMA_ENDPOINTS.join(", ")}`
      });
      return;
    }

    reply.code(404).send({ ok: false, error: "Not Found" });
  });

  return app;
}
