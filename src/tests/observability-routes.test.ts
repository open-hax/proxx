import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";

function buildConfig(input: {
  readonly upstreamPort: number;
  readonly paths: {
    readonly keysPath: string;
    readonly modelsPath: string;
    readonly requestLogsPath: string;
    readonly promptAffinityPath: string;
    readonly settingsPath: string;
  };
}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "vivgrid",
    upstreamFallbackProviderIds: [],
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${input.upstreamPort}`,
      openai: `http://127.0.0.1:${input.upstreamPort}`,
      ob1: `http://127.0.0.1:${input.upstreamPort}`,
      "ollama-cloud": `http://127.0.0.1:${input.upstreamPort}`,
      requesty: `http://127.0.0.1:${input.upstreamPort}`,
      openrouter: `http://127.0.0.1:${input.upstreamPort}`,
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
    localOllamaModelPatterns: [":2b", ":3b", ":4b"],
    chatCompletionsPath: "/v1/chat/completions",
    openaiChatCompletionsPath: "/v1/chat/completions",
    messagesPath: "/v1/messages",
    messagesModelPrefixes: ["claude-"],
    messagesInterleavedThinkingBeta: "interleaved-thinking-2025-05-14",
    responsesPath: "/v1/responses",
    openaiResponsesPath: "/v1/responses",
    openaiImagesGenerationsPaths: ["/v1/images/generations"],
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
    requestLogsMaxEntries: 5000,
    requestLogsFlushMs: 0,
    promptAffinityFilePath: input.paths.promptAffinityPath,
    promptAffinityFlushMs: 0,
    settingsFilePath: input.paths.settingsPath,
    keyReloadMs: 50,
    keyCooldownMs: 10_000,
    keyCooldownJitterFactor: 0.4,
    enableKeyRandomWalk: false,
    ollamaWeeklyCooldownMultiplier: 24,
    requestTimeoutMs: 2_000,
    streamBootstrapTimeoutMs: 2_000,
    embedMaxContextTokens: 262144,
    embedMaxBatchItems: 128,
    embedMaxInputChars: 250000,
    upstreamTransientRetryCount: 0,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken: "test-token", // pragma: allowlist secret
    allowUnauthenticated: true,
    databaseUrl: undefined,
    githubOAuthClientId: undefined,
    githubOAuthClientSecret: undefined,
    githubOAuthCallbackPath: "/auth/github/callback",
    githubAllowedUsers: [],
    sessionSecret: "test-session-token", // pragma: allowlist secret
    openaiOauthScopes: "openid profile email offline_access",
    openaiOauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    openaiOauthIssuer: "https://auth.openai.com",
    proxyTokenPepper: "test-proxy-token-pepper",
    oauthRefreshMaxConcurrency: 1,
    oauthRefreshBackgroundIntervalMs: 60_000,
    oauthRefreshProactiveWindowMs: 60_000,
    concurrencyThrottleMaxRetries: 0,
    concurrencyThrottleThresholdMs: 30_000,
  };
}

function handleUpstreamRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "/";
  res.setHeader("content-type", "application/json");
  if (url.startsWith("/v1/models")) {
    res.statusCode = 200;
    res.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}

test("createApp registers /api/ui observability endpoints", async () => {
  const upstream: Server = createServer(handleUpstreamRequest);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  const addr = upstream.address();
  assert.ok(addr && typeof addr === "object");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-observability-routes-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ providers: [] }, null, 2));
  await writeFile(modelsPath, JSON.stringify({ models: [] }, null, 2));
  await writeFile(promptAffinityPath, JSON.stringify({ entries: [] }, null, 2));
  await writeFile(settingsPath, JSON.stringify({ tenants: {} }, null, 2));

  const app = await createApp(buildConfig({
    upstreamPort: addr.port,
    paths: {
      keysPath,
      modelsPath,
      requestLogsPath,
      promptAffinityPath,
      settingsPath,
    },
  }));

  try {
    const overviewResponse = await app.inject({
      method: "GET",
      url: "/api/ui/dashboard/overview?window=daily",
    });

    assert.equal(overviewResponse.statusCode, 200);
    const overview = overviewResponse.json();
    assert.equal(overview.window, "daily");
    assert.ok(overview.summary);

    const logsResponse = await app.inject({
      method: "GET",
      url: "/api/ui/request-logs?limit=5",
    });

    assert.equal(logsResponse.statusCode, 200);
    const logs = logsResponse.json();
    assert.ok(Array.isArray(logs.entries));
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});
