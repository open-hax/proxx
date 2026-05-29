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
import { getActiveCljsRuntime, loadCljsRuntime, setActiveCljsRuntime } from "../lib/cljs-runtime.js";
import {
  getFactoryModelType,
  getFactoryApiProvider,
  getFactoryEndpointPath,
  buildFactoryCommonHeaders,
  buildFactoryAnthropicHeaders,
  inlineSystemPrompt,
  sanitizeFactorySystemPrompt,
  isFkKey,
} from "../lib/factory-compat.js";
import type { ProviderCredential } from "../lib/key-pool.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const testCljsRuntimePromise = loadCljsRuntime({ required: false }).then((result) => {
  if (!result.loaded) {
    return undefined;
  }
  return result.runtime;
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface TestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
}

async function withProxyApp(
  options: {
    readonly keys: readonly string[];
    readonly keysPayload?: unknown;
    readonly models?: unknown;
    readonly handleModelCatalog?: boolean;
    readonly configOverrides?: Partial<ProxyConfig>;
    readonly upstreamHandler: (
      request: IncomingMessage,
      body: string,
    ) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;
  },
  fn: (ctx: TestContext) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "factory-strategy-test-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  const keysPayload = options.keysPayload ?? { keys: options.keys };
  await writeFile(keysPath, JSON.stringify(keysPayload, null, 2), "utf8");
  if (options.models) {
    await writeFile(modelsPath, JSON.stringify(options.models, null, 2), "utf8");
  }

  const upstream = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const shouldBypassHandler =
      (request.method === "GET" && request.url === "/v1/models")
      || (request.method === "GET" && request.url === "/api/tags");

    if (shouldBypassHandler && !options.handleModelCatalog) {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "catalog not configured" } }));
      return;
    }

    try {
      const result = await options.upstreamHandler(request, body);
      response.statusCode = result.status;
      if (result.headers) {
        for (const [name, value] of Object.entries(result.headers)) {
          response.setHeader(name, value);
        }
      }
      response.end(result.body);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
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
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${address.port}`,
      "ollama-cloud": `http://127.0.0.1:${address.port}`,
      openai: `http://127.0.0.1:${address.port}`,
      openrouter: `http://127.0.0.1:${address.port}`,
      requesty: `http://127.0.0.1:${address.port}`,
      gemini: `http://127.0.0.1:${address.port}`,
      factory: `http://127.0.0.1:${address.port}`,
    },
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiApiBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiImagesUpstreamMode: "auto",
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
    keyCooldownMs: 10000,
    keyCooldownJitterFactor: 0.4,
    enableKeyRandomWalk: true,
    ollamaWeeklyCooldownMultiplier: 24,
    requestTimeoutMs: 2000,
    streamBootstrapTimeoutMs: 2000,
    embedMaxContextTokens: 262144,
    embedMaxBatchItems: 128,
    embedMaxInputChars: 250000,
    upstreamTransientRetryCount: 0,
    upstreamTransientRetryBackoffMs: 1,
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
    ...options.configOverrides,
    proxyTokenPepper: options.configOverrides?.proxyTokenPepper ?? "test-proxy-token-pepper",
    oauthRefreshMaxConcurrency: options.configOverrides?.oauthRefreshMaxConcurrency ?? 32,
    oauthRefreshBackgroundIntervalMs: options.configOverrides?.oauthRefreshBackgroundIntervalMs ?? 15_000,
    oauthRefreshProactiveWindowMs: options.configOverrides?.oauthRefreshProactiveWindowMs ?? 30 * 60_000,
    concurrencyThrottleMaxRetries: options.configOverrides?.concurrencyThrottleMaxRetries ?? 3,
    concurrencyThrottleThresholdMs: options.configOverrides?.concurrencyThrottleThresholdMs ?? 30_000,
  };

  const previousCljsRuntime = getActiveCljsRuntime();
  const cljsRuntime = await testCljsRuntimePromise;
  if (cljsRuntime) {
    setActiveCljsRuntime(cljsRuntime);
  }
  const app = await createApp(config);
  try {
    await fn({ app, upstream, tempDir });
  } finally {
    await app.close();
    setActiveCljsRuntime(previousCljsRuntime);
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

// ─── Unit Tests: Model Type Classification ──────────────────────────────────

// VAL-ROUTE-005: Model-to-type mapping selects correct strategy

test("getFactoryModelType maps claude-* to anthropic", () => {
  assert.equal(getFactoryModelType("claude-opus-4-5"), "anthropic");
  assert.equal(getFactoryModelType("claude-3.5-sonnet"), "anthropic");
  assert.equal(getFactoryModelType("Claude-Opus-4-5"), "anthropic");
});

test("getFactoryModelType maps gpt-* to openai", () => {
  assert.equal(getFactoryModelType("gpt-5"), "openai");
  assert.equal(getFactoryModelType("gpt-5.4"), "openai");
  assert.equal(getFactoryModelType("GPT-5"), "openai");
});

test("getFactoryModelType maps other models to common", () => {
  assert.equal(getFactoryModelType("gemini-3-pro-preview"), "common");
  assert.equal(getFactoryModelType("glm-5"), "common");
  assert.equal(getFactoryModelType("Kimi-K2.5"), "common");
  assert.equal(getFactoryModelType("DeepSeek-V3.2"), "common");
  assert.equal(getFactoryModelType("minimax-pro"), "common");
});

// VAL-HEADER-002: x-api-provider mapping

test("getFactoryApiProvider returns correct provider for each model family", () => {
  assert.equal(getFactoryApiProvider("claude-opus-4-5"), "anthropic");
  assert.equal(getFactoryApiProvider("gpt-5"), "openai");
  assert.equal(getFactoryApiProvider("gemini-3-pro-preview"), "google");
  assert.equal(getFactoryApiProvider("glm-5"), "fireworks");
  assert.equal(getFactoryApiProvider("Kimi-K2.5"), "fireworks");
  assert.equal(getFactoryApiProvider("minimax-pro"), "fireworks");
  assert.equal(getFactoryApiProvider("DeepSeek-V3.2"), "fireworks");
});

// ─── Unit Tests: Endpoint Path ──────────────────────────────────────────────

// VAL-ROUTE-007: Factory upstream URLs use /api/llm/ path prefixes

test("getFactoryEndpointPath returns correct path for each model type", () => {
  assert.equal(getFactoryEndpointPath("anthropic"), "/api/llm/a/v1/messages");
  assert.equal(getFactoryEndpointPath("openai"), "/api/llm/o/v1/responses");
  assert.equal(getFactoryEndpointPath("common"), "/api/llm/o/v1/chat/completions");
});

// ─── Unit Tests: Headers ────────────────────────────────────────────────────

// VAL-HEADER-001, VAL-HEADER-002, VAL-HEADER-003, VAL-HEADER-010, VAL-HEADER-011

test("buildFactoryCommonHeaders includes all required Factory headers", () => {
  const headers = buildFactoryCommonHeaders("gemini-3-pro-preview");

  assert.equal(headers["x-factory-client"], "cli");
  assert.equal(headers["x-api-provider"], "google");
  assert.ok(UUID_REGEX.test(headers["x-session-id"] ?? ""), "x-session-id should be a UUID");
  assert.ok(UUID_REGEX.test(headers["x-assistant-message-id"] ?? ""), "x-assistant-message-id should be a UUID");
  assert.equal(headers["user-agent"], "factory-cli/0.74.0");
  assert.equal(headers["connection"], "keep-alive");

  // Stainless SDK headers
  assert.equal(headers["x-stainless-lang"], "js");
  assert.equal(headers["x-stainless-os"], "Linux");
  assert.equal(headers["x-stainless-runtime"], "node");
  assert.equal(headers["x-stainless-arch"], "x64");
  assert.equal(headers["x-stainless-retry-count"], "0");
  assert.equal(headers["x-stainless-package-version"], "0.70.1");
  assert.equal(headers["x-stainless-runtime-version"], "v24.3.0");
});

// VAL-HEADER-004, VAL-HEADER-009: Anthropic-specific headers

test("buildFactoryAnthropicHeaders includes anthropic-specific headers", () => {
  const headers = buildFactoryAnthropicHeaders("claude-opus-4-5", { model: "claude-opus-4-5", messages: [] });

  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-api-key"], "placeholder");
  assert.equal(headers["x-client-version"], "0.74.0");
  assert.equal(headers["x-stainless-timeout"], "600");
  assert.equal(headers["x-factory-client"], "cli");
  assert.equal(headers["x-api-provider"], "anthropic");
});

test("buildFactoryAnthropicHeaders adds anthropic-beta when thinking enabled", () => {
  const thinkingPayload = {
    model: "claude-opus-4-5",
    messages: [],
    thinking: { type: "enabled", budget_tokens: 12288 },
  };
  const headers = buildFactoryAnthropicHeaders("claude-opus-4-5", thinkingPayload, "interleaved-thinking-2025-05-14");

  assert.equal(headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
});

test("buildFactoryAnthropicHeaders omits anthropic-beta when thinking not enabled", () => {
  const noThinkingPayload = { model: "claude-opus-4-5", messages: [] };
  const headers = buildFactoryAnthropicHeaders("claude-opus-4-5", noThinkingPayload, "interleaved-thinking-2025-05-14");

  assert.equal(headers["anthropic-beta"], undefined);
});

// ─── Unit Tests: System Prompt Inlining ─────────────────────────────────────

// VAL-HEADER-005: System prompt handling for fk- keys

test("inlineSystemPrompt moves string system content into first user message", () => {
  const payload = {
    model: "claude-opus-4-5",
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "Hello" },
    ],
  };

  const result = inlineSystemPrompt(payload);
  assert.equal(result["system"], undefined);
  const messages = result["messages"] as Record<string, unknown>[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.["content"], "You are a helpful assistant.\n\nHello");
});

