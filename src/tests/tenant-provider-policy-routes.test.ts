import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify, { type FastifyRequest } from "fastify";

import { type ProxyConfig } from "../lib/config.js";
import { CredentialStore } from "../lib/credential-store.js";
import type { FederationDiffEventRecord } from "../lib/db/sql-federation-store.js";
import { type TenantProviderPolicyRecord } from "../lib/tenant-provider-policy.js";
import { KeyPool } from "../lib/key-pool.js";
import { ProxySettingsStore } from "../lib/proxy-settings-store.js";
import { RequestLogStore } from "../lib/request-log-store.js";
import { registerUiRoutes } from "../lib/ui-routes.js";

function buildConfig(input: {
  readonly upstreamPort: number;
  readonly paths: {
    readonly keysPath: string;
    readonly modelsPath: string;
    readonly requestLogsPath: string;
    readonly promptAffinityPath: string;
    readonly settingsPath: string;
  };
  readonly proxyAuthToken: string;
}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "vivgrid",
    upstreamFallbackProviderIds: [],
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${input.upstreamPort}`,
      "ollama-cloud": `http://127.0.0.1:${input.upstreamPort}`,
      ob1: `http://127.0.0.1:${input.upstreamPort}`,
      openai: `http://127.0.0.1:${input.upstreamPort}`,
      openrouter: `http://127.0.0.1:${input.upstreamPort}`,
      requesty: `http://127.0.0.1:${input.upstreamPort}`,
      gemini: `http://127.0.0.1:${input.upstreamPort}`,
      zai: `http://127.0.0.1:${input.upstreamPort}/api/paas/v4`,
      mistral: `http://127.0.0.1:${input.upstreamPort}/v1`,
    },
    upstreamBaseUrl: `http://127.0.0.1:${input.upstreamPort}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${input.upstreamPort}`,
    openaiApiBaseUrl: `http://127.0.0.1:${input.upstreamPort}`,
    openaiImagesUpstreamMode: "auto",
    ollamaBaseUrl: `http://127.0.0.1:${input.upstreamPort}`,
    localOllamaEnabled: true,
    localOllamaModelPatterns: [":2b", ":3b", ":4b", ":7b", ":8b", "mini", "small"],
    chatCompletionsPath: "/v1/chat/completions",
    openaiChatCompletionsPath: "/v1/chat/completions",
    messagesPath: "/v1/messages",
    messagesModelPrefixes: ["claude-"],
    messagesInterleavedThinkingBeta: "interleaved-thinking-2025-05-14",
    responsesPath: "/v1/responses",
    openaiResponsesPath: "/v1/responses",
    openaiImagesGenerationsPaths: ["/v1/images/generations", "/images/generations", "/codex/images/generations"],
    imageCostUsdDefault: 0,
    imageCostUsdByProvider: {},
    imagesGenerationsPath: "/v1/images/generations",
    responsesModelPrefixes: ["gpt-"],
    ollamaChatPath: "/api/chat",
    ollamaV1ChatPath: "/v1/chat/completions",
    factoryModelPrefixes: ["factory/", "factory:"],
    openaiModelPrefixes: ["openai/", "openai:"],
    ollamaModelPrefixes: ["ollama/", "ollama:"],
    keysFilePath: input.paths.keysPath,
    modelsFilePath: input.paths.modelsPath,
    requestLogsFilePath: input.paths.requestLogsPath,
    requestLogsMaxEntries: 100000,
    requestLogsFlushMs: 0,
    promptAffinityFilePath: input.paths.promptAffinityPath,
    promptAffinityFlushMs: 0,
    settingsFilePath: input.paths.settingsPath,
    keyReloadMs: 50,
    keyCooldownMs: 10_000,
    requestTimeoutMs: 2_000,
    streamBootstrapTimeoutMs: 2_000,
    upstreamTransientRetryCount: 1,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken: input.proxyAuthToken,
    allowUnauthenticated: false,
    databaseUrl: undefined,
    githubOAuthClientId: undefined,
    githubOAuthClientSecret: undefined,
    githubOAuthCallbackPath: "/auth/github/callback",
    githubAllowedUsers: [],
    sessionSecret: "test-session-token",
    openaiOauthScopes: "openid profile email offline_access",
    openaiOauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    openaiOauthIssuer: "https://auth.openai.com",
    proxyTokenPepper: "test-proxy-token-pepper",
    oauthRefreshMaxConcurrency: 32,
    oauthRefreshBackgroundIntervalMs: 15_000,
    oauthRefreshProactiveWindowMs: 30 * 60_000,
  };
}

