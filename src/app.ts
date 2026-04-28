import { Readable } from "node:stream";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { DEFAULT_MODELS, type ProxyConfig } from "./lib/config.js";
import {
  PROXY_AUTH_COOKIE_NAME,
  readCookieToken,
  extractPromptCacheKey,
  hashPromptCacheKey,
  summarizeResponsesRequestBody,
  joinUrl,
  parseJsonIfPossible,
  readSingleHeader,
  escapeHtml,
  normalizeRequestedModel,
  isTrustedLocalBridgeAddress,
  copyInjectedResponseHeaders,
  SUPPORTED_V1_ENDPOINTS,
  SUPPORTED_NATIVE_OLLAMA_ENDPOINTS,
  type ChatCompletionRequest,
  type WebSearchToolRequest,
} from "./lib/request-utils.js";
import { extractResponseTextAndUrlCitations, extractMarkdownLinks } from "./lib/response-utils.js";
import {
  tenantProviderAllowed,
  filterTenantProviderRoutes,
  resolveExplicitTenantProviderId,
} from "./lib/tenant-policy-helpers.js";
import {
  resolvableConcreteModelIds,
  resolvableConcreteModelIdsForProviders,
  openAiProviderUsesCodexSurface,
  providerRouteSupportsModel,
  filterProviderRoutesByModelSupport,
  shouldRejectModelFromProviderCatalog,
} from "./lib/model-routing-helpers.js";
import {
  bridgeCapabilitySupportsPath,
  bridgeCapabilitySupportsModel,
  appendBridgeResponseHeaders,
  decodeBridgeResponseChunk,
} from "./lib/bridge-helpers.js";
import {
  extractPeerCredential,
  fetchFederationJson,
  resolveFederationHopCount,
  resolveFederationOwnerSubject,
} from "./lib/federation/federation-helpers.js";

import { KeyPool, type ProviderCredential } from "./lib/key-pool.js";
import { CredentialStore } from "./lib/credential-store.js";
import { OpenAiOAuthManager } from "./lib/openai-oauth.js";
import {
  factoryCredentialNeedsRefresh,
} from "./lib/factory-auth.js";
import { ProviderCatalogStore } from "./lib/provider-catalog.js";
import { initializePolicyEngine, createPolicyEngine, type PolicyEngine } from "./lib/policy/index.js";
import { DEFAULT_POLICY_CONFIG } from "./lib/policy/index.js";
import {
  buildOllamaCatalogRoutes,
  filterResponsesApiRoutes,
  filterImagesApiRoutes,
  minMsUntilAnyProviderKeyReady,
  parseModelIdsFromCatalogPayload,
  resolveProviderRoutesForModel,
  type ProviderRoute,
  type ResolvedModelCatalog,
  buildProviderRoutesWithDynamicBaseUrls,
  createDynamicProviderBaseUrlGetter,
} from "./lib/provider-routing.js";
import { discoverDynamicOllamaRoutes } from "./lib/dynamic-ollama-routes.js";
import {
  sendOpenAiError,
} from "./lib/provider-utils.js";
import { toErrorMessage } from "./lib/errors/index.js";
import { getTelemetry } from "./lib/telemetry/otel.js";
import { RequestLogStore } from "./lib/request-log-store.js";
import { SqlPromptAffinityStore } from "./lib/db/sql-prompt-affinity-store.js";
import { ProviderRoutePheromoneStore } from "./lib/provider-route-pheromone-store.js";
import { ProxySettingsStore } from "./lib/proxy-settings-store.js";
import { QuotaMonitor } from "./lib/quota-monitor.js";
import { registerUiRoutes } from "./lib/ui-routes.js";
import { registerApiV1Routes } from "./routes/api/v1/index.js";
import {
  ensureOllamaContextFits,
} from "./lib/ollama-context.js";
import {
  chatCompletionToNativeChat,
  chatCompletionToNativeGenerate,
  modelIdsToNativeTags,
  nativeChatToOpenAiRequest,
  nativeEmbedResponseToOpenAiEmbeddings,
  nativeEmbedToOpenAiRequest,
  nativeGenerateToChatRequest,
  openAiEmbeddingsToNativeEmbed,
  openAiEmbeddingsToNativeEmbeddings,
} from "./lib/ollama-native.js";
import { shouldUseResponsesUpstream } from "./lib/responses-compat.js";
import { applyNativeOllamaAuth } from "./lib/native-auth.js";
import { requestHasExplicitNumCtx } from "./lib/ollama-compat.js";
import { createSqlConnection, closeConnection, type Sql } from "./lib/db/index.js";
import { SqlCredentialStore } from "./lib/db/sql-credential-store.js";
import { AccountHealthStore } from "./lib/db/account-health-store.js";
import { EventStore } from "./lib/db/event-store.js";
import { createDefaultLabelers } from "./lib/db/event-labelers.js";
import { SqlRequestUsageStore } from "./lib/db/sql-request-usage-store.js";
import { SqlFederationStore, shouldWarmImportProjectedAccount, type FederationPeerRecord, type FederationProjectedAccountRecord } from "./lib/db/sql-federation-store.js";
import { SqlTenantProviderPolicyStore } from "./lib/db/sql-tenant-provider-policy-store.js";
import { SqlAuthPersistence } from "./lib/auth/sql-persistence.js";
import { SqlGitHubAllowlist } from "./lib/auth/github-allowlist.js";
import { seedFromJsonFile, seedFromJsonValue, seedFactoryAuthFromFiles, seedModelsFromFile } from "./lib/db/json-seeder.js";
import { registerOAuthRoutes } from "./lib/oauth-routes.js";
import { isAutoModel, rankAutoModels } from "./lib/auto-model-selector.js";
import { RuntimeCredentialStore } from "./lib/runtime-credential-store.js";
import { TokenRefreshManager } from "./lib/token-refresh-manager.js";
import { DEFAULT_TENANT_ID } from "./lib/tenant-api-key.js";
import { resolveRequestAuth } from "./lib/request-auth.js";
import { createEnvFederationBridgeAgent } from "./lib/federation/bridge-agent-autostart.js";
import type { BridgeRelayResponseEvent, FederationBridgeRelay } from "./lib/federation/bridge-relay.js";

interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages?: unknown;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}

const PROXY_AUTH_COOKIE_NAME = "open_hax_proxy_auth_token";

function readCookieToken(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) {
      continue;
    }

    const rawValue = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}

