import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withProxyApp(
  options: {
    readonly keysPayload: unknown;
    readonly proxyAuthToken: string;
    readonly upstreamHandler: (
      request: IncomingMessage,
      body: string,
    ) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;
  },
  fn: (ctx: { readonly app: FastifyInstance; readonly upstream: Server; readonly tempDir: string }) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "open-hax-proxy-websearch-test-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.json");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  await writeFile(keysPath, JSON.stringify(options.keysPayload, null, 2), "utf8");
  await writeFile(modelsPath, JSON.stringify({ models: ["gpt-5.3-codex"] }, null, 2), "utf8");

  const upstream = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const result = await options.upstreamHandler(request, body);
    response.statusCode = result.status;
    if (result.headers) {
      for (const [name, value] of Object.entries(result.headers)) {
        response.setHeader(name, value);
      }
    }
    response.end(result.body);
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve upstream server address");
  }

  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "vivgrid",
    upstreamFallbackProviderIds: [],
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${address.port}`,
      "ollama-cloud": `http://127.0.0.1:${address.port}`,
      openai: `http://127.0.0.1:${address.port}`,
      openrouter: `http://127.0.0.1:${address.port}`,
      requesty: `http://127.0.0.1:${address.port}`,
      gemini: `http://127.0.0.1:${address.port}`,
    },
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${address.port}`,
    ollamaBaseUrl: `http://127.0.0.1:${address.port}`,
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
    sessionsFilePath: path.join(tempDir, "sessions.json"),
    keyReloadMs: 50,
    keyCooldownMs: 10000,
    requestTimeoutMs: 2000,
    streamBootstrapTimeoutMs: 2000,
    upstreamTransientRetryCount: 1,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken: options.proxyAuthToken,
    allowUnauthenticated: false,
    databaseUrl: undefined,
    githubOAuthClientId: undefined,
    githubOAuthClientSecret: undefined,
    githubOAuthCallbackPath: "/auth/github/callback",
    githubAllowedUsers: [],
    sessionSecret: "test-session-token", // pragma: allowlist secret
  };

  const app = await createApp(config);
  try {
    await fn({ app, upstream, tempDir });
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

test("POST /api/tools/websearch uses OpenAI OAuth accounts and web_search tool", async () => {
  let observedPath = "";
  let observedBody: Record<string, unknown> | undefined;
  let observedAuth: string | undefined;

  await withProxyApp(
    {
      proxyAuthToken: "proxy-token",
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [{ id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" }],
          },
        },
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedAuth = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;

        if (request.url === "/v1/responses") {
          observedBody = JSON.parse(body);

          const terminal = {
            id: "resp-websearch-1",
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

          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: `data: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`,
          };
        }

        return {
          status: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "not_found" }),
        };
      },
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/tools/websearch",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json",
        },
        payload: {
          query: "pi extensions",
          model: "openai/gpt-5.3-codex",
          numResults: 3,
          searchContextSize: "low",
          allowedDomains: ["example.com"],
        },
      });

      assert.equal(response.statusCode, 200);
      const payload = response.json() as any;
      assert.equal(payload.query, "pi extensions");
      assert.equal(payload.model, "openai/gpt-5.3-codex");
      assert.equal(payload.responseId, "resp-websearch-1");
      assert.equal(payload.output.includes("Example result"), true);
      assert.ok(Array.isArray(payload.sources));
      assert.equal(payload.sources[0].url, "https://example.com");

      // Ensure upstream saw OAuth bearer and web_search tool.
      assert.equal(observedPath, "/v1/responses");
      assert.equal(observedAuth, "Bearer oa-token-a");
      assert.ok(observedBody);
      assert.equal(observedBody.model, "gpt-5.3-codex");
      assert.ok(Array.isArray(observedBody.tools));
      assert.equal((observedBody.tools?.[0] as any)?.type, "web_search");
      assert.equal((observedBody.tool_choice as any)?.type, "web_search");
    },
  );
});
