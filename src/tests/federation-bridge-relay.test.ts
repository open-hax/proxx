import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";
import { BRIDGE_PROTOCOL_VERSION } from "../lib/federation/bridge-protocol.js";

interface BridgeTestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
  readonly baseUrl: string;
  readonly wsUrl: string;
}

async function withBridgeApp(
  fn: (ctx: BridgeTestContext) => Promise<void>,
  options: { readonly proxyAuthToken?: string } = {},
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-bridge-relay-test-"));
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

  const baseUrl = `http://127.0.0.1:${appAddress.port}`;
  const wsUrl = `ws://127.0.0.1:${appAddress.port}/api/ui/federation/bridge/ws`;

  try {
    await fn({ app, upstream, tempDir, baseUrl, wsUrl });
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

async function openWebSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  await once(ws, "open");
  return ws;
}

async function nextJsonMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(ws, "message");
  const text = typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

test("bridge relay accepts hello over websocket and exposes the session over HTTP", async () => {
  await withBridgeApp(async ({ app, wsUrl }) => {
    const ws = await openWebSocket(wsUrl, {
      Authorization: "Bearer bridge-admin-token",
    });

    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sentAt: "2026-03-23T06:00:00.000Z",
      traceId: "trace-hello-1",
      ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
      clusterId: "local-dev",
      agentId: "cluster-agent-1",
      peerDid: "did:web:local.promethean.rest",
      environment: "local",
      bridgeAgentVersion: "0.1.0",
      authMode: "admin_key",
      labels: ["bridge-test"],
      topology: {
        groups: [{ groupId: "group-a", nodeIds: ["a1", "a2"] }],
        nodes: [{ groupId: "group-a", nodeId: "a1", labels: ["default"] }],
        defaultExecutionPolicy: "group_affinity",
      },
    }));

    const helloAck = await nextJsonMessage(ws);
    assert.equal(helloAck.type, "hello_ack");
    assert.equal(helloAck.protocolVersion, BRIDGE_PROTOCOL_VERSION);
    assert.equal(typeof helloAck.sessionId, "string");
    assert.ok(String(helloAck.sessionId).length > 0);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/ui/federation/bridges",
      headers: { authorization: "Bearer bridge-admin-token" },
    });
    assert.equal(listResponse.statusCode, 200);
    const listPayload = listResponse.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
    assert.equal(listPayload.sessions.length, 1);
    assert.equal(listPayload.sessions[0]?.clusterId, "local-dev");
    assert.equal(listPayload.sessions[0]?.agentId, "cluster-agent-1");
    assert.equal(listPayload.sessions[0]?.state, "connected");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/ui/federation/bridges/${helloAck.sessionId as string}`,
      headers: { authorization: "Bearer bridge-admin-token" },
    });
    assert.equal(detailResponse.statusCode, 200);
    const detailPayload = detailResponse.json() as { readonly session: Record<string, unknown> };
    assert.equal(detailPayload.session.peerDid, "did:web:local.promethean.rest");

    ws.close();
    await once(ws, "close");

    const afterCloseResponse = await app.inject({
      method: "GET",
      url: `/api/ui/federation/bridges/${helloAck.sessionId as string}`,
      headers: { authorization: "Bearer bridge-admin-token" },
    });
    assert.equal(afterCloseResponse.statusCode, 200);
    const afterClosePayload = afterCloseResponse.json() as { readonly session: Record<string, unknown> };
    assert.equal(afterClosePayload.session.state, "disconnected");
  });
});

test("bridge relay returns a typed stub error for request execution frames", async () => {
  await withBridgeApp(async ({ wsUrl }) => {
    const ws = await openWebSocket(wsUrl, {
      Authorization: "Bearer bridge-admin-token",
    });

    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sentAt: "2026-03-23T06:01:00.000Z",
      traceId: "trace-hello-2",
      ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
      clusterId: "local-dev",
      agentId: "cluster-agent-2",
      peerDid: "did:web:local.promethean.rest",
      environment: "local",
      bridgeAgentVersion: "0.1.0",
      authMode: "admin_key",
      labels: ["bridge-test"],
    }));
    const helloAck = await nextJsonMessage(ws);

    ws.send(JSON.stringify({
      type: "request_open",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: helloAck.sessionId,
      streamId: "stream-1",
      sentAt: "2026-03-23T06:01:01.000Z",
      traceId: "trace-request-open-1",
      ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
      clusterId: "local-dev",
      agentId: "cluster-agent-2",
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      routingIntent: { providerId: "openai", model: "gpt-5.2" },
      hopCount: 0,
    }));

    const errorPayload = await nextJsonMessage(ws);
    assert.equal(errorPayload.type, "error");
    assert.equal(errorPayload.code, "bridge_execution_not_implemented");
    assert.equal(errorPayload.sessionId, helloAck.sessionId);
    assert.equal(errorPayload.streamId, "stream-1");

    ws.close();
    await once(ws, "close");
  });
});

test("bridge websocket HTTP route requires websocket upgrade", async () => {
  await withBridgeApp(async ({ app }) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/ui/federation/bridge/ws",
      headers: { authorization: "Bearer bridge-admin-token" },
    });

    assert.equal(response.statusCode, 426);
    assert.equal(response.headers.upgrade, "websocket");
    assert.deepEqual(response.json(), { error: "websocket_upgrade_required" });
  });
});