function extractPromptCacheKey(body: Record<string, unknown>): string | undefined {
  const raw = typeof body.prompt_cache_key === "string"
    ? body.prompt_cache_key
    : typeof body.promptCacheKey === "string"
      ? body.promptCacheKey
      : undefined;
  const normalized = raw?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function hashPromptCacheKey(promptCacheKey: string): string {
  const trimmed = promptCacheKey.trim();
  if (trimmed.length === 0) {
    return "<REDACTED>";
  }

  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

function summarizeResponsesRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (typeof body.model === "string" && body.model.trim().length > 0) {
    summary.model = body.model;
  }

  if (typeof body.stream === "boolean") {
    summary.stream = body.stream;
  }

  if (typeof body.max_output_tokens === "number" && Number.isFinite(body.max_output_tokens)) {
    summary.max_output_tokens = body.max_output_tokens;
  }

  const input = body.input;
  if (typeof input === "string") {
    summary.input = { kind: "text", length: input.length, preview: input.slice(0, 200) };
    return summary;
  }

  if (!Array.isArray(input)) {
    summary.input = { kind: typeof input };
    return summary;
  }

  let textChars = 0;
  let firstTextPreview: string | undefined;
  let imageCount = 0;

  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }

    const content = item.content;
    if (typeof content === "string") {
      textChars += content.length;
      if (firstTextPreview === undefined && content.length > 0) {
        firstTextPreview = content.slice(0, 200);
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }

      const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
      const text = typeof part.text === "string" ? part.text : undefined;

      if (text) {
        textChars += text.length;
        if (firstTextPreview === undefined && text.length > 0) {
          firstTextPreview = text.slice(0, 200);
        }
      }

      if (partType.includes("image") || part.image_url !== undefined || part.imageUrl !== undefined) {
        imageCount += 1;
      }
    }
  }

  summary.input = {
    kind: "structured",
    itemCount: input.length,
    textChars,
    textPreview: firstTextPreview,
    imageCount,
  };

  return summary;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // Avoid accidental `/v1/v1/...` joins when the provider base URL already includes the OpenAI version segment.
  const baseLower = normalizedBase.toLowerCase();
  const pathLower = normalizedPath.toLowerCase();
  if (pathLower.startsWith("/v1/") && baseLower.endsWith("/v1")) {
    normalizedPath = normalizedPath.slice(3);
  }

  return `${normalizedBase}${normalizedPath}`;
}

function parseJsonIfPossible(body: string): unknown {
  if (body.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function copyInjectedResponseHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "undefined" || name.toLowerCase() === "content-length") {
      continue;
    }

    reply.header(name, value);
  }
}

const SUPPORTED_V1_ENDPOINTS = [
  "POST /v1/chat/completions",
  "POST /v1/responses",
  "POST /v1/images/generations",
  "POST /v1/embeddings",
  "GET /v1/models",
  "GET /v1/models/:model"
] as const;

const SUPPORTED_NATIVE_OLLAMA_ENDPOINTS = [
  "POST /api/chat",
  "POST /api/generate",
  "POST /api/embed",
  "POST /api/embeddings",
  "GET /api/tags"
] as const;

