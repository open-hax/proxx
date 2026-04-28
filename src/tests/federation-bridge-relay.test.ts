import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { WebSocket } from "ws";

import { createApp } from "../app.js";
import type { SqlAuthPersistence } from "../lib/auth/sql-persistence.js";
import type { AccessToken } from "../lib/auth/types.js";
import type { ProxyConfig } from "../lib/config.js";
import { CredentialStore } from "../lib/credential-store.js";
import type { ResolvedUiSession, SqlCredentialStore } from "../lib/db/sql-credential-store.js";
import { KeyPool } from "../lib/key-pool.js";
import { ProxySettingsStore } from "../lib/proxy-settings-store.js";
import { RequestLogStore } from "../lib/request-log-store.js";
import { BRIDGE_PROTOCOL_VERSION } from "../lib/federation/bridge-protocol.js";
import { registerApiV1Routes } from "../routes/api/v1/index.js";
import { registerWebSocketRoutes } from "../routes/api/ui/ws.js";

interface BridgeTestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
  readonly baseUrl: string;
  readonly wsUrl: string;
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
    keyCooldownJitterFactor: 0.4,
    enableKeyRandomWalk: true,
    ollamaWeeklyCooldownMultiplier: 24,
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

  const config = buildConfig({
    upstreamPort: upstreamAddress.port,
    paths: { keysPath, modelsPath, requestLogsPath, promptAffinityPath, settingsPath },
    proxyAuthToken: options.proxyAuthToken ?? "bridge-admin-token",
  });

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

async function withTenantScopedBridgeUiApp(
  fn: (ctx: BridgeTestContext) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-bridge-relay-tenant-test-"));
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
      return;
    }

    if (authorization === "Bearer tenant-admin-token") {
      mutableRequest.openHaxAuth = {
        kind: "ui_session",
        tenantId: "tenant-a",
        role: "admin",
        source: "bearer",
        userId: "user-tenant-a",
        subject: "did:example:tenant-admin-a",
        memberships: [{ tenantId: "tenant-a", tenantName: "Tenant A", tenantStatus: "active", role: "admin" }],
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

  const accessTokens = new Map<string, AccessToken>([
    ["tenant-admin-token", {
      token: "tenant-admin-token",
      clientId: "test-client",
      subject: "did:example:tenant-admin-a",
      scopes: [],
      extra: { activeTenantId: "tenant-a" },
      expiresAt: Date.now() + 60_000,
    }],
  ]);

  const sessions = new Map<string, ResolvedUiSession>([
    ["did:example:tenant-admin-a", {
      userId: "user-tenant-a",
      subject: "did:example:tenant-admin-a",
      activeTenantId: "tenant-a",
      role: "admin",
      memberships: [{ tenantId: "tenant-a", tenantName: "Tenant A", tenantStatus: "active", role: "admin" }],
    }],
  ]);

  const authPersistence = {
    getAccessToken: async (token: string) => accessTokens.get(token),
  } as Pick<SqlAuthPersistence, "getAccessToken"> as SqlAuthPersistence;

  const sqlCredentialStore = {
    resolveTenantApiKey: async () => undefined,
    resolveUiSession: async (subject: string) => sessions.get(subject),
  } as Pick<SqlCredentialStore, "resolveTenantApiKey" | "resolveUiSession"> as SqlCredentialStore;

  const { bridgeRelay } = await registerWebSocketRoutes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    sqlCredentialStore,
    authPersistence,
    proxySettingsStore,
  });
  await registerApiV1Routes(app, {
    config,
    keyPool,
    requestLogStore,
    credentialStore,
    sqlCredentialStore,
    authPersistence,
    proxySettingsStore,
    bridgeRelay,
  });

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
    await requestLogStore.close();
    await credentialStore.close();
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
      url: "/api/v1/federation/bridges",
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
      url: `/api/v1/federation/bridges/${helloAck.sessionId as string}`,
      headers: { authorization: "Bearer bridge-admin-token" },
    });
    assert.equal(detailResponse.statusCode, 200);
    const detailPayload = detailResponse.json() as { readonly session: Record<string, unknown> };
    assert.equal(detailPayload.session.peerDid, "did:web:local.promethean.rest");

    ws.close();
    await once(ws, "close");

    const afterCloseResponse = await app.inject({
      method: "GET",
      url: `/api/v1/federation/bridges/${helloAck.sessionId as string}`,
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
      url: "/api/v1/federation/bridge/ws",
      headers: { authorization: "Bearer bridge-admin-token" },
    });

    assert.equal(response.statusCode, 426);
    assert.equal(response.headers.upgrade, "websocket");
    assert.deepEqual(response.json(), { error: "websocket_upgrade_required" });
  });
});

