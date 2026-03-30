import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";
import { createFederationBridgeAgent } from "../lib/federation/bridge-agent.js";
import { createFederationBridgeRelay } from "../lib/federation/bridge-relay.js";

interface BridgeTestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
  readonly wsUrl: string;
}

async function withBridgeApp(
  fn: (ctx: BridgeTestContext) => Promise<void>,
  options: { readonly proxyAuthToken?: string } = {},
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-bridge-agent-test-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify({ keys: ["test-key-1"] }, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ object: "list", data: [{ id: "gpt-5.2" }] }, null, 2), "utf8");

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

  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "vivgrid",
    upstreamFallbackProviderIds: [],
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${upstreamAddress.port}`,
      "ollama-cloud": `http://127.0.0.1:${upstreamAddress.port}`,
      ob1: `http://127.0.0.1:${upstreamAddress.port}`,
      openai: `http://127.0.0.1:${upstreamAddress.port}`,
      openrouter: `http://127.0.0.1:${upstreamAddress.port}`,
      requesty: `http://127.0.0.1:${upstreamAddress.port}`,
      gemini: `http://127.0.0.1:${upstreamAddress.port}`,
      zai: `http://127.0.0.1:${upstreamAddress.port}/api/paas/v4`,
      mistral: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    },
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    openaiApiBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    openaiImagesUpstreamMode: "auto",
    ollamaBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
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
    keysFilePath: keysPath,
    modelsFilePath: modelsPath,
    requestLogsFilePath: requestLogsPath,
    requestLogsMaxEntries: 100000,
    requestLogsFlushMs: 0,
    promptAffinityFilePath: promptAffinityPath,
    promptAffinityFlushMs: 0,
    settingsFilePath: settingsPath,
    keyReloadMs: 50,
    keyCooldownMs: 10_000,
    requestTimeoutMs: 2_000,
    streamBootstrapTimeoutMs: 2_000,
    upstreamTransientRetryCount: 1,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken: options.proxyAuthToken ?? "bridge-admin-token",
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

  const app = await createApp(config);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const appAddress = app.server.address();
  if (!appAddress || typeof appAddress === "string") {
    throw new Error("failed to resolve app address");
  }

  const wsUrl = `ws://127.0.0.1:${appAddress.port}/api/ui/federation/bridge/ws`;

  try {
    await fn({ app, upstream, tempDir, wsUrl });
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

test("bridge agent connects, publishes capabilities/health, and stops cleanly", async () => {
  await withBridgeApp(async ({ app, wsUrl }) => {
    const agent = createFederationBridgeAgent({
      relayUrl: wsUrl,
      authorization: "Bearer bridge-admin-token",
      ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
      peerDid: "did:web:local.promethean.rest",
      clusterId: "local-dev",
      agentId: "cluster-agent-1",
      environment: "local",
      bridgeAgentVersion: "0.1.0",
      authMode: "admin_key",
      labels: ["agent-test"],
      topology: {
        groups: [{ groupId: "group-a", nodeIds: ["a1", "a2"] }],
        nodes: [{ groupId: "group-a", nodeId: "a1", labels: ["default"] }],
        defaultExecutionPolicy: "group_affinity",
      },
      getCapabilities: async () => [{
        providerId: "openai",
        modelPrefixes: ["gpt-"],
        models: ["gpt-5.2"],
        authType: "oauth_bearer",
        accountCount: 4,
        availableAccountCount: 3,
        supportsModelsList: true,
        supportsChatCompletions: true,
        supportsResponses: true,
        supportsStreaming: true,
        supportsWarmImport: false,
        credentialMobility: "access_token_only",
        credentialOrigin: "localhost_oauth",
        lastHealthyAt: "2026-03-23T06:10:00.000Z",
        topologyTargets: [{ groupId: "group-a", nodeId: "a1" }],
      }],
      getHealth: async () => ({
        processHealthy: true,
        upstreamHealthy: true,
        availableAccountCount: 3,
        localOauthBootstrapReady: true,
        queuedRequests: 0,
        nodes: [{
          groupId: "group-a",
          nodeId: "a1",
          reachable: true,
          lastHealthyAt: "2026-03-23T06:10:00.000Z",
        }],
      }),
      reconnectMinMs: 100,
      reconnectMaxMs: 250,
    });

    await agent.start();

    await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/ui/federation/bridges",
        headers: { authorization: "Bearer bridge-admin-token" },
      });
      const payload = response.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
      const session = payload.sessions[0];
      return response.statusCode === 200
        && payload.sessions.length === 1
        && session?.state === "connected"
        && Array.isArray(session?.capabilities)
        && (session.capabilities as ReadonlyArray<Record<string, unknown>>).length === 1
        && typeof session.health === "object"
        && session.agentId === "cluster-agent-1";
    });

    const connectedSnapshot = agent.snapshot();
    assert.equal(connectedSnapshot.state, "connected");
    assert.ok(connectedSnapshot.sessionId);
    assert.equal(connectedSnapshot.reconnectAttempt, 0);

    await agent.stop();

    await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/ui/federation/bridges",
        headers: { authorization: "Bearer bridge-admin-token" },
      });
      const payload = response.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
      return payload.sessions[0]?.state === "disconnected";
    });

    const stoppedSnapshot = agent.snapshot();
    assert.equal(stoppedSnapshot.state, "stopped");
  });
});

