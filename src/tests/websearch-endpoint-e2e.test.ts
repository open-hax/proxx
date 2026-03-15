import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("e2e: /api/tools/websearch works over HTTP and uses OAuth bearer upstream", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "open-hax-proxy-websearch-e2e-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.json");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");
  const sessionsPath = path.join(tempDir, "sessions.json");

  const proxyAuthToken = "proxy-token";

  await writeFile(
    keysPath,
    JSON.stringify(
      {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [{ id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" }],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(modelsPath, JSON.stringify({ models: ["gpt-5.3-codex"] }, null, 2), "utf8");

  let observedUpstreamPath = "";
  let observedUpstreamAuth: string | undefined;
  let observedUpstreamBody: any;

  const upstream: Server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    observedUpstreamPath = request.url ?? "";
    observedUpstreamAuth =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;

    if (request.url === "/v1/responses") {
      observedUpstreamBody = JSON.parse(body);

      const terminal = {
        id: "resp-websearch-e2e",
        object: "response",
        output_text: "- Example result (https://example.com)\\n  snippet",
        output: [
          {
            type: "web_search_call",
            action: {
              sources: [{ url: "https://example.com", title: "Example" }],
            },
          },
        ],
      };

      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`,
      );
      return;
    }

    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "not_found" }));
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddr = upstream.address();
  assert.ok(upstreamAddr && typeof upstreamAddr !== "string");

  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "openai",
    upstreamFallbackProviderIds: [],
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${upstreamAddr.port}`,
      "ollama-cloud": `http://127.0.0.1:${upstreamAddr.port}`,
      openai: `http://127.0.0.1:${upstreamAddr.port}`,
      openrouter: `http://127.0.0.1:${upstreamAddr.port}`,
      requesty: `http://127.0.0.1:${upstreamAddr.port}`,
      gemini: `http://127.0.0.1:${upstreamAddr.port}`,
    },
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${upstreamAddr.port}`,
    ollamaBaseUrl: `http://127.0.0.1:${upstreamAddr.port}`,
    localOllamaEnabled: false,
    localOllamaModelPatterns: [],
    chatCompletionsPath: "/v1/chat/completions",
    openaiChatCompletionsPath: "/v1/chat/completions",
    messagesPath: "/v1/messages",
    messagesModelPrefixes: ["claude-"],
    messagesInterleavedThinkingBeta: "interleaved-thinking-2025-05-14",
    responsesPath: "/v1/responses",
    openaiResponsesPath: "/v1/responses",
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
    promptAffinityFilePath: promptAffinityPath,
    settingsFilePath: settingsPath,
    sessionsFilePath: sessionsPath,
    keyReloadMs: 50,
    keyCooldownMs: 10000,
    requestTimeoutMs: 2000,
    streamBootstrapTimeoutMs: 2000,
    upstreamTransientRetryCount: 1,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken,
    allowUnauthenticated: false,
    databaseUrl: undefined,
    githubOAuthClientId: undefined,
    githubOAuthClientSecret: undefined,
    githubOAuthCallbackPath: "/auth/github/callback",
    githubAllowedUsers: [],
    sessionSecret: "test-session-token", // pragma: allowlist secret
  };

  const app = await createApp(config);

  let proxyPort = 0;
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    assert.ok(addr && typeof addr !== "string");
    proxyPort = addr.port;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/tools/websearch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxyAuthToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: "pi extensions",
        model: "openai/gpt-5.3-codex",
        numResults: 3,
        searchContextSize: "low",
        allowedDomains: ["example.com"],
      }),
    });

    assert.equal(res.status, 200);
    const payload = (await res.json()) as any;

    assert.equal(payload.query, "pi extensions");
    assert.equal(payload.model, "openai/gpt-5.3-codex");
    assert.equal(payload.responseId, "resp-websearch-e2e");
    assert.ok(typeof payload.output === "string" && payload.output.includes("Example result"));
    assert.ok(Array.isArray(payload.sources));
    assert.equal(payload.sources[0].url, "https://example.com");

    assert.equal(observedUpstreamPath, "/v1/responses");
    assert.equal(observedUpstreamAuth, "Bearer oa-token-a");
    assert.ok(Array.isArray(observedUpstreamBody?.tools));
    assert.equal(observedUpstreamBody.tools?.[0]?.type, "web_search");
    assert.equal(observedUpstreamBody.tool_choice?.type, "web_search");
    assert.equal(observedUpstreamBody.model, "gpt-5.3-codex");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});
