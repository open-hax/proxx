import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createFixtureDir(prefix: string): Promise<{ readonly tempDir: string; readonly configPaths: {
  readonly keysPath: string;
  readonly modelsPath: string;
  readonly requestLogsPath: string;
  readonly promptAffinityPath: string;
  readonly settingsPath: string;
} }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

  return {
    tempDir,
    configPaths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
  };
}

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
    keyCooldownJitterFactor: 0.4,
    enableKeyRandomWalk: true,
    ollamaWeeklyCooldownMultiplier: 24,
    requestTimeoutMs: 2_000,
    streamBootstrapTimeoutMs: 2_000,
    embedMaxContextTokens: 262144,
    embedMaxBatchItems: 128,
    embedMaxInputChars: 250000,
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
    concurrencyThrottleMaxRetries: 3,
    concurrencyThrottleThresholdMs: 30_000,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("createApp auto-starts the federation bridge agent from env", async () => {
  const relayFixture = await createFixtureDir("proxx-bridge-autostart-relay-");
  const localFixture = await createFixtureDir("proxx-bridge-autostart-local-");

  const upstream = createServer((_request, response) => {
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

  let relayApp: FastifyInstance | undefined;
  let localApp: FastifyInstance | undefined;

  try {
    relayApp = await createApp(buildConfig({
      upstreamPort: upstreamAddress.port,
      paths: relayFixture.configPaths,
      proxyAuthToken: "bridge-admin-token",
    }));
    await relayApp.listen({ host: "127.0.0.1", port: 0 });
    const relayAddress = relayApp.server.address();
    if (!relayAddress || typeof relayAddress === "string") {
      throw new Error("failed to resolve relay app address");
    }

    await withEnv({
      FEDERATION_BRIDGE_RELAY_URL: `ws://127.0.0.1:${relayAddress.port}/api/ui/federation/bridge/ws`,
      FEDERATION_BRIDGE_AUTH_TOKEN: "bridge-admin-token",
      FEDERATION_BRIDGE_AGENT_ID: "local-cluster-agent",
      FEDERATION_DEFAULT_OWNER_SUBJECT: "did:plc:z72i7hdynmk6r22z27h6tvur",
      FEDERATION_SELF_PEER_DID: "did:web:local.promethean.rest",
      FEDERATION_SELF_CLUSTER_ID: "local-dev",
      FEDERATION_SELF_GROUP_ID: "group-a",
      FEDERATION_SELF_NODE_ID: "a1",
      FEDERATION_BRIDGE_LABELS: "auto-start,local",
      FEDERATION_BRIDGE_NODE_LABELS: "default",
      FEDERATION_BRIDGE_DEFAULT_EXECUTION_POLICY: "node_affinity",
      FEDERATION_BRIDGE_ENVIRONMENT: "local",
    }, async () => {
      localApp = await createApp(buildConfig({
        upstreamPort: upstreamAddress.port,
        paths: localFixture.configPaths,
        proxyAuthToken: "local-admin-token",
      }));
      await localApp.listen({ host: "127.0.0.1", port: 0 });

      // Wait for bridge agent to announce connection to relay (state-based, not timing-dependent)
      await waitFor(async () => {
        const response = await relayApp!.inject({
          method: "GET",
          url: "/api/v1/federation/bridges",
          headers: { authorization: "Bearer bridge-admin-token" },
        });
        assert.equal(response.statusCode, 200);
        const payload = response.json() as { readonly sessions: ReadonlyArray<{ state: string }> };
        return payload.sessions.some((session) => session.state === "connected");
      }, 5_000);

      const connectedResponse = await relayApp!.inject({
        method: "GET",
        url: "/api/v1/federation/bridges",
        headers: { authorization: "Bearer bridge-admin-token" },
      });
      assert.equal(connectedResponse.statusCode, 200);
      const connectedPayload = connectedResponse.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
      assert.equal(connectedPayload.sessions.length, 1);
      assert.equal(connectedPayload.sessions[0]?.agentId, "local-cluster-agent");
      assert.equal(connectedPayload.sessions[0]?.clusterId, "local-dev");
      assert.equal(connectedPayload.sessions[0]?.state, "connected");

      await localApp.close();
      localApp = undefined;

      await waitFor(async () => {
        const response = await relayApp!.inject({
          method: "GET",
          url: "/api/v1/federation/bridges",
          headers: { authorization: "Bearer bridge-admin-token" },
        });
        assert.equal(response.statusCode, 200);
        const payload = response.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
        return payload.sessions[0]?.state === "disconnected";
      });
    });
  } finally {
    if (localApp) {
      await localApp.close();
    }
    if (relayApp) {
      await relayApp.close();
    }
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(relayFixture.tempDir, { recursive: true, force: true });
    await rm(localFixture.tempDir, { recursive: true, force: true });
  }
});