export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 300 * 1024 * 1024
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

      sqlFederationStore = new SqlFederationStore(sql);
      await sqlFederationStore.init();
      app.log.info("federation store initialized");

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
          await access(config.keysFilePath);
          const seedResult = await seedFromJsonFile(sql, config.keysFilePath, config.upstreamProviderId, {
            skipExistingProviders: true,
          });
          app.log.info({ providers: seedResult.providers, accounts: seedResult.accounts }, "seeded credentials from json file");
        } catch (error) {
          const message = toErrorMessage(error).toLowerCase();
          if (message.includes("enoent") || message.includes("no such file")) {
            app.log.info({ keysFilePath: config.keysFilePath }, "credential seed file missing; continuing with database and env-backed providers only");
          } else {
            app.log.warn({ error: toErrorMessage(error) }, "failed to seed credentials from json file; continuing with existing data");
          }
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

  const tokenRefreshManager = createTokenRefreshManager({
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

  const FEDERATION_OWNER_SUBJECT_HEADER = "x-open-hax-federation-owner-subject";
  const FEDERATION_BRIDGE_TENANT_HEADER = "x-open-hax-bridge-tenant-id";

  tokenRefreshManager.startBackgroundRefresh(() => {
    const expiring = keyPool.getExpiringAccounts(config.oauthRefreshProactiveWindowMs);
    const expired = keyPool.getAllExpiredWithRefreshTokens();
    return [...expired, ...expiring];
  });

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
  const providerCatalogRoutes = (await buildProviderRoutesWithDynamicBaseUrls(config, false, dynamicProviderBaseUrlGetter, true))
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

  const legacyBridgePathPrefixes = [
    "/v1/chat/completions",
    "/v1/models",
    "/v1/responses",
    "/v1/embeddings",
    "/v1/images/generations",
  ] as const;

  function bridgeCapabilitySupportsPath(capability: {
    readonly paths?: readonly string[];
    readonly routes?: readonly string[];
    readonly supportsModelsList?: boolean;
    readonly supportsChatCompletions?: boolean;
    readonly supportsResponses?: boolean;
  }, normalizedPath: string): boolean {
    const advertisedRoutes = [...(capability.paths ?? []), ...(capability.routes ?? [])]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (advertisedRoutes.length > 0) {
      return advertisedRoutes.some((prefix) => normalizedPath.startsWith(prefix));
    }

    if (normalizedPath.startsWith("/v1/models")) {
      return capability.supportsModelsList === true;
    }
    if (normalizedPath.startsWith("/v1/chat/completions")) {
      return capability.supportsChatCompletions === true;
    }
    if (normalizedPath.startsWith("/v1/responses")) {
      return capability.supportsResponses === true;
    }

    const hasStructuredCapabilityHints = capability.supportsModelsList !== undefined
      || capability.supportsChatCompletions !== undefined
      || capability.supportsResponses !== undefined;

    return !hasStructuredCapabilityHints
      && legacyBridgePathPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
  }

  function appendBridgeResponseHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === "content-length") {
        continue;
      }
      reply.header(name, value);
    }
  }

  function decodeBridgeResponseChunk(event: Extract<BridgeRelayResponseEvent, { readonly type: "response_chunk" }>): Buffer {
    return event.encoding === "base64"
      ? Buffer.from(event.chunk, "base64")
      : Buffer.from(event.chunk, "utf8");
  }

  async function executeBridgeRequestFallback(input: {
    readonly requestHeaders: Record<string, unknown>;
    readonly requestBody: Record<string, unknown>;
    readonly requestAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string };
    readonly upstreamPath: string;
    readonly reply: FastifyReply;
    readonly timeoutMs: number;
  }): Promise<boolean> {
    if (!bridgeRelay) {
      return false;
    }

    // Reject multi-hop bridge routing to prevent request loops
    const hopCount = resolveFederationHopCount(input.requestHeaders);
    if (hopCount >= 1) {
      app.log.warn({ hopCount, upstreamPath: input.upstreamPath }, "bridge request rejected: hop limit exceeded");
      return false;
    }

    const ownerSubject = resolveFederationOwnerSubject({
      headers: input.requestHeaders,
      requestAuth: input.requestAuth,
      hopCount,
    });
    if (!ownerSubject) {
      return false;
    }

    // Filter connected sessions by advertised capability for the requested path
    const normalizedPath = input.upstreamPath.split("?")[0]!;
    const connectedSessions = bridgeRelay.listSessions()
      .filter((session) => session.state === "connected")
      .filter((session) => session.ownerSubject === ownerSubject)
      .filter((session) => {
        const hasCapability = session.capabilities.some((cap) => bridgeCapabilitySupportsPath(cap, normalizedPath));
        return hasCapability;
      });
    if (connectedSessions.length === 0) {
      return false;
    }

    const bodyText = JSON.stringify(input.requestBody);

    for (const session of connectedSessions) {
      let responseStarted = false;
      let rawResponse: typeof input.reply.raw | undefined;
      try {
        const responseEvents = bridgeRelay.requestStream(session.sessionId, {
          method: "POST",
          path: input.upstreamPath,
          timeoutMs: input.timeoutMs,
          headers: {
            accept: typeof input.requestHeaders.accept === "string" ? input.requestHeaders.accept : "application/json",
            "content-type": "application/json",
          },
          body: bodyText,
        });

        let sawHead = false;
        let isStreaming = false;
        let responseHeaders: Readonly<Record<string, string>> = {};
        const bufferedChunks: Buffer[] = [];

        for await (const event of responseEvents) {
          switch (event.type) {
            case "response_head": {
              sawHead = true;
              responseStarted = true;
              responseHeaders = event.headers;
              appendBridgeResponseHeaders(input.reply, event.headers);
              input.reply.header(FEDERATION_OWNER_SUBJECT_HEADER, ownerSubject);
              input.reply.header(FEDERATION_ROUTED_PEER_HEADER, `bridge:${session.clusterId}:${session.agentId}`);
              input.reply.code(event.status);

              const contentType = event.headers["content-type"] ?? event.headers["Content-Type"] ?? "";
              isStreaming = typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
              if (isStreaming) {
                input.reply.removeHeader("content-length");
                input.reply.header("cache-control", "no-cache");
                input.reply.header("x-accel-buffering", "no");
                input.reply.header("content-type", "text/event-stream; charset=utf-8");
                input.reply.hijack();
                rawResponse = input.reply.raw;
                rawResponse.statusCode = event.status;
                for (const [name, value] of Object.entries(input.reply.getHeaders())) {
                  if (value !== undefined) {
                    rawResponse.setHeader(name, value as never);
                  }
                }
                rawResponse.flushHeaders();
              }
              break;
            }
            case "response_chunk": {
              if (!sawHead) {
                sawHead = true;
                responseStarted = true;
                input.reply.header(FEDERATION_OWNER_SUBJECT_HEADER, ownerSubject);
                input.reply.header(FEDERATION_ROUTED_PEER_HEADER, `bridge:${session.clusterId}:${session.agentId}`);
                input.reply.code(200);
              }

              const chunk = decodeBridgeResponseChunk(event);
              if (isStreaming && rawResponse) {
                rawResponse.write(chunk);
              } else {
                bufferedChunks.push(chunk);
              }
              break;
            }
            case "response_end":
              break;
            default:
              break;
          }
        }

        if (isStreaming && rawResponse) {
          if (!rawResponse.writableEnded) {
            rawResponse.end();
          }
          return true;
        }

        const responseBody = Buffer.concat(bufferedChunks).toString("utf8");
        const contentType = responseHeaders["content-type"] ?? responseHeaders["Content-Type"] ?? "";
        const parsed = typeof contentType === "string" && contentType.toLowerCase().includes("application/json")
          ? parseJsonIfPossible(responseBody)
          : undefined;
        if (parsed !== undefined) {
          input.reply.send(parsed);
        } else {
          input.reply.send(responseBody);
        }
        return true;
      } catch (error) {
        if (rawResponse && !rawResponse.writableEnded) {
          rawResponse.end();
        }
        app.log.warn({ error: toErrorMessage(error), sessionId: session.sessionId, upstreamPath: input.upstreamPath }, "bridged request attempt failed");
        if (responseStarted) {
          return true;
        }
      }
    }

    return false;
  }

  const handleBridgeRequest = async (input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string;
    readonly ownerSubject: string;
  }): ReturnType<NonNullable<Parameters<typeof createEnvFederationBridgeAgent>[0]["handleBridgeRequest"]>> => {
    // Security: restrict bridge requests to allowed API paths only.
    // This prevents the bridge from acting as a privileged generic proxy
    // that could access internal routes like /api/ui/federation/accounts.
    const allowedBridgePaths = [
      "/v1/chat/completions",
      "/v1/models",
      "/v1/responses",
      "/v1/embeddings",
      "/v1/images/generations",
    ];
    const normalizedPath = input.path.split("?")[0]!;
    if (!allowedBridgePaths.some((prefix) => normalizedPath.startsWith(prefix))) {
      app.log.warn({ path: input.path, ownerSubject: input.ownerSubject }, "bridge request rejected: path not in allowed list");
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: { message: "Bridge requests are restricted to model API paths", type: "invalid_request_error" } }),
        servedByClusterId: process.env.FEDERATION_SELF_CLUSTER_ID?.trim(),
        servedByGroupId: process.env.FEDERATION_SELF_GROUP_ID?.trim(),
        servedByNodeId: process.env.FEDERATION_SELF_NODE_ID?.trim(),
      };
    }

    const headers: Record<string, string> = {
      accept: input.headers.accept ?? "application/json",
      // Use a dedicated bridge identity header instead of the global admin token.
      // This prevents the bridge from becoming a privileged proxy with admin access.
      "x-open-hax-bridge-auth": "internal",
      [FEDERATION_HOP_HEADER]: "1",
      [FEDERATION_OWNER_SUBJECT_HEADER]: input.ownerSubject,
    };
    if (typeof input.headers["content-type"] === "string") {
      headers["content-type"] = input.headers["content-type"];
    }

    const appAddress = app.server.address();
    if (appAddress && typeof appAddress !== "string") {
      const response = await fetch(`http://127.0.0.1:${appAddress.port}${input.path}`, {
        method: input.method,
        headers,
        body: input.bodyText.length > 0 ? input.bodyText : undefined,
      });

      return (async function* () {
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of response.headers.entries()) {
          responseHeaders[name] = value;
        }

        const providerId = responseHeaders["x-open-hax-upstream-provider"];
        const servedByClusterId = process.env.FEDERATION_SELF_CLUSTER_ID?.trim();
        const servedByGroupId = process.env.FEDERATION_SELF_GROUP_ID?.trim();
        const servedByNodeId = process.env.FEDERATION_SELF_NODE_ID?.trim();

        yield {
          type: "response_head" as const,
          status: response.status,
          headers: responseHeaders,
          servedByClusterId,
          servedByGroupId,
          servedByNodeId,
          providerId,
        };

        if (!response.body) {
          yield {
            type: "response_end" as const,
            servedByClusterId,
            servedByGroupId,
            servedByNodeId,
            providerId,
          };
          return;
        }

        const contentType = (response.headers.get("content-type") ?? "").trim().toLowerCase();
        const encodeAsUtf8 = contentType.length === 0
          || contentType.startsWith("text/")
          || contentType.includes("json")
          || contentType.includes("xml")
          || contentType.includes("javascript")
          || contentType.includes("event-stream");
        const decoder = encodeAsUtf8 ? new TextDecoder("utf8") : undefined;
        const reader = response.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value || value.length === 0) {
            continue;
          }

          if (decoder) {
            const chunk = decoder.decode(value, { stream: true });
            if (chunk.length > 0) {
              yield {
                type: "response_chunk" as const,
                chunk,
                encoding: "utf8" as const,
                servedByClusterId,
                servedByGroupId,
                servedByNodeId,
                providerId,
              };
            }
            continue;
          }

          yield {
            type: "response_chunk" as const,
            chunk: Buffer.from(value).toString("base64"),
            encoding: "base64" as const,
            servedByClusterId,
            servedByGroupId,
            servedByNodeId,
            providerId,
          };
        }

        if (decoder) {
          const tail = decoder.decode();
          if (tail.length > 0) {
            yield {
              type: "response_chunk" as const,
              chunk: tail,
              encoding: "utf8" as const,
              servedByClusterId,
              servedByGroupId,
              servedByNodeId,
              providerId,
            };
          }
        }

        yield {
          type: "response_end" as const,
          servedByClusterId,
          servedByGroupId,
          servedByNodeId,
          providerId,
        };
      })();
    }

    const injected = await app.inject({
      method: input.method as "GET" | "POST",
      url: input.path,
      headers,
      payload: input.bodyText.length > 0 ? input.bodyText : undefined,
    });

    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(injected.headers)) {
      if (typeof value === "string") {
        responseHeaders[name] = value;
      }
    }

    const provenance = {
      servedByClusterId: process.env.FEDERATION_SELF_CLUSTER_ID?.trim(),
      servedByGroupId: process.env.FEDERATION_SELF_GROUP_ID?.trim(),
      servedByNodeId: process.env.FEDERATION_SELF_NODE_ID?.trim(),
      providerId: responseHeaders["x-open-hax-upstream-provider"],
    };

    return {
      status: injected.statusCode,
      headers: responseHeaders,
      body: injected.body,
      encoding: "utf8",
      ...provenance,
    };
  };

  const bridgeAgent = createEnvFederationBridgeAgent({
    config,
    keyPool,
    credentialStore: runtimeCredentialStore,
    logger: app.log,
    getResolvedModelCatalog: () => getResolvedModelCatalog(false),
    handleBridgeRequest,
  });

  function shouldRejectModelFromProviderCatalog(
    providerRoutes: readonly ProviderRoute[],
    routedModel: string,
    catalogBundle: ResolvedCatalogWithPreferences,
  ): boolean {
    let sawCatalogForCandidate = false;

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



  const bridgeAgent = createEnvFederationBridgeAgent({
    config,
    keyPool,
    credentialStore: runtimeCredentialStore,
    logger: app.log,
    getResolvedModelCatalog: () => getResolvedModelCatalog(false),
    handleBridgeRequest: (input) => handleBridgeRequest(bridgeDeps, input),
  });


  const fedDeps = { app, sqlFederationStore, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore };
  const bridgeDeps = { bridgeRelay, app, config, runtimeCredentialStore, keyPool, sqlTenantProviderPolicyStore };

  if (config.allowUnauthenticated) {
    app.log.warn("proxy auth disabled via PROXY_ALLOW_UNAUTHENTICATED=true");
  }

  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request, reply) => {
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

    // Allow internal bridge requests via dedicated header (no admin token required)
    const bridgeAuthHeader = request.headers["x-open-hax-bridge-auth"];
    if (bridgeAuthHeader === "internal" && request.headers[FEDERATION_OWNER_SUBJECT_HEADER]) {
      // Bridge internal request - authenticate as legacy_admin equivalent for model API routes
      (request as any).openHaxAuth = {
        kind: "legacy_admin",
        subject: String(request.headers[FEDERATION_OWNER_SUBJECT_HEADER]),
      };
      return;
    }

    const resolvedAuth = await resolveRequestAuth({
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

    request.openHaxAuth = resolvedAuth;

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

  const OPTIONS_PATHS = [
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
  ];
  for (const path of OPTIONS_PATHS) {
    app.options(path, async (_request, reply) => { reply.code(204).send(); });
  }

  app.get("/", async (request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    reply.send(renderPublicLandingPage(request));
  });

  app.get("/favicon.ico", async (_request, reply) => {
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

  app.options("/api/tools/websearch", async (_request, reply) => {
    reply.code(204).send();
  });

  app.get("/health", async () => {
    let keyPoolStatus: unknown;
    let keyPoolProviders: unknown;
    try {
      const status = await keyPool.getStatus(config.upstreamProviderId);
      keyPoolStatus = {
        providerId: status.providerId,
        authType: status.authType,
        totalKeys: status.totalAccounts,
        availableKeys: status.availableAccounts,
        cooldownKeys: status.cooldownAccounts,
        nextReadyInMs: status.nextReadyInMs
      };

      const allStatuses = await keyPool.getAllStatuses();
      keyPoolProviders = Object.fromEntries(
        Object.entries(allStatuses).map(([providerId, providerStatus]) => [
          providerId,
          {
            providerId: providerStatus.providerId,
            authType: providerStatus.authType,
            totalAccounts: providerStatus.totalAccounts,
            availableAccounts: providerStatus.availableAccounts,
            cooldownAccounts: providerStatus.cooldownAccounts,
            nextReadyInMs: providerStatus.nextReadyInMs
          }
        ])
      );
    } catch (error) {
      keyPoolStatus = { error: toErrorMessage(error) };
      keyPoolProviders = {};
    }

    return {
      ok: true,
      service: "open-hax-openai-proxy",
      authMode: config.proxyAuthToken ? "token" : "unauthenticated",
      keyPool: keyPoolStatus,
      keyPoolProviders
    };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/tools/websearch", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const query = typeof request.body.query === "string" ? request.body.query.trim() : "";
    if (!query) {
      sendOpenAiError(reply, 400, "Missing required field: query", "invalid_request_error", "missing_query");
      return;
    }

    const requestedModel = typeof request.body.model === "string" ? request.body.model : undefined;
    const model = normalizeOpenAiModelForWebsearch(requestedModel);

    const numResultsRaw = typeof request.body.numResults === "number" ? request.body.numResults : undefined;
    const numResults = Number.isFinite(numResultsRaw ?? NaN)
      ? Math.max(1, Math.min(20, Math.trunc(numResultsRaw!)))
      : 8;

    const searchContextSizeRaw = typeof request.body.searchContextSize === "string"
      ? request.body.searchContextSize
      : undefined;
    const searchContextSize: WebSearchContextSize =
      searchContextSizeRaw === "low" || searchContextSizeRaw === "high" ? searchContextSizeRaw : "medium";

    const allowedDomains = Array.isArray(request.body.allowedDomains)
      ? request.body.allowedDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      : undefined;

    const prompt = buildWebSearchPrompt({ query, numResults, year: new Date().getFullYear() });

    const responsesPayload: Record<string, unknown> = {
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      tools: [
        {
          type: "web_search",
          search_context_size: searchContextSize,
          ...(allowedDomains && allowedDomains.length > 0
            ? {
                filters: {
                  allowed_domains: allowedDomains,
                },
              }
            : undefined),
        },
      ],
      tool_choice: { type: "web_search" },
      max_output_tokens: 900,
      include: ["web_search_call.action.sources"],
      stream: false,
      store: false,
    };

    // Route through the existing /v1/responses machinery so we reuse:
    // - OpenAI OAuth accounts
    // - provider fallback/rotation
    // - upstream error normalization
    const injected = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: request.headers.authorization ?? "",
        cookie: request.headers.cookie ?? "",
      },
      payload: responsesPayload,
    });

    if (injected.statusCode >= 400) {
      reply.code(injected.statusCode);
      for (const [name, value] of Object.entries(injected.headers)) {
        if (typeof value === "string") reply.header(name, value);
      }
      reply.send(injected.body);
      return;
    }

    let responseJson: unknown;
    try {
      responseJson = injected.json();
    } catch {
      sendOpenAiError(reply, 502, "Upstream returned non-JSON response", "server_error", "invalid_upstream");
      return;
    }

    const output = extractOutputTextFromResponses(responseJson);
    const sources = extractWebSearchSourcesFromResponses(responseJson);
    const responseId = isRecord(responseJson) && typeof responseJson.id === "string" ? responseJson.id : undefined;

    reply.send({
      query,
      model,
      output,
      sources,
      responseId,
    });
  });

  app.get("/v1/models", async (_request, reply) => {
    const modelIds = await getMergedModelIds();
    reply.send({
      object: "list",
      data: modelIds.map(toOpenAiModel)
    });
  });

  app.get<{ Params: { model: string } }>("/v1/models/:model", async (request, reply) => {
    const modelIds = await getMergedModelIds();
    const model = modelIds.find((entry) => entry === request.params.model);
    if (!model) {
      sendOpenAiError(reply, 404, `Model not found: ${request.params.model}`, "invalid_request_error", "model_not_found");
      return;
    }

    reply.send(toOpenAiModel(model));
  });

  app.get("/api/tags", async (_request, reply) => {
    const modelIds = await getMergedModelIds();
    reply.send(modelIdsToNativeTags(modelIds));
  });

  app.post<{ Body: WebSearchToolRequest }>("/api/tools/websearch", async (request, reply) => {
    if (!isRecord(request.body)) {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    const query = typeof request.body.query === "string" ? request.body.query.trim() : "";
    if (query.length === 0) {
      reply.code(400).send({ error: "query_required" });
      return;
    }

    const rawNumResults = typeof request.body.numResults === "number" ? request.body.numResults : Number.NaN;
    const numResults = Number.isFinite(rawNumResults)
      ? Math.max(1, Math.min(20, Math.trunc(rawNumResults)))
      : 8;

    const searchContextSize = typeof request.body.searchContextSize === "string"
      ? request.body.searchContextSize.trim().toLowerCase()
      : "";
    const contextSize = (searchContextSize === "low" || searchContextSize === "medium" || searchContextSize === "high")
      ? searchContextSize
      : undefined;

    const allowedDomains = Array.isArray(request.body.allowedDomains)
      ? request.body.allowedDomains
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 50)
      : [];

    const requestedModel = typeof request.body.model === "string" ? request.body.model.trim() : "";

    const fallbackModel = process.env.OPEN_HAX_WEBSEARCH_FALLBACK_MODEL?.trim() || "gpt-5.2";
    const candidateModels = [requestedModel, fallbackModel]
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const uniqueModels: string[] = [];
    for (const entry of candidateModels) {
      if (!uniqueModels.includes(entry)) {
        uniqueModels.push(entry);
      }
    }

    const authHeaders: Record<string, string> = {
      "content-type": "application/json",
      ...(config.proxyAuthToken ? { authorization: `Bearer ${config.proxyAuthToken}` } : {}),
    };

    const baseTool: Record<string, unknown> = {
      type: "web_search",
      external_web_access: true,
      ...(contextSize ? { search_context_size: contextSize } : {}),
    };

    const buildUserText = (withDomainsHint: boolean) => {
      const domainHint = withDomainsHint && allowedDomains.length > 0
        ? `\n\nRestrict sources to these domains when possible:\n${allowedDomains.map((d) => `- ${d}`).join("\n")}`
        : "";
      return [
        `Query: ${query}`,
        `Return up to ${numResults} results as a Markdown list. Each bullet must include a Markdown link and a 1-2 sentence snippet.`,
        `Do not fabricate URLs; every link must be backed by web_search citations.`,
        domainHint,
      ].join("\n");
    };

    const attemptPayload = async (model: string, includeDomainsInTool: boolean) => {
      const tool = includeDomainsInTool && allowedDomains.length > 0
        ? { ...baseTool, allowed_domains: allowedDomains }
        : baseTool;

      return app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: authHeaders,
        payload: {
          model,
          instructions: "You are a web search helper. Use the web_search tool to gather sources and answer with citations.",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: buildUserText(!includeDomainsInTool) }],
            },
          ],
          tools: [tool],
          tool_choice: "auto",
          store: false,
          stream: false,
        },
      });
    };

    let lastErrorPayload: unknown;

    for (const model of uniqueModels) {
      // Try the most structured tool payload first; fall back to hint-only if upstream rejects unknown fields.
      for (const includeDomainsInTool of [true, false]) {
        const injected = await attemptPayload(model, includeDomainsInTool);
        if (injected.statusCode !== 200) {
          lastErrorPayload = parseJsonIfPossible(injected.body) ?? injected.body;
          continue;
        }

        const json = parseJsonIfPossible(injected.body);
        const extracted = extractResponseTextAndUrlCitations(json);

        const output = extracted.text;
        const sources = extracted.citations.length > 0
          ? extracted.citations
          : extractMarkdownLinks(output);

        reply.send({
          output,
          sources: sources.slice(0, numResults),
          responseId: extracted.responseId,
          model,
        });
        return;
      }
    }

    reply.code(502).send({
      error: "websearch_failed",
      details: lastErrorPayload,
    });
  });

  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const proxySettings = await proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    const requestBody = proxySettings.fastMode
      ? {
        open_hax: {
          fast_mode: true,
          ...(isRecord(request.body.open_hax) ? request.body.open_hax : {}),
        },
        ...request.body,
      }
      : request.body;

    if (proxySettings.fastMode) {
      reply.header("x-open-hax-fast-mode", "priority");
    }

    const requestedModelInput = typeof requestBody.model === "string" ? requestBody.model : "";
    const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(requestedModelInput, proxySettings);
    if (explicitlyBlockedProviderId) {
      sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
      return;
    }

    let routingModelInput = requestedModelInput;
    let resolvedModelCatalog: ResolvedModelCatalog | null = null;
    try {
      const catalogBundle = await providerCatalogStore.getCatalog();
      const catalog = catalogBundle.catalog;
      resolvedModelCatalog = catalog;
      const disabledModelSet = new Set(catalogBundle.preferences.disabled);
      if (disabledModelSet.has(requestedModelInput) || disabledModelSet.has(catalog.aliasTargets[requestedModelInput] ?? "")) {
        sendOpenAiError(reply, 403, `Model is disabled: ${requestedModelInput}`, "invalid_request_error", "model_disabled");
        return;
      }
      const aliasTarget = catalog.aliasTargets[requestedModelInput];
      if (typeof aliasTarget === "string" && aliasTarget.length > 0) {
        routingModelInput = aliasTarget;
        reply.header("x-open-hax-model-alias", `${requestedModelInput}->${aliasTarget}`);
      }
    } catch (error) {
      request.log.warn({ error: toErrorMessage(error) }, "failed to resolve dynamic model aliases; using requested model as-is");
    }

    const { strategy, context } = selectProviderStrategy(
      config,
      request.headers,
      requestBody,
      requestedModelInput,
      routingModelInput,
      (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
    );
    reply.header("x-open-hax-upstream-mode", strategy.mode);

    let providerRoutes: ProviderRoute[];
    if (context.factoryPrefixed) {
      const factoryBaseUrl = config.upstreamProviderBaseUrls["factory"] ?? "https://api.factory.ai";
      providerRoutes = config.disabledProviderIds.includes("factory")
        ? []
        : [{ providerId: "factory", baseUrl: factoryBaseUrl }];
    } else {
      providerRoutes = buildProviderRoutes(
        config,
        context.openAiPrefixed,
        !context.openAiPrefixed && strategy.mode === "responses"
      );
      if (!context.openAiPrefixed && resolvedModelCatalog) {
        providerRoutes = resolveProviderRoutesForModel(providerRoutes, context.routedModel, resolvedModelCatalog);
      }
    }
    providerRoutes = filterTenantProviderRoutes(providerRoutes, proxySettings);
    providerRoutes = orderProviderRoutesByPolicy(policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
      openAiPrefixed: context.openAiPrefixed,
      localOllama: context.localOllama,
      explicitOllama: context.explicitOllama,
    });

    if (providerRoutes.length === 0) {
      sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
      return;
    }

    try {
      const catalogBundle = await providerCatalogStore.getCatalog();
      const disabledSet = new Set(catalogBundle.preferences.disabled);
      if (disabledSet.has(context.routedModel)) {
        sendOpenAiError(reply, 403, `Model is disabled: ${context.routedModel}`, "invalid_request_error", "model_disabled");
        return;
      }

      if (shouldRejectModelFromProviderCatalog(providerRoutes, context.routedModel, catalogBundle)) {
        sendOpenAiError(reply, 404, `Model not found: ${context.routedModel}`, "invalid_request_error", "model_not_found");
        return;
      }
    } catch (error) {
      request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog; continuing without gating");
    }

    let payload: ReturnType<typeof strategy.buildPayload>;
    try {
      payload = strategy.buildPayload(context);
    } catch (error) {
      sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
      return;
    }

    if (strategy.mode === "ollama_chat" || strategy.mode === "local_ollama_chat") {
      const candidateRequestBody = payload.upstreamPayload;
      if (isRecord(candidateRequestBody) && !requestHasExplicitNumCtx(requestBody)) {
        const budget = await ensureOllamaContextFits(config.ollamaBaseUrl, candidateRequestBody, Math.min(config.requestTimeoutMs, 30_000));
        if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
          sendOpenAiError(
            reply,
            400,
            `Request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, requested output tokens: ${budget.requestedOutputTokens}, required total: ${budget.requiredContextTokens}, available: ${budget.availableContextTokens}. Reduce input size or request a larger context/model.`,
            "invalid_request_error",
            "ollama_context_overflow"
          );
          return;
        }
      }
    }

    if (strategy.isLocal) {
      if (!tenantProviderAllowed(proxySettings, "ollama")) {
        sendOpenAiError(reply, 403, "Provider is disabled for this tenant: ollama", "invalid_request_error", "provider_not_allowed");
        return;
      }

      await executeLocalStrategy(strategy, reply, requestLogStore, context, payload);
      return;
    }

    if (providerRoutes.length === 0) {
      sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
      return;
    }

    for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
      await ensureFreshAccounts(providerId);
    }

    const availability = await inspectProviderAvailability(keyPool, providerRoutes);
    const promptCacheKey = extractPromptCacheKey(requestBody);
    const execution = await executeProviderFallback(
      strategy,
      reply,
      requestLogStore,
      promptAffinityStore,
      keyPool,
      providerRoutes,
      context,
      payload,
      promptCacheKey,
      refreshExpiredOAuthAccount,
      policyEngine,
      accountHealthStore,
      eventStore,
    );

    if (execution.handled) {
      return;
    }

    const federatedChatHandled = await executeFederatedRequestFallback({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
      providerRoutes,
      upstreamPath: "/v1/chat/completions",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    });
    if (federatedChatHandled) {
      return;
    }

    const bridgedChatHandled = await executeBridgeRequestFallback({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
      upstreamPath: "/v1/chat/completions",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    });
    if (bridgedChatHandled) {
      return;
    }

    if (execution.candidateCount === 0) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      if (!availability.sawConfiguredProvider) {
        sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration", "server_error", "keys_unavailable");
        return;
      }

      sendOpenAiError(
        reply,
        429,
        "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
        "rate_limit_error",
        "all_keys_rate_limited"
      );
      return;
    }

    const { summary } = execution;

    if (summary.sawUpstreamInvalidRequest) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream invalid-request responses");
      sendOpenAiError(
        reply,
        400,
        "No upstream account accepted the request payload. Check model availability and request parameters.",
        "invalid_request_error",
        "upstream_rejected_request"
      );
      return;
    }

    if (summary.sawRateLimit) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream rate limits");
      sendOpenAiError(
        reply,
        429,
        "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
        "rate_limit_error",
        "no_available_key"
      );
      return;
    }

    if (summary.sawUpstreamServerError) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream server errors");
      sendOpenAiError(
        reply,
        502,
        "Upstream returned transient server errors across all available accounts.",
        "server_error",
        "upstream_server_error"
      );
      return;
    }

    if (summary.sawModelNotFound && !summary.sawRequestError) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to model-not-found responses");
      sendOpenAiError(
        reply,
        404,
        `Model not found across available upstream providers: ${context.routedModel}`,
        "invalid_request_error",
        "model_not_found"
      );
      return;
    }

    const message = summary.sawRequestError
      ? "All upstream attempts failed due to network/transport errors."
      : "Upstream rejected the request with no successful fallback.";

    app.log.error({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode, sawRequestError: summary.sawRequestError }, "all upstream attempts exhausted");
    sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
  });

  app.post<{ Body: Record<string, unknown> }>("/v1/responses", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const tenantSettings = await proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    const requestBody = request.body;
    const promptCacheKey = extractPromptCacheKey(requestBody);

    app.log.info({
      responsesBody: summarizeResponsesRequestBody(requestBody),
      hasPromptCacheKey: Boolean(promptCacheKey),
      promptCacheKey: promptCacheKey ? hashPromptCacheKey(promptCacheKey) : undefined,
    }, "responses passthrough: incoming body");

    const requestedModelInput = typeof requestBody.model === "string" ? requestBody.model : "";
    if (requestedModelInput.length === 0) {
      sendOpenAiError(reply, 400, "Missing required field: model", "invalid_request_error", "missing_model");
      return;
    }

    const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(requestedModelInput, tenantSettings);
    if (explicitlyBlockedProviderId) {
      sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
      return;
    }

    let routingModelInput = requestedModelInput;
    try {
      const catalogBundle = await providerCatalogStore.getCatalog();
      const catalog = catalogBundle.catalog;
      const disabledModelSet = new Set(catalogBundle.preferences.disabled);
      if (disabledModelSet.has(requestedModelInput) || disabledModelSet.has(catalog.aliasTargets[requestedModelInput] ?? "")) {
        sendOpenAiError(reply, 403, `Model is disabled: ${requestedModelInput}`, "invalid_request_error", "model_disabled");
        return;
      }
      const aliasTarget = catalog.aliasTargets[requestedModelInput];
      if (typeof aliasTarget === "string" && aliasTarget.length > 0) {
        routingModelInput = aliasTarget;
        reply.header("x-open-hax-model-alias", `${requestedModelInput}->${aliasTarget}`);
      }
    } catch (error) {
      request.log.warn({ error: toErrorMessage(error) }, "failed to resolve dynamic model aliases for /v1/responses; using requested model as-is");
    }

    const { strategy, context } = buildResponsesPassthroughContext(
      config,
      request.headers,
      requestBody,
      requestedModelInput,
      routingModelInput,
      (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
    );
    reply.header("x-open-hax-upstream-mode", strategy.mode);

    let providerRoutes: ProviderRoute[];
    if (context.factoryPrefixed) {
      const factoryBaseUrl = config.upstreamProviderBaseUrls["factory"] ?? "https://api.factory.ai";
      providerRoutes = config.disabledProviderIds.includes("factory")
        ? []
        : [{ providerId: "factory", baseUrl: factoryBaseUrl }];
    } else {
      providerRoutes = buildProviderRoutes(config, context.openAiPrefixed, true);
    }

    providerRoutes = filterResponsesApiRoutes(providerRoutes, config.openaiProviderId);
    providerRoutes = filterTenantProviderRoutes(providerRoutes, tenantSettings);
    providerRoutes = orderProviderRoutesByPolicy(policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
      openAiPrefixed: context.openAiPrefixed,
      localOllama: false,
      explicitOllama: false,
    });

    if (providerRoutes.length === 0) {
      sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
      return;
    }

    try {
      const catalogBundle = await providerCatalogStore.getCatalog();
      const disabledSet = new Set(catalogBundle.preferences.disabled);
      if (disabledSet.has(context.routedModel)) {
        sendOpenAiError(reply, 403, `Model is disabled: ${context.routedModel}`, "invalid_request_error", "model_disabled");
        return;
      }

      if (shouldRejectModelFromProviderCatalog(providerRoutes, context.routedModel, catalogBundle)) {
        sendOpenAiError(reply, 404, `Model not found: ${context.routedModel}`, "invalid_request_error", "model_not_found");
        return;
      }
    } catch (error) {
      request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog for /v1/responses; continuing without gating");
    }

    let payload: ReturnType<typeof strategy.buildPayload>;
    try {
      payload = strategy.buildPayload(context);
    } catch (error) {
      sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
      return;
    }

    if (providerRoutes.length === 0) {
      sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
      return;
    }

    for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
      await ensureFreshAccounts(providerId);
    }

    const availability = await inspectProviderAvailability(keyPool, providerRoutes, promptCacheKey);
    const execution = await executeProviderFallback(
      strategy,
      reply,
      requestLogStore,
      promptAffinityStore,
      keyPool,
      providerRoutes,
      context,
      payload,
      availability.prompt_cache_key,
      refreshExpiredOAuthAccount,
      policyEngine,
      accountHealthStore,
      eventStore,
    );

    if (execution.handled) {
      return;
    }

    const federatedResponsesHandled = await executeFederatedRequestFallback({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
      providerRoutes,
      upstreamPath: "/v1/responses",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    });
    if (federatedResponsesHandled) {
      return;
    }

    if (execution.candidateCount === 0) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      if (!availability.sawConfiguredProvider) {
        sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration for Responses API providers", "server_error", "keys_unavailable");
        return;
      }

      sendOpenAiError(
        reply,
        429,
        "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
        "rate_limit_error",
        "all_keys_rate_limited"
      );
      return;
    }

    const { summary } = execution;

    if (summary.sawUpstreamInvalidRequest) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to upstream invalid-request responses");
      sendOpenAiError(
        reply,
        400,
        "No upstream account accepted the request payload. Check model availability and request parameters.",
        "invalid_request_error",
        "upstream_rejected_request"
      );
      return;
    }

    if (summary.sawRateLimit) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to upstream rate limits");
      sendOpenAiError(
        reply,
        429,
        "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
        "rate_limit_error",
        "no_available_key"
      );
      return;
    }

    if (summary.sawUpstreamServerError) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to upstream server errors");
      sendOpenAiError(
        reply,
        502,
        "Upstream returned transient server errors across all available accounts.",
        "server_error",
        "upstream_server_error"
      );
      return;
    }

    if (summary.sawModelNotFound && !summary.sawRequestError) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to model-not-found responses");
      sendOpenAiError(
        reply,
        404,
        `Model not found across available Responses API providers: ${context.routedModel}`,
        "invalid_request_error",
        "model_not_found"
      );
      return;
    }

    const message = summary.sawRequestError
      ? "All upstream attempts failed due to network/transport errors."
      : "Upstream rejected the request with no successful fallback.";

    app.log.error({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode, sawRequestError: summary.sawRequestError }, "responses passthrough: all upstream attempts exhausted");
    sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
  });

  app.post<{ Body: Record<string, unknown> }>("/v1/images/generations", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const tenantSettings = await proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    const requestBody = request.body;
    const model = typeof requestBody.model === "string" ? requestBody.model : "";
    if (model.length === 0) {
      sendOpenAiError(reply, 400, "Missing required field: model", "invalid_request_error", "missing_model");
      return;
    }

    const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(model, tenantSettings);
    if (explicitlyBlockedProviderId) {
      sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
      return;
    }

    const { strategy, context } = buildImagesPassthroughContext(
      config,
      request.headers,
      requestBody,
      model,
      (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
    );
    reply.header("x-open-hax-upstream-mode", strategy.mode);

    let payload: ReturnType<typeof strategy.buildPayload>;
    try {
      payload = strategy.buildPayload(context);
    } catch (error) {
      sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
      return;
    }

    let providerRoutes = filterImagesApiRoutes(
      buildProviderRoutes(config, context.openAiPrefixed, true),
      config.openaiProviderId,
    );
    providerRoutes = filterTenantProviderRoutes(providerRoutes, tenantSettings);
    providerRoutes = orderProviderRoutesByPolicy(policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
      openAiPrefixed: context.openAiPrefixed,
      localOllama: false,
      explicitOllama: false,
    });

    if (providerRoutes.length === 0) {
      sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
      return;
    }

    for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
      await ensureFreshAccounts(providerId);
    }

    const availability = await inspectProviderAvailability(keyPool, providerRoutes);
    const execution = await executeProviderFallback(
      strategy,
      reply,
      requestLogStore,
      promptAffinityStore,
      keyPool,
      providerRoutes,
      context,
      payload,
      undefined,
      refreshExpiredOAuthAccount,
      policyEngine,
      accountHealthStore,
      eventStore,
    );

    if (execution.handled) {
      return;
    }

    const federatedImagesHandled = await executeFederatedRequestFallback({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
      providerRoutes,
      upstreamPath: "/v1/images/generations",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    });
    if (federatedImagesHandled) {
      return;
    }

    if (execution.candidateCount === 0) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      if (!availability.sawConfiguredProvider) {
        sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration for image generation providers", "server_error", "keys_unavailable");
        return;
      }

      sendOpenAiError(
        reply,
        429,
        "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
        "rate_limit_error",
        "all_keys_rate_limited",
      );
      return;
    }

    const { summary } = execution;

    if (summary.sawUpstreamInvalidRequest) {
      sendOpenAiError(
        reply,
        400,
        "No upstream account accepted the image generation payload. Check model availability and request parameters.",
        "invalid_request_error",
        "upstream_rejected_request",
      );
      return;
    }

    if (summary.sawRateLimit) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      sendOpenAiError(
        reply,
        429,
        "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
        "rate_limit_error",
        "no_available_key",
      );
      return;
    }

    if (summary.sawUpstreamServerError) {
      sendOpenAiError(
        reply,
        502,
        "Upstream returned transient server errors across all available accounts.",
        "server_error",
        "upstream_server_error",
      );
      return;
    }

    if (summary.sawModelNotFound && !summary.sawRequestError) {
      sendOpenAiError(
        reply,
        404,
        `Model not found across available upstream providers: ${context.routedModel}`,
        "invalid_request_error",
        "model_not_found",
      );
      return;
    }

    if (summary.lastUpstreamAuthError) {
      sendOpenAiError(
        reply,
        summary.lastUpstreamAuthError.status,
        summary.lastUpstreamAuthError.message ?? "Upstream rejected the request due to authentication/authorization.",
        "invalid_request_error",
        "upstream_auth_error",
      );
      return;
    }

    const message = summary.sawRequestError
      ? "All upstream attempts failed due to network/transport errors."
      : "Upstream rejected the request with no successful fallback.";

    sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
  });

  app.post<{ Body: Record<string, unknown> }>("/v1/embeddings", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const tenantSettings = await proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    if (!tenantProviderAllowed(tenantSettings, "ollama")) {
      sendOpenAiError(reply, 403, "Provider is disabled for this tenant: ollama", "invalid_request_error", "provider_not_allowed");
      return;
    }

    const model = typeof request.body.model === "string" ? request.body.model : "";
    const routingState = selectProviderStrategy(
      config,
      request.headers,
      {
        model,
        messages: [{ role: "user", content: "embed" }],
        stream: false,
      },
      model,
      model,
      (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
    ).context;

    const routedModel = routingState.routedModel;
    const upstreamUrl = joinUrl(config.ollamaBaseUrl, "/api/embed");
    const embedBody = nativeEmbedToOpenAiRequest({
      ...request.body,
      model: routedModel,
    });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
        method: "POST",
        headers: buildForwardHeaders(request.headers),
        body: JSON.stringify({
          model: embedBody.model,
          input: embedBody.input,
        }),
      }, config.requestTimeoutMs);
    } catch (error) {
      sendOpenAiError(
        reply,
        502,
        `Embedding upstream request failed: ${toErrorMessage(error)}`,
        "server_error",
        "embedding_upstream_unavailable"
      );
      return;
    }

    if (!upstreamResponse.ok) {
      sendOpenAiError(
        reply,
        upstreamResponse.status >= 500 ? 502 : upstreamResponse.status,
        `Embedding upstream rejected the request: ${await upstreamResponse.text()}`,
        upstreamResponse.status >= 500 ? "server_error" : "invalid_request_error",
        "embedding_upstream_error"
      );
      return;
    }

    const upstreamJson = await upstreamResponse.json() as Record<string, unknown>;
    reply.send(nativeEmbedResponseToOpenAiEmbeddings(upstreamJson, embedBody.model));
  });

  app.post<{ Body: Record<string, unknown> }>("/api/chat", async (request, reply) => {
    const bridgeResponse = await injectNativeBridge(
      "/v1/chat/completions",
      nativeChatToOpenAiRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body);
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["choices"])) {
      reply.send(chatCompletionToNativeChat(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/generate", async (request, reply) => {
    const bridgeResponse = await injectNativeBridge(
      "/v1/chat/completions",
      nativeGenerateToChatRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body);
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["choices"])) {
      reply.send(chatCompletionToNativeGenerate(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/embed", async (request, reply) => {
    const bridgeResponse = await injectNativeBridge(
      "/v1/embeddings",
      nativeEmbedToOpenAiRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body);
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["data"])) {
      reply.send(openAiEmbeddingsToNativeEmbed(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/embeddings", async (request, reply) => {
    const bridgeResponse = await injectNativeBridge(
      "/v1/embeddings",
      nativeEmbedToOpenAiRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body);
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["data"])) {
      reply.send(openAiEmbeddingsToNativeEmbeddings(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  bridgeRelay = await registerUiRoutes(app, {
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
    bridgeRelay: wsBridgeRelay,
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

  if (bridgeAgent) {
    void bridgeAgent.start().then(() => {
      app.log.info({ snapshot: bridgeAgent.snapshot() }, "federation bridge agent connected");
    }).catch((error) => {
      app.log.warn({ error: toErrorMessage(error) }, "federation bridge agent initial connect failed; reconnect loop will continue in background");
    });
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