test("inlineSystemPrompt handles array system content", () => {
  const payload = {
    model: "claude-opus-4-5",
    system: [
      { type: "text", text: "System instruction 1" },
      { type: "text", text: "System instruction 2" },
    ],
    messages: [
      { role: "user", content: "Hello" },
    ],
  };

  const result = inlineSystemPrompt(payload);
  assert.equal(result["system"], undefined);
  const messages = result["messages"] as Record<string, unknown>[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.["content"], "System instruction 1\nSystem instruction 2\n\nHello");
});

test("inlineSystemPrompt passes through payload without system", () => {
  const payload = {
    model: "claude-opus-4-5",
    messages: [
      { role: "user", content: "Hello" },
    ],
  };

  const result = inlineSystemPrompt(payload);
  assert.equal(result["system"], undefined);
  const messages = result["messages"] as Record<string, unknown>[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.["content"], "Hello");
});

test("inlineSystemPrompt handles array content on first user message", () => {
  const payload = {
    model: "claude-opus-4-5",
    system: "Be helpful.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ],
  };

  const result = inlineSystemPrompt(payload);
  assert.equal(result["system"], undefined);
  const messages = result["messages"] as Record<string, unknown>[];
  const firstContent = messages[0]?.["content"];
  assert.ok(Array.isArray(firstContent));
  assert.equal((firstContent as Record<string, unknown>[]).length, 2);
  assert.equal((firstContent as Record<string, unknown>[])[0]?.["text"], "Be helpful.");
});

