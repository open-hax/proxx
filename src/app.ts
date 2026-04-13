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
import {
  buildWebSearchPrompt,
  extractOutputTextFromResponses,
  extractWebSearchSourcesFromResponses,
  normalizeOpenAiModelForWebsearch,
  type WebSearchContextSize,
} from "./lib/websearch.js";

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
    const catalog = await getResolvedModelCatalog();
    reply.send({
      object: "list",
      data: catalog.modelIds.map(toOpenAiModel)
    });
  });

  const deps: AppDeps = {
    app, config, keyPool, credentialStore, runtimeCredentialStore,
    sqlCredentialStore, sqlFederationStore, sqlTenantProviderPolicyStore,
    accountHealthStore, eventStore, requestLogStore, promptAffinityStore,
    proxySettingsStore, policyEngine, providerCatalogStore, tokenRefreshManager,
    dynamicProviderBaseUrlGetter: dynamicProviderBaseUrlGetter
      ? async (id: string) => (await dynamicProviderBaseUrlGetter(id)) ?? undefined
      : async () => undefined, bridgeRelay, quotaMonitor,
    refreshFactoryAccount: async (c) => { await refreshFactoryAccount(c as never); },
    ensureFreshAccounts,
    refreshExpiredOAuthAccount: async (c) => await refreshExpiredOAuthAccount(c as never),
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