test("bridge relay list/detail endpoints scope sessions to tenant admins", async () => {
  await withTenantScopedBridgeUiApp(async ({ app, wsUrl }) => {
    const tenantAdminWs = await openWebSocket(wsUrl, {
      Authorization: "Bearer tenant-admin-token",
    });
    tenantAdminWs.send(JSON.stringify({
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sentAt: "2026-03-23T06:10:00.000Z",
      traceId: "trace-tenant-a-hello",
      ownerSubject: "did:plc:tenant-a-owner",
      clusterId: "tenant-a-cluster",
      agentId: "tenant-a-agent",
      peerDid: "did:web:tenant-a.promethean.rest",
      environment: "local",
      bridgeAgentVersion: "0.1.0",
      authMode: "admin_key",
      labels: ["tenant-a"],
    }));
    const tenantAdminAck = await nextJsonMessage(tenantAdminWs);

    const globalWs = await openWebSocket(wsUrl, {
      Authorization: "Bearer bridge-admin-token",
    });
    globalWs.send(JSON.stringify({
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sentAt: "2026-03-23T06:10:01.000Z",
      traceId: "trace-default-hello",
      ownerSubject: "did:plc:default-owner",
      clusterId: "default-cluster",
      agentId: "default-agent",
      peerDid: "did:web:default.promethean.rest",
      environment: "local",
      bridgeAgentVersion: "0.1.0",
      authMode: "admin_key",
      labels: ["default"],
    }));
    const globalAck = await nextJsonMessage(globalWs);

    const globalListResponse = await app.inject({
      method: "GET",
      url: "/api/v1/federation/bridges",
      headers: { authorization: "Bearer bridge-admin-token" },
    });
    assert.equal(globalListResponse.statusCode, 200);
    const globalListPayload = globalListResponse.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
    assert.equal(globalListPayload.sessions.length, 2);

    const tenantListResponse = await app.inject({
      method: "GET",
      url: "/api/v1/federation/bridges",
      headers: { authorization: "Bearer tenant-admin-token" },
    });
    assert.equal(tenantListResponse.statusCode, 200);
    const tenantListPayload = tenantListResponse.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
    assert.equal(tenantListPayload.sessions.length, 1);
    assert.equal(tenantListPayload.sessions[0]?.sessionId, tenantAdminAck.sessionId);
    assert.equal(tenantListPayload.sessions[0]?.state, "connected");

    const tenantOwnDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/federation/bridges/${tenantAdminAck.sessionId as string}`,
      headers: { authorization: "Bearer tenant-admin-token" },
    });
    assert.equal(tenantOwnDetailResponse.statusCode, 200);

    const tenantOtherDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/federation/bridges/${globalAck.sessionId as string}`,
      headers: { authorization: "Bearer tenant-admin-token" },
    });
    assert.equal(tenantOtherDetailResponse.statusCode, 404);

    tenantAdminWs.close();
    await once(tenantAdminWs, "close");
    globalWs.close();
    await once(globalWs, "close");

    const globalAfterCloseResponse = await app.inject({
      method: "GET",
      url: "/api/v1/federation/bridges",
      headers: { authorization: "Bearer bridge-admin-token" },
    });
    assert.equal(globalAfterCloseResponse.statusCode, 200);
    const globalAfterClosePayload = globalAfterCloseResponse.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
    assert.equal(globalAfterClosePayload.sessions.length, 2);
    assert.ok(globalAfterClosePayload.sessions.every((session) => session.state === "disconnected"));

    const tenantAfterCloseResponse = await app.inject({
      method: "GET",
      url: "/api/v1/federation/bridges",
      headers: { authorization: "Bearer tenant-admin-token" },
    });
    assert.equal(tenantAfterCloseResponse.statusCode, 200);
    const tenantAfterClosePayload = tenantAfterCloseResponse.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
    assert.equal(tenantAfterClosePayload.sessions.length, 1);
    assert.equal(tenantAfterClosePayload.sessions[0]?.sessionId, tenantAdminAck.sessionId);
    assert.equal(tenantAfterClosePayload.sessions[0]?.state, "disconnected");

    const tenantOtherAfterCloseDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/federation/bridges/${globalAck.sessionId as string}`,
      headers: { authorization: "Bearer tenant-admin-token" },
    });
    assert.equal(tenantOtherAfterCloseDetailResponse.statusCode, 404);
  });
});
