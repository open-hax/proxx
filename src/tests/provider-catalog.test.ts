import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderCatalogStore } from "../lib/provider-catalog.js";
import type { KeyPool, ProviderCredential } from "../lib/key-pool.js";
import type { ProxyConfig } from "../lib/config.js";
import type { ProviderRoute } from "../lib/provider-routing.js";

function buildMinimalConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "vivgrid",
    upstreamFallbackProviderIds: [],
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {},
    upstreamBaseUrl: "http://127.0.0.1:1",
    openaiProviderId: "openai",
    openaiBaseUrl: "http://127.0.0.1:1",
    openaiApiBaseUrl: "http://127.0.0.1:1",
    openaiImagesUpstreamMode: "auto",
    ollamaBaseUrl: "http://127.0.0.1:1",
    localOllamaEnabled: false,
    localOllamaModelPatterns: [],
    chatCompletionsPath: "/v1/chat/completions",
    openaiChatCompletionsPath: "/v1/chat/completions",
    messagesPath: "/v1/messages",
    messagesModelPrefixes: ["claude-"],
    messagesInterleavedThinkingBeta: "",
    responsesPath: "/v1/responses",
    openaiResponsesPath: "/codex/responses",
    openaiImagesGenerationsPaths: [],
    imageCostUsdDefault: 0,
    imageCostUsdByProvider: {},
    imagesGenerationsPath: "/v1/images/generations",
    responsesModelPrefixes: ["gpt-"],
    ollamaChatPath: "/api/chat",
    ollamaV1ChatPath: "/v1/chat/completions",
    factoryModelPrefixes: ["factory/", "factory:"],
    openaiModelPrefixes: ["openai/", "openai:"],
    ollamaModelPrefixes: ["ollama/", "ollama:"],
    keysFilePath: "",
    modelsFilePath: "",
    requestLogsFilePath: "",
    requestLogsMaxEntries: 1000,
    requestLogsFlushMs: 0,
    promptAffinityFilePath: "",
    promptAffinityFlushMs: 0,
    settingsFilePath: "",
    keyReloadMs: 5000,
    keyCooldownMs: 10000,
    requestTimeoutMs: 180000,
    streamBootstrapTimeoutMs: 5000,
    upstreamTransientRetryCount: 2,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken: undefined,
    allowUnauthenticated: true,
    databaseUrl: undefined,
    githubOAuthClientId: undefined,
    githubOAuthClientSecret: undefined,
    githubOAuthCallbackPath: "/auth/github/callback",
    githubAllowedUsers: [],
    sessionSecret: "test",
    openaiOauthScopes: "",
    openaiOauthClientId: "",
    openaiOauthIssuer: "",
    proxyTokenPepper: "test-pepper",
    oauthRefreshMaxConcurrency: 32,
    oauthRefreshBackgroundIntervalMs: 15000,
    oauthRefreshProactiveWindowMs: 1800000,
    ...overrides,
  };
}

function buildMockKeyPool(accountsByProvider: Map<string, ProviderCredential[]>): KeyPool {
  return {
    async getAllAccounts(providerId: string): Promise<ProviderCredential[]> {
      return accountsByProvider.get(providerId) ?? [];
    },
  } as unknown as KeyPool;
}

function buildTestAccount(providerId: string, token = "test-token"): ProviderCredential {
  return {
    providerId,
    accountId: `${providerId}-account-1`,
    token,
    authType: "api_key",
  };
}

test("getCatalog completes within timeout when a route endpoint is unresponsive", async () => {
  // Regression: a dead federation peer at federation.big.ussy.promethean.rest caused
  // getCatalog() to block all /v1/chat/completions and /v1/responses requests for
  // ~38 minutes (45s per-account timeout × 51 ollama-cloud accounts).
  // Each test here intentionally hangs a server, so expect ~15s per test (CATALOG_ROUTE_TIMEOUT_MS).
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "catalog-test-"));

  const modelsPath = path.join(tempDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ models: [] }), "utf8");

  const hangingServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[");
    // Never finish the response — the connection stays open forever.
  });

  hangingServer.listen(0, "127.0.0.1");
  await once(hangingServer, "listening");
  const hangingAddress = hangingServer.address();
  if (!hangingAddress || typeof hangingAddress === "string") {
    throw new Error("Failed to resolve hanging server address");
  }

  const responsiveServer = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "responsive-model" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  responsiveServer.listen(0, "127.0.0.1");
  await once(responsiveServer, "listening");
  const responsiveAddress = responsiveServer.address();
  if (!responsiveAddress || typeof responsiveAddress === "string") {
    throw new Error("Failed to resolve responsive server address");
  }

  try {
    const hangingRoute: ProviderRoute = {
      providerId: "hanging-provider",
      baseUrl: `http://127.0.0.1:${hangingAddress.port}`,
    };
    const responsiveRoute: ProviderRoute = {
      providerId: "responsive-provider",
      baseUrl: `http://127.0.0.1:${responsiveAddress.port}`,
    };

    const accounts = new Map<string, ProviderCredential[]>([
      ["hanging-provider", [buildTestAccount("hanging-provider")]],
      ["responsive-provider", [buildTestAccount("responsive-provider")]],
    ]);

    const config = buildMinimalConfig({ modelsFilePath: modelsPath });
    const keyPool = buildMockKeyPool(accounts);

    const store = new ProviderCatalogStore(config, keyPool, [hangingRoute, responsiveRoute], []);

    const start = Date.now();
    const catalog = await store.getCatalog(true);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 20_000,
      `getCatalog should complete within 20s despite hanging route, took ${elapsed}ms`,
    );

    assert.ok(
      catalog.providerCatalogs["responsive-provider"],
      "responsive provider should appear in catalog",
    );
    assert.deepEqual(
      [...catalog.providerCatalogs["responsive-provider"].modelIds],
      ["responsive-model"],
    );
    assert.ok(
      !catalog.providerCatalogs["hanging-provider"],
      "hanging provider should NOT appear in catalog",
    );
  } finally {
    hangingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      hangingServer.close((err) => (err ? reject(err) : resolve()));
    });
    responsiveServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      responsiveServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("getCatalog returns empty catalog when all routes time out", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "catalog-test-"));

  const modelsPath = path.join(tempDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ models: [] }), "utf8");

  const slowServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[");
    // Hang forever
  });

  slowServer.listen(0, "127.0.0.1");
  await once(slowServer, "listening");
  const slowAddress = slowServer.address();
  if (!slowAddress || typeof slowAddress === "string") {
    throw new Error("Failed to resolve slow server address");
  }

  try {
    const slowRoute: ProviderRoute = {
      providerId: "slow-provider",
      baseUrl: `http://127.0.0.1:${slowAddress.port}`,
    };

    const accounts = new Map<string, ProviderCredential[]>([
      ["slow-provider", [buildTestAccount("slow-provider")]],
    ]);

    const config = buildMinimalConfig({ modelsFilePath: modelsPath });
    const keyPool = buildMockKeyPool(accounts);

    const store = new ProviderCatalogStore(config, keyPool, [slowRoute], []);

    const start = Date.now();
    const catalog = await store.getCatalog(true);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 20_000,
      `getCatalog should complete within 20s even when all routes hang, took ${elapsed}ms`,
    );

    assert.ok(
      !catalog.providerCatalogs["slow-provider"],
      "slow provider should NOT appear in catalog",
    );
    assert.equal(catalog.catalog.modelIds.length, 0, "catalog should have no discovered models");
  } finally {
    slowServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      slowServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});