test("tenant provider policy routes list and upsert policies", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-tenant-provider-policy-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  const upstream: Server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const config = buildConfig({
    upstreamPort: upstreamAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: "bridge-admin-token",
  });

  const app = Fastify({ logger: true });
  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer bridge-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const keyPool = new KeyPool({
    keysFilePath: keysPath,
    reloadIntervalMs: 50,
    defaultCooldownMs: 10_000,
    defaultProviderId: config.upstreamProviderId,
  });
  await keyPool.warmup();

  const credentialStore = new CredentialStore(keysPath, config.upstreamProviderId);
  const requestLogStore = new RequestLogStore(requestLogsPath, 1000, 0);
  await requestLogStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(settingsPath);
  await proxySettingsStore.warmup();

  const policies = new Map<string, TenantProviderPolicyRecord>();
  const sqlTenantProviderPolicyStore = {
    listPolicies: async (filters: { readonly subjectDid?: string; readonly ownerSubject?: string } = {}) => {
      return [...policies.values()].filter((policy) => {
        if (filters.subjectDid && policy.subjectDid !== filters.subjectDid) {
          return false;
        }
        if (filters.ownerSubject && policy.ownerSubject !== filters.ownerSubject) {
          return false;
        }
        return true;
      });
    },
    upsertPolicy: async (input: {
      readonly subjectDid: string;
      readonly providerId: string;
      readonly providerKind?: "local_upstream" | "peer_proxx";
      readonly ownerSubject: string;
      readonly shareMode?: "deny" | "descriptor_only" | "relay_only" | "warm_import" | "project_credentials";
      readonly trustTier?: "owned_administered" | "less_trusted";
      readonly allowedModels?: readonly string[];
      readonly maxRequestsPerMinute?: number;
      readonly maxConcurrentRequests?: number;
      readonly encryptedChannelRequired?: boolean;
      readonly warmImportThreshold?: number;
      readonly notes?: string;
    }) => {
      const now = new Date().toISOString();
      const key = `${input.subjectDid}\0${input.providerId}`;
      const existing = policies.get(key);
      const next: TenantProviderPolicyRecord = {
        subjectDid: input.subjectDid,
        providerId: input.providerId,
        providerKind: input.providerKind ?? "local_upstream",
        ownerSubject: input.ownerSubject,
        shareMode: input.shareMode ?? "deny",
        trustTier: input.trustTier ?? "less_trusted",
        allowedModels: input.allowedModels ?? [],
        maxRequestsPerMinute: input.maxRequestsPerMinute,
        maxConcurrentRequests: input.maxConcurrentRequests,
        encryptedChannelRequired: input.encryptedChannelRequired ?? false,
        warmImportThreshold: input.warmImportThreshold,
        notes: input.notes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      policies.set(key, next);
      return next;
    },
  };

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    proxySettingsStore,
    sqlTenantProviderPolicyStore: sqlTenantProviderPolicyStore as never,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/tenant-provider-policies",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        subjectDid: "did:web:big.ussy.promethean.rest",
        providerId: "openai",
        providerKind: "peer_proxx",
        ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
        shareMode: "relay_only",
        trustTier: "owned_administered",
        allowedModels: ["gpt-5.4"],
        warmImportThreshold: 3,
      },
    });

    assert.equal(createResponse.statusCode, 201);
    const createdPayload = createResponse.json() as { readonly policy: TenantProviderPolicyRecord };
    assert.equal(createdPayload.policy.providerId, "openai");
    assert.equal(createdPayload.policy.shareMode, "relay_only");

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/ui/federation/tenant-provider-policies?subjectDid=did:web:big.ussy.promethean.rest",
      headers: { authorization: "Bearer bridge-admin-token" },
    });

    assert.equal(listResponse.statusCode, 200);
    const listedPayload = listResponse.json() as { readonly policies: readonly TenantProviderPolicyRecord[] };
    assert.equal(listedPayload.policies.length, 1);
    assert.equal(listedPayload.policies[0]?.providerKind, "peer_proxx");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("federation diff-events route validates ownerSubject and forwards parsed filters", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-federation-diff-events-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  const upstream: Server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const config = buildConfig({
    upstreamPort: upstreamAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: "bridge-admin-token",
  });

  const app = Fastify({ logger: true });
  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer bridge-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const keyPool = new KeyPool({
    keysFilePath: keysPath,
    reloadIntervalMs: 50,
    defaultCooldownMs: 10_000,
    defaultProviderId: config.upstreamProviderId,
  });
  await keyPool.warmup();

  const credentialStore = new CredentialStore(keysPath, config.upstreamProviderId);
  const requestLogStore = new RequestLogStore(requestLogsPath, 1000, 0);
  await requestLogStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(settingsPath);
  await proxySettingsStore.warmup();

  const capturedRequests: Array<{ ownerSubject: string; afterSeq?: number; limit?: number }> = [];
  const sqlFederationStore = {
    listDiffEvents: async (input: { readonly ownerSubject: string; readonly afterSeq?: number; readonly limit?: number }) => {
      capturedRequests.push({
        ownerSubject: input.ownerSubject,
        afterSeq: input.afterSeq,
        limit: input.limit,
      });

      const events: FederationDiffEventRecord[] = [
        {
          seq: 6,
          ownerSubject: input.ownerSubject,
          entityType: "peer",
          entityKey: "peer-1",
          op: "upsert",
          payload: { label: "Peer 1" },
          createdAt: "2026-03-27T00:00:00.000Z",
        },
      ];
      return events;
    },
  };

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    proxySettingsStore,
    sqlFederationStore: sqlFederationStore as never,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const missingOwnerResponse = await app.inject({
      method: "GET",
      url: "/api/ui/federation/diff-events",
      headers: { authorization: "Bearer bridge-admin-token" },
    });

    assert.equal(missingOwnerResponse.statusCode, 400);
    assert.deepEqual(missingOwnerResponse.json(), { error: "owner_subject_required" });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/ui/federation/diff-events?ownerSubject=did:plc:test-owner&afterSeq=5&limit=2",
      headers: { authorization: "Bearer bridge-admin-token" },
    });

    assert.equal(listResponse.statusCode, 200);
    const listedPayload = listResponse.json() as {
      readonly ownerSubject: string;
      readonly events: readonly FederationDiffEventRecord[];
    };
    assert.equal(listedPayload.ownerSubject, "did:plc:test-owner");
    assert.equal(listedPayload.events.length, 1);
    assert.equal(listedPayload.events[0]?.seq, 6);
    assert.deepEqual(capturedRequests, [{ ownerSubject: "did:plc:test-owner", afterSeq: 5, limit: 2 }]);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("federation accounts routes expose knowledge summaries, export api keys, and lease oauth access tokens without refresh", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-federation-accounts-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({
    providers: {
      vivgrid: {
        auth: "api_key",
        accounts: [
          { id: "viv-a", api_key: "viv-secret-a" },
        ],
      },
      openai: {
        auth: "oauth_bearer",
        accounts: [
          { id: "openai-a", access_token: "openai-secret-a", refresh_token: "refresh-a", email: "owner@example.com" },
        ],
      },
    },
  }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  const upstream: Server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const config = buildConfig({
    upstreamPort: upstreamAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: "bridge-admin-token",
  });

  const app = Fastify({ logger: true });
  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer bridge-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const keyPool = new KeyPool({
    keysFilePath: keysPath,
    reloadIntervalMs: 50,
    defaultCooldownMs: 10_000,
    defaultProviderId: config.upstreamProviderId,
  });
  await keyPool.warmup();

  const credentialStore = new CredentialStore(keysPath, config.upstreamProviderId);
  const requestLogStore = new RequestLogStore(requestLogsPath, 1000, 0);
  await requestLogStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(settingsPath);
  await proxySettingsStore.warmup();

  const sqlFederationStore = {
    listProjectedAccounts: async () => ([
      {
        sourcePeerId: "peer-1",
        ownerSubject: "did:plc:remote-owner",
        providerId: "factory",
        accountId: "factory-1",
        accountSubject: "did:plc:remote-account",
        chatgptAccountId: undefined,
        email: "remote@example.com",
        planType: "pro",
        availabilityState: "descriptor",
        warmRequestCount: 2,
        lastRoutedAt: undefined,
        importedAt: undefined,
        metadata: {},
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
      },
    ]),
  };

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    proxySettingsStore,
    sqlFederationStore: sqlFederationStore as never,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/ui/federation/accounts",
      headers: { authorization: "Bearer bridge-admin-token" },
    });

    assert.equal(listResponse.statusCode, 200);
    const listPayload = listResponse.json() as {
      readonly ownerSubject: string | null;
      readonly localAccounts: ReadonlyArray<{ readonly providerId: string; readonly accountId: string }>;
      readonly projectedAccounts: ReadonlyArray<{ readonly providerId: string; readonly accountId: string }>;
      readonly knownAccounts: ReadonlyArray<{ readonly providerId: string; readonly accountId: string; readonly hasCredentials: boolean }>;
    };
    assert.equal(listPayload.ownerSubject, null);
    assert.equal(listPayload.localAccounts.length, 2);
    assert.equal(listPayload.projectedAccounts.length, 1);
    assert.equal(listPayload.knownAccounts.length, 3);
    assert.ok(listPayload.knownAccounts.some((account) => account.providerId === "factory" && account.accountId === "factory-1" && account.hasCredentials === false));
    assert.ok(listPayload.knownAccounts.some((account) => account.providerId === "openai" && account.accountId === "openai-a" && account.hasCredentials === true));

    const exportApiKeyResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/accounts/export",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        providerId: "vivgrid",
        accountId: "viv-a",
      },
    });

    assert.equal(exportApiKeyResponse.statusCode, 200);
    const exportApiKeyPayload = exportApiKeyResponse.json() as {
      readonly account: { readonly providerId: string; readonly accountId: string; readonly authType: string; readonly secret: string };
    };
    assert.equal(exportApiKeyPayload.account.providerId, "vivgrid");
    assert.equal(exportApiKeyPayload.account.accountId, "viv-a");
    assert.equal(exportApiKeyPayload.account.authType, "api_key");
    assert.equal(exportApiKeyPayload.account.secret, "viv-secret-a");

    const exportOauthResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/accounts/export",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        providerId: "openai",
        accountId: "openai-a",
      },
    });

    assert.equal(exportOauthResponse.statusCode, 200);
    const exportOauthPayload = exportOauthResponse.json() as {
      readonly account: {
        readonly providerId: string;
        readonly accountId: string;
        readonly authType: string;
        readonly secret: string;
        readonly refreshToken?: unknown;
      };
    };
    assert.equal(exportOauthPayload.account.providerId, "openai");
    assert.equal(exportOauthPayload.account.accountId, "openai-a");
    assert.equal(exportOauthPayload.account.authType, "oauth_bearer");
    assert.equal(exportOauthPayload.account.secret, "openai-secret-a");
    assert.equal(exportOauthPayload.account.refreshToken, undefined);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("federation projected-account import route validates entries and records diff events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-federation-projected-import-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  const upstream: Server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const config = buildConfig({
    upstreamPort: upstreamAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: "bridge-admin-token",
  });

  const app = Fastify({ logger: true });
  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer bridge-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const keyPool = new KeyPool({
    keysFilePath: keysPath,
    reloadIntervalMs: 50,
    defaultCooldownMs: 10_000,
    defaultProviderId: config.upstreamProviderId,
  });
  await keyPool.warmup();

  const credentialStore = new CredentialStore(keysPath, config.upstreamProviderId);
  const requestLogStore = new RequestLogStore(requestLogsPath, 1000, 0);
  await requestLogStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(settingsPath);
  await proxySettingsStore.warmup();

  const importedRecords: Array<Record<string, unknown>> = [];
  const diffEvents: Array<Record<string, unknown>> = [];
  const sqlFederationStore = {
    upsertProjectedAccount: async (input: {
      readonly sourcePeerId: string;
      readonly ownerSubject: string;
      readonly providerId: string;
      readonly accountId: string;
      readonly accountSubject?: string;
      readonly chatgptAccountId?: string;
      readonly email?: string;
      readonly planType?: string;
      readonly availabilityState?: "descriptor" | "remote_route" | "imported";
      readonly metadata?: Record<string, unknown>;
    }) => {
      const record = {
        sourcePeerId: input.sourcePeerId,
        ownerSubject: input.ownerSubject,
        providerId: input.providerId,
        accountId: input.accountId,
        accountSubject: input.accountSubject,
        chatgptAccountId: input.chatgptAccountId,
        email: input.email,
        planType: input.planType,
        availabilityState: input.availabilityState ?? "descriptor",
        warmRequestCount: 0,
        lastRoutedAt: undefined,
        importedAt: undefined,
        metadata: input.metadata ?? {},
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
      };
      importedRecords.push(record);
      return record;
    },
    appendDiffEvent: async (input: Record<string, unknown>) => {
      diffEvents.push(input);
      return {
        seq: diffEvents.length,
        ownerSubject: input.ownerSubject,
        entityType: input.entityType,
        entityKey: input.entityKey,
        op: input.op,
        payload: input.payload ?? {},
        createdAt: "2026-03-27T00:00:00.000Z",
      };
    },
  };

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    proxySettingsStore,
    sqlFederationStore: sqlFederationStore as never,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const missingAccountsResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/projected-accounts/import",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {},
    });

    assert.equal(missingAccountsResponse.statusCode, 400);
    assert.deepEqual(missingAccountsResponse.json(), { error: "accounts_required" });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/projected-accounts/import",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        accounts: [
          {
            sourcePeerId: "peer-1",
            ownerSubject: "did:plc:remote-owner",
            providerId: "openai",
            accountId: "acct-1",
            email: "remote@example.com",
            availabilityState: "remote_route",
            metadata: { source: "test" },
          },
        ],
      },
    });

    assert.equal(importResponse.statusCode, 201);
    const importPayload = importResponse.json() as {
      readonly accounts: ReadonlyArray<{ readonly providerId: string; readonly accountId: string; readonly availabilityState: string }>;
    };
    assert.equal(importPayload.accounts.length, 1);
    assert.equal(importPayload.accounts[0]?.providerId, "openai");
    assert.equal(importPayload.accounts[0]?.accountId, "acct-1");
    assert.equal(importPayload.accounts[0]?.availabilityState, "remote_route");
    assert.equal(importedRecords.length, 1);
    assert.equal(diffEvents.length, 1);
    assert.equal(diffEvents[0]?.entityType, "projected_account");
    assert.equal(diffEvents[0]?.op, "upsert");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("federation projected-account imported route blocks non-importable accounts and marks importable accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-federation-projected-imported-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  const upstream: Server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const config = buildConfig({
    upstreamPort: upstreamAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: "bridge-admin-token",
  });

  const app = Fastify({ logger: true });
  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer bridge-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const keyPool = new KeyPool({
    keysFilePath: keysPath,
    reloadIntervalMs: 50,
    defaultCooldownMs: 10_000,
    defaultProviderId: config.upstreamProviderId,
  });
  await keyPool.warmup();

  const credentialStore = new CredentialStore(keysPath, config.upstreamProviderId);
  const requestLogStore = new RequestLogStore(requestLogsPath, 1000, 0);
  await requestLogStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(settingsPath);
  await proxySettingsStore.warmup();

  const diffEvents: Array<Record<string, unknown>> = [];
  const projectedAccounts = new Map<string, Record<string, unknown>>([
    [
      "peer-1\0openai\0oauth-1",
      {
        sourcePeerId: "peer-1",
        ownerSubject: "did:plc:remote-owner",
        providerId: "openai",
        accountId: "oauth-1",
        availabilityState: "remote_route",
        warmRequestCount: 0,
        metadata: { authType: "oauth_bearer" },
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
      },
    ],
    [
      "peer-1\0openai\0api-1",
      {
        sourcePeerId: "peer-1",
        ownerSubject: "did:plc:remote-owner",
        providerId: "openai",
        accountId: "api-1",
        availabilityState: "remote_route",
        warmRequestCount: 1,
        metadata: { authType: "api_key" },
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
      },
    ],
  ]);

  const sqlFederationStore = {
    getProjectedAccount: async (input: { readonly sourcePeerId: string; readonly providerId: string; readonly accountId: string }) => {
      const key = `${input.sourcePeerId}\0${input.providerId}\0${input.accountId}`;
      const record = projectedAccounts.get(key);
      return record ? { ...record } : undefined;
    },
    markProjectedAccountImported: async (input: { readonly sourcePeerId: string; readonly providerId: string; readonly accountId: string }) => {
      const key = `${input.sourcePeerId}\0${input.providerId}\0${input.accountId}`;
      const current = projectedAccounts.get(key);
      if (!current) {
        return undefined;
      }
      const next = {
        ...current,
        availabilityState: "imported",
        importedAt: "2026-03-27T01:00:00.000Z",
        updatedAt: "2026-03-27T01:00:00.000Z",
      };
      projectedAccounts.set(key, next);
      return next;
    },
    appendDiffEvent: async (input: Record<string, unknown>) => {
      diffEvents.push(input);
      return {
        seq: diffEvents.length,
        ownerSubject: input.ownerSubject,
        entityType: input.entityType,
        entityKey: input.entityKey,
        op: input.op,
        payload: input.payload ?? {},
        createdAt: "2026-03-27T00:00:00.000Z",
      };
    },
  };

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    proxySettingsStore,
    sqlFederationStore: sqlFederationStore as never,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const blockedResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/projected-accounts/imported",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        sourcePeerId: "peer-1",
        providerId: "openai",
        accountId: "oauth-1",
      },
    });

    assert.equal(blockedResponse.statusCode, 409);
    const blockedPayload = blockedResponse.json() as { readonly error: string };
    assert.equal(blockedPayload.error, "credential_non_importable");

    const importedResponse = await app.inject({
      method: "POST",
      url: "/api/ui/federation/projected-accounts/imported",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        sourcePeerId: "peer-1",
        providerId: "openai",
        accountId: "api-1",
      },
    });

    assert.equal(importedResponse.statusCode, 200);
    const importedPayload = importedResponse.json() as {
      readonly account: { readonly availabilityState: string; readonly importedAt?: string };
    };
    assert.equal(importedPayload.account.availabilityState, "imported");
    assert.equal(importedPayload.account.importedAt, "2026-03-27T01:00:00.000Z");
    assert.equal(diffEvents.length, 1);
    assert.equal(diffEvents[0]?.op, "mark_imported");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("federation sync pull imports projected descriptors from aggregated peer accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-federation-sync-pull-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  const remoteApp = Fastify({ logger: true });
  remoteApp.decorateRequest("openHaxAuth", null);
  remoteApp.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer remote-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const remoteProjectedAccounts = [
    {
      sourcePeerId: "local-core",
      ownerSubject: "did:web:proxx.promethean.rest:brethren",
      providerId: "openai",
      accountId: "acct-1",
      accountSubject: "auth0|acct-1",
      chatgptAccountId: "chatgpt-acct-1",
      email: "acct-1@example.com",
      planType: "free",
      availabilityState: "descriptor" as const,
      warmRequestCount: 0,
      metadata: {
        hasCredentials: true,
        knowledgeSources: ["local_credential"],
        authType: "oauth_bearer",
        credentialMobility: "access_token_only",
      },
      createdAt: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-27T00:00:00.000Z",
    },
  ];

  const remoteSqlFederationStore = {
    listPeers: async () => [],
    listDiffEvents: async () => ([] as FederationDiffEventRecord[]),
    listProjectedAccounts: async () => remoteProjectedAccounts,
  };

  const remoteCredentialStore = {
    listProviders: async () => [],
  };

  const remoteKeyPool = {
    warmup: async () => undefined,
  };

  const remoteRequestLogStore = new RequestLogStore(path.join(tempDir, "remote-request-logs.jsonl"), 1000, 0);
  await remoteRequestLogStore.warmup();
  const remoteProxySettingsStore = new ProxySettingsStore(path.join(tempDir, "remote-settings.json"));
  await remoteProxySettingsStore.warmup();

  await registerUiRoutes(remoteApp, {
    config: buildConfig({
      upstreamPort: 65535,
      paths: {
        keysPath,
        modelsPath,
        requestLogsPath: path.join(tempDir, "remote-request-logs.jsonl"),
        promptAffinityPath: path.join(tempDir, "remote-prompt-affinity.json"),
        settingsPath: path.join(tempDir, "remote-settings.json"),
      },
      proxyAuthToken: "remote-admin-token",
    }),
    keyPool: remoteKeyPool as never,
    requestLogStore: remoteRequestLogStore,
    credentialStore: remoteCredentialStore as never,
    proxySettingsStore: remoteProxySettingsStore,
    sqlFederationStore: remoteSqlFederationStore as never,
  });

  await remoteApp.listen({ host: "127.0.0.1", port: 0 });
  const remoteAddress = remoteApp.server.address();
  if (!remoteAddress || typeof remoteAddress === "string") {
    throw new Error("failed to resolve remote app address");
  }

  const config = buildConfig({
    upstreamPort: remoteAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: "bridge-admin-token",
  });

  const app = Fastify({ logger: true });
  app.decorateRequest("openHaxAuth", null);

  app.addHook("onRequest", async (request) => {
    const mutableRequest = request as FastifyRequest & { openHaxAuth?: unknown };
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";

    if (authorization === "Bearer bridge-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "legacy_admin",
        tenantId: "default",
        role: "owner",
        source: "bearer",
        subject: "legacy:proxy-auth-token",
      };
    }
  });

  const keyPool = new KeyPool({
    keysFilePath: keysPath,
    reloadIntervalMs: 50,
    defaultCooldownMs: 10_000,
    defaultProviderId: config.upstreamProviderId,
  });
  await keyPool.warmup();

  const credentialStore = new CredentialStore(keysPath, config.upstreamProviderId);
  const requestLogStore = new RequestLogStore(requestLogsPath, 1000, 0);
  await requestLogStore.warmup();
  const proxySettingsStore = new ProxySettingsStore(settingsPath);
  await proxySettingsStore.warmup();

  const peers = new Map([
    ["peer-1", {
      id: "peer-1",
      ownerSubject: "did:web:proxx.promethean.rest:brethren",
      peerDid: "did:web:federation.big.ussy.promethean.rest",
      label: "Remote canonical",
      baseUrl: `http://127.0.0.1:${remoteAddress.port}`,
      controlBaseUrl: `http://127.0.0.1:${remoteAddress.port}`,
      authMode: "at_did",
      auth: { credential: "remote-admin-token" },
      status: "active",
      capabilities: { accounts: true, usage: true, audit: true },
      createdAt: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-27T00:00:00.000Z",
    }],
  ]);
  const syncStates = new Map<string, { readonly peerId: string; readonly lastPulledSeq: number; readonly lastPushedSeq: number; readonly updatedAt: string; readonly lastPullAt?: string; readonly lastPushAt?: string; readonly lastError?: string }>();
  const projectedAccounts = new Map<string, Record<string, unknown>>();
  const diffEvents: Array<Record<string, unknown>> = [];

  const sqlFederationStore = {
    getPeer: async (peerId: string) => peers.get(peerId),
    getSyncState: async (peerId: string) => syncStates.get(peerId),
    upsertSyncState: async (input: {
      readonly peerId: string;
      readonly lastPulledSeq?: number;
      readonly lastPushedSeq?: number;
      readonly lastPullAt?: boolean;
      readonly lastPushAt?: boolean;
      readonly lastError?: string | null;
    }) => {
      const now = "2026-03-27T00:00:00.000Z";
      const existing = syncStates.get(input.peerId);
      const next = {
        peerId: input.peerId,
        lastPulledSeq: input.lastPulledSeq ?? existing?.lastPulledSeq ?? 0,
        lastPushedSeq: input.lastPushedSeq ?? existing?.lastPushedSeq ?? 0,
        lastPullAt: input.lastPullAt ? now : existing?.lastPullAt,
        lastPushAt: input.lastPushAt ? now : existing?.lastPushAt,
        lastError: input.lastError === undefined ? existing?.lastError : input.lastError ?? undefined,
        updatedAt: now,
      };
      syncStates.set(input.peerId, next);
      return next;
    },
    upsertProjectedAccount: async (input: {
      readonly sourcePeerId: string;
      readonly ownerSubject: string;
      readonly providerId: string;
      readonly accountId: string;
      readonly accountSubject?: string;
      readonly chatgptAccountId?: string;
      readonly email?: string;
      readonly planType?: string;
      readonly availabilityState?: "descriptor" | "remote_route" | "imported";
      readonly metadata?: Record<string, unknown>;
    }) => {
      const key = `${input.sourcePeerId}\0${input.providerId}\0${input.accountId}`;
      const record = {
        sourcePeerId: input.sourcePeerId,
        ownerSubject: input.ownerSubject,
        providerId: input.providerId,
        accountId: input.accountId,
        accountSubject: input.accountSubject,
        chatgptAccountId: input.chatgptAccountId,
        email: input.email,
        planType: input.planType,
        availabilityState: input.availabilityState ?? "descriptor",
        warmRequestCount: 0,
        lastRoutedAt: undefined,
        importedAt: undefined,
        metadata: input.metadata ?? {},
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
      };
      projectedAccounts.set(key, record);
      return record;
    },
    appendDiffEvent: async (input: Record<string, unknown>) => {
      diffEvents.push(input);
      return {
        seq: diffEvents.length,
        ownerSubject: input.ownerSubject,
        entityType: input.entityType,
        entityKey: input.entityKey,
        op: input.op,
        payload: input.payload ?? {},
        createdAt: "2026-03-27T00:00:00.000Z",
      };
    },
  };

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    proxySettingsStore,
    sqlFederationStore: sqlFederationStore as never,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/ui/federation/sync/pull",
      headers: {
        authorization: "Bearer bridge-admin-token",
        "content-type": "application/json",
      },
      payload: {
        peerId: "peer-1",
        ownerSubject: "did:web:proxx.promethean.rest:brethren",
        pullUsage: false,
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      readonly importedProjectedAccountsCount: number;
      readonly remoteDiffCount: number;
    };
    assert.equal(payload.importedProjectedAccountsCount, 1);
    assert.equal(payload.remoteDiffCount, 0);
    assert.equal(projectedAccounts.size, 1);
    const imported = [...projectedAccounts.values()][0] as { readonly providerId: string; readonly accountId: string; readonly sourcePeerId: string; readonly metadata: Record<string, unknown> };
    assert.equal(imported.providerId, "openai");
    assert.equal(imported.accountId, "acct-1");
    assert.equal(imported.sourcePeerId, "peer-1");
    assert.equal(imported.metadata.authType, "oauth_bearer");
    assert.equal(diffEvents.length, 1);
    assert.equal(diffEvents[0]?.entityType, "projected_account");
  } finally {
    await app.close();
    await remoteApp.close();
    await requestLogStore.close();
    await remoteRequestLogStore.close();
    await credentialStore.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