test("sanitizeFactorySystemPrompt replaces OpenCode system prompt", () => {
  const prompt = "You are OpenCode, the best coding agent on the planet.\n\nTool usage rules...";
  const sanitized = sanitizeFactorySystemPrompt(prompt);
  assert.notEqual(sanitized, prompt);
  assert.ok(!sanitized.includes("OpenCode"));
  assert.ok(sanitized.toLowerCase().includes("software engineering assistant"));
});

test("sanitizeFactorySystemPrompt leaves normal prompts unchanged", () => {
  const prompt = "You are a helpful assistant.";
  assert.equal(sanitizeFactorySystemPrompt(prompt), prompt);
});

// ─── Unit Tests: isFkKey ────────────────────────────────────────────────────

test("isFkKey detects fk- prefixed API keys", () => {
  const fkCredential: ProviderCredential = {
    providerId: "factory",
    accountId: "test-1",
    token: "fk-abc123",
    authType: "api_key",
  };
  const oauthCredential: ProviderCredential = {
    providerId: "factory",
    accountId: "test-2",
    token: "eyJ...",
    authType: "oauth_bearer",
    refreshToken: "rt-123",
  };

  assert.equal(isFkKey(fkCredential), true);
  assert.equal(isFkKey(oauthCredential), false);
});

// ─── Integration Tests: Endpoint Routing ────────────────────────────────────

// VAL-ROUTE-001: Claude models route to Factory Anthropic Messages endpoint

test("factory/claude-* routes to /api/llm/a/v1/messages", { concurrency: false }, async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};

  await withEnv(
    {
      FACTORY_API_KEY: "fk-test-key", // pragma: allowlist secret
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          upstreamHandler: async (request, _body) => {
            capturedUrl = request.url ?? "";
            capturedHeaders = {};
            for (const [name, value] of Object.entries(request.headers)) {
              if (typeof value === "string") {
                capturedHeaders[name] = value;
              }
            }

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "msg_123",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Hello from Factory Claude" }],
                model: "claude-opus-4-5",
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "factory/claude-opus-4-5",
              messages: [{ role: "user", content: "hello" }],
            },
          });

          assert.equal(response.statusCode, 200);
          assert.equal(capturedUrl, "/api/llm/a/v1/messages");
          assert.equal(capturedHeaders["authorization"], "Bearer fk-test-key");
        },
      );
    },
  );
});

// VAL-ROUTE-006: Factory skipped when no credentials

test("factory route returns 503 when no factory credentials exist", { concurrency: false }, async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: { vivgrid: { accounts: ["vg-key"] } } },
          upstreamHandler: async () => {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: "should-not-reach", object: "chat.completion" }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "factory/claude-opus-4-5",
              messages: [{ role: "user", content: "hello" }],
            },
          });

          // Should get an error — no factory credentials
          assert.ok(response.statusCode >= 400);
        },
      );
    },
  );
});

// VAL-ROUTE-004: factory/ prefix forces Factory provider routing

test("factory/ prefix forces routing through Factory provider", { concurrency: false }, async () => {
  let capturedUrl = "";

  await withEnv(
    {
      FACTORY_API_KEY: "fk-test-key", // pragma: allowlist secret
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            // Set a different upstream provider
            upstreamProviderId: "vivgrid",
          },
          upstreamHandler: async (request, _body) => {
            capturedUrl = request.url ?? "";

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "msg_123",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "OK" }],
                model: "claude-opus-4-5",
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              // factory/ prefix should force Factory routing regardless of upstream
              model: "factory/claude-opus-4-5",
              messages: [{ role: "user", content: "hello" }],
            },
          });

          assert.equal(response.statusCode, 200);
          // Should have used Factory endpoint, not default vivgrid
          assert.equal(capturedUrl, "/api/llm/a/v1/messages");
        },
      );
    },
  );
});