test("bridge agent times out the hello handshake and retries in the background", async () => {
  const server = createServer();
  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.on("message", () => {
        // Intentionally never send hello_ack.
      });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve handshake timeout server address");
  }

  const agent = createFederationBridgeAgent({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    authorization: "Bearer bridge-admin-token",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    peerDid: "did:web:local.promethean.rest",
    clusterId: "local-dev",
    agentId: "cluster-agent-timeout",
    environment: "local",
    bridgeAgentVersion: "0.1.0",
    authMode: "admin_key",
    handshakeDeadlineMs: 50,
    reconnectMinMs: 25,
    reconnectMaxMs: 50,
  });

  try {
    await agent.start();

    await waitFor(async () => agent.snapshot().lastError?.code === "bridge_hello_ack_timeout", 1_000);

    const snapshot = agent.snapshot();
    assert.equal(snapshot.lastError?.code, "bridge_hello_ack_timeout");
    assert.notEqual(snapshot.state, "connected");
  } finally {
    await agent.stop();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("bridge relay requestStream preserves streamed chunks and provenance from the agent", async () => {
  const relay = createFederationBridgeRelay();
  const server = createServer();

  server.on("upgrade", (request, socket, head) => {
    relay.handleAuthorizedUpgrade(request, socket, head, {
      authKind: "legacy_admin",
      subject: "bridge-admin-token",
      tenantId: "default",
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve relay streaming server address");
  }

  const agent = createFederationBridgeAgent({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    authorization: "Bearer bridge-admin-token",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    peerDid: "did:web:local.promethean.rest",
    clusterId: "local-dev",
    agentId: "cluster-agent-streaming",
    environment: "local",
    bridgeAgentVersion: "0.1.0",
    authMode: "admin_key",
    reconnectMinMs: 25,
    reconnectMaxMs: 50,
    handleRequest: async () => (async function* () {
      yield {
        type: "response_head" as const,
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        servedByClusterId: "local-dev",
        servedByGroupId: "group-a",
        servedByNodeId: "a2",
        providerId: "openai",
        accountId: "acct-stream-1",
      };
      yield {
        type: "response_chunk" as const,
        chunk: "data: hello\n\n",
        encoding: "utf8" as const,
        servedByClusterId: "local-dev",
        servedByGroupId: "group-a",
        servedByNodeId: "a2",
        providerId: "openai",
        accountId: "acct-stream-1",
      };
      yield {
        type: "response_chunk" as const,
        chunk: "data: [DONE]\n\n",
        encoding: "utf8" as const,
        servedByClusterId: "local-dev",
        servedByGroupId: "group-a",
        servedByNodeId: "a3",
        providerId: "openai",
        accountId: "acct-stream-2",
      };
      yield {
        type: "response_end" as const,
        servedByClusterId: "local-dev",
        servedByGroupId: "group-a",
        servedByNodeId: "a3",
        providerId: "openai",
        accountId: "acct-stream-2",
      };
    })(),
  });

  try {
    await agent.start();
    await waitFor(async () => relay.listSessions().some((session) => session.state === "connected"), 1_000);

    const sessionId = relay.listSessions()[0]?.sessionId;
    assert.ok(sessionId);

    const events = [] as Array<{ readonly type: string; readonly servedByNodeId?: string; readonly accountId?: string; readonly chunk?: string }>;
    for await (const event of relay.requestStream(sessionId!, {
      method: "POST",
      path: "/v1/chat/completions",
      timeoutMs: 1_000,
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.2", stream: true }),
    })) {
      events.push({
        type: event.type,
        servedByNodeId: event.servedByNodeId,
        accountId: event.accountId,
        chunk: event.type === "response_chunk" ? event.chunk : undefined,
      });
    }

    assert.deepEqual(events.map((event) => event.type), ["response_head", "response_chunk", "response_chunk", "response_end"]);
    assert.equal(events[1]?.servedByNodeId, "a2");
    assert.equal(events[2]?.servedByNodeId, "a3");
    assert.equal(events[2]?.accountId, "acct-stream-2");
    assert.equal(events[1]?.chunk, "data: hello\n\n");
  } finally {
    await agent.stop();
    await relay.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
