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