Warning: truncated output (original token count: 106938)
Total output lines: 13376

/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import { getActiveCljsRuntime, loadCljsRuntime, setActiveCljsRuntime } from "../lib/cljs-runtime.js";
import type { ProxyConfig } from "../lib/config.js";

interface TestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
}

const AMBIENT_PROVIDER_ENV_NAMES = [
  "ROTUSSY_API_KEY",
  "ROTUSSY_PROVIDER_ID",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "ZHIPU_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "REQUESTY_API_TOKEN",
  "REQUESTY_API_KEY",
  "ZEN_API_KEY",
  "ZENMUX_API_KEY",
] as const;

const ambientProviderEnv = new Map(AMBIENT_PROVIDER_ENV_NAMES.map((name) => [name, process.env[name]] as const));

const testCljsRuntimePromise = loadCljsRuntime({ required: true }).then((result) => {
  if (!result.loaded) {
    throw new Error(result.reason);
  }
  return result.runtime;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSseDataPayloads(payload: string): string[] {
  return payload
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      assert.equal(lines.length, 1);
      assert.ok(lines[0]?.startsWith("data: "));
      return lines[0]!.slice("data: ".length);
    });
}

async function withProxyApp(
  options: {
    readonly keys: readonly string[];
    readonly keysPayload?: unknown;
    readonly requestLogsPayload?: unknown;
    readonly models?: unknown;
    readonly handleModelCatalog?: boolean;
    readonly proxyAuthToken?: string;
    readonly allowUnauthenticated?: boolean;
    readonly configOverrides?: Partial<ProxyConfig>;
    readonly upstreamHandler: (
      request: IncomingMessage,
      body: string,
    ) => Promise<{
      status: number;
      headers?: Record<string, string>;
      body?: string;
      streamBody?: (response: ServerResponse<IncomingMessage>) => Promise<void>;
    }>;
  },
  fn: (ctx: TestContext) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "open-hax-proxy-test-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.jsonl");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  const keysPayload = options.keysPayload ?? { keys: options.keys };
  await writeFile(keysPath, JSON.stringify(keysPayload, null, 2), "utf8");
  if (options.requestLogsPayload !== undefined) {
    await writeFile(requestLogsPath, JSON.stringify(options.requestLogsPayload, null, 2), "utf8");
  }
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

      if (result.streamBody) {
        await result.streamBody(response);
        return;
      }

      response.end(result.body ?? "");
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

  const defaultConfig: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamProviderId: "vivgrid",
    disabledProviderIds: [],
    upstreamProviderBaseUrls: {
      vivgrid: `http://127.0.0.1:${address.port}`,
      "ollama-cloud": `http://127.0.0.1:${address.port}`,
      ob1: `http://127.0.0.1:${address.port}`,
      openai: `http://127.0.0.1:${address.port}`,
      openrouter: `http://127.0.0.1:${address.port}`,
      requesty: `http://127.0.0.1:${address.port}`,
      gemini: `http://127.0.0.1:${address.port}`,
      zai: `http://127.0.0.1:${address.port}/api/paas/v4`,
      mistral: `http://127.0.0.1:${address.port}/v1`,
      rotussy: `http://127.0.0.1:${address.port}/v1`,
      "llamacpp-embed": `http://127.0.0.1:${address.port}`,
    },
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiApiBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiImagesUpstreamMode: "auto",
    ollamaBaseUrl: `http://127.0.0.1:${address.port}`,
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
    llamacppModelPrefixes: ["llamacpp/", "llamacpp:", "llamacpp-embed/", "llamacpp-embed:"],
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
    keyCooldownJitterFactor: 0,
    enableKeyRandomWalk: false,
    ollamaWeeklyCooldownMultiplier: 24,
    requestTimeoutMs: 2000,
    streamBootstrapTimeoutMs: 2000,
    embedMaxContextTokens: 262144,
    embedMaxBatchItems: 128,
    embedMaxInputChars: 250000,
    upstreamTransientRetryCount: 2,
    upstreamTransientRetryBackoffMs: 1,
    proxyAuthToken: options.proxyAuthToken,
    allowUnauthenticated: options.allowUnauthenticated ?? options.proxyAuthToken === undefined,
    databaseUrl: undefined,
    githubOAuthClientId: undefined,
    githubOAuthClientSecret: undefined,
    githubOAuthCallbackPath: "/auth/github/callback",
    githubAllowedUsers: [],
    sessionSecret: "test-session-token", // pragma: allowlist secret
    openaiOauthScopes: "openid profile email offline_access",
    openaiOauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    openaiOauthIssuer: "https://auth.openai.com",
    proxyTokenPepper: options.configOverrides?.proxyTokenPepper ?? "test-proxy-token-pepper",
    oauthRefreshMaxConcurrency: options.configOverrides?.oauthRefreshMaxConcurrency ?? 32,
    oauthRefreshBackgroundIntervalMs: options.configOverrides?.oauthRefreshBackgroundIntervalMs ?? 15_000,
    oauthRefreshProactiveWindowMs: options.configOverrides?.oauthRefreshProactiveWindowMs ?? 30 * 60_000,
    concurrencyThrottleMaxRetries: options.configOverrides?.concurrencyThrottleMaxRetries ?? 3,
    concurrencyThrottleThresholdMs: options.configOverrides?.concurrencyThrottleThresholdMs ?? 30_000,
    cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
    cljsPolicyAuthoritative: options.configOverrides?.cljsPolicyAuthoritative ?? false,
    cljsPolicyShadowMode: options.configOverrides?.cljsPolicyShadowMode ?? false,
  };

  const config: ProxyConfig = {
    ...defaultConfig,
    ...options.configOverrides,
    upstreamProviderBaseUrls: {
      ...defaultConfig.upstreamProviderBaseUrls,
      ...(options.configOverrides?.upstreamProviderBaseUrls ?? {}),
    },
  };

  await withClearedAmbientProviders(async () => {
    const previousCljsRuntime = getActiveCljsRuntime();
    setActiveCljsRuntime(await testCljsRuntimePromise);
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
  });
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

async function withPatchedFetch(
  handler: (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], originalFetch: typeof fetch) => Promise<Response | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const response = await handler(input, init, originalFetch);
    if (response) {
      return response;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withClearedAmbientProviders(fn: () => Promise<void>): Promise<void> {
  const values: Record<string, string | undefined> = {
    FACTORY_AUTH_V2_FILE: process.env.FACTORY_AUTH_V2_FILE === undefined ? "/tmp/nonexistent-auth-v2-file" : process.env.FACTORY_AUTH_V2_FILE,
    FACTORY_AUTH_V2_KEY: process.env.FACTORY_AUTH_V2_KEY === undefined ? "/tmp/nonexistent-auth-v2-key" : process.env.FACTORY_AUTH_V2_KEY,
  };
  for (const name of AMBIENT_PROVIDER_ENV_NAMES) {
    if (process.env[name] === ambientProviderEnv.get(name)) {
      values[name] = undefined;
    }
  }

  await withEnv(
    values,
    fn,
  );
}

async function withZaiProxyApp(
  upstreamHandler: (request: IncomingMessage, body: string) => Promise<{ status: number; headers?: Record<string, string>; body: string }>,
  fn: (ctx: TestContext) => Promise<void>,
): Promise<void> {
  await withEnv(
    {
      ZAI_API_KEY: "zai-key-1", // pragma: allowlist secret
      ZAI_PROVIDER_ID: undefined,
      ROTUSSY_API_KEY: undefined,
      ROTUSSY_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "zai",
            localOllamaEnabled: false,
          },
          upstreamHandler,
        },
        fn,
      );
    },
  );
}

test("rotates API key when first key is rate-limited", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        assert.ok(body.includes("gemini-3.1-pro-preview"));

        if (auth === "Bearer key-a") {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "retry-after": "60"
          };

          return {
            status: 429,
            headers,
            body: JSON.stringify({ error: { message: "rate limit" } })
          };
        }

        const headers: Record<string, string> = {
          "content-type": "application/json"
        };

        return {
          status: 200,
          headers,
          body: JSON.stringify({ id: "chatcmpl-123", object: "chat.completion", choices: [] })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.id, "chatcmpl-123");
      assert.deepEqual(observedKeys, ["key-a", "key-b"]);
    }
  );
});

test("routes claude models through chat completions for the openrouter provider", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: "or-token-1", // pragma: allowlist secret
      REQUESTY_API_TOKEN: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
      REQUESTY_API_KEY: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "openrouter",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }
            assert.equal(request.url, "/v1/chat/completions");
            assert.match(body, /claude-opus-4-5/);
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "cmpl-openrouter",
                object: "chat.completion",
                created: 1,
                model: "claude-opus-4-5",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "claude-opus-4-5",
              messages: [{ role: "user", content: "hello" }],
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });
          assert.equal(response.statusCode, 200);
        },
      );
    },
  );
});

test("routes claude models through chat completions for the requesty provider", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: "req-token-1",
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
      REQUESTY_API_KEY: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "requesty",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }
            assert.equal(request.url, "/v1/chat/completions");
            assert.match(body, /claude-opus-4-5/);
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "cmpl-requesty",
                object: "chat.completion",
                created: 1,
                model: "claude-opus-4-5",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "claude-opus-4-5",
              messages: [{ role: "user", content: "hello" }],
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });
          assert.equal(response.statusCode, 200);
        },
      );
    },
  );
});

test("routes claude models through chat completions for the ob1 provider", { concurrency: false }, async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          ob1: {
            auth: "api_key",
            accounts: ["ob1-key-1"],
          },
        },
      },
      configOverrides: {
        upstreamProviderId: "ob1",
      },
      upstreamHandler: async (request, body) => {
        if (request.url === "/api/embed" || request.url === "/api/embeddings") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
          };
        }

        assert.equal(request.url, "/v1/chat/completions");
        assert.match(body, /claude-opus-4-5/);
        assert.equal(request.headers.authorization, "Bearer ob1-key-1");

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "cmpl-ob1",
            object: "chat.completion",
            created: 1,
            model: "claude-opus-4-5",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
        };
      },
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
        },
        headers: {
          authorization: "Bearer local-test",
        },
      });

      assert.equal(response.statusCode, 200);
    },
  );
});

test("routes /v1/responses through requesty when REQUESTY_API_KEY is configured", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: "req-token-1", // pragma: allowlist secret
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      GEMINI_PROVIDER_ID: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "requesty",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            assert.equal(request.url, "/v1/responses");
            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.equal(parsed.model, "openai/gpt-image-1");

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: "resp-requesty", object: "response" }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/responses",
            payload: {
              model: "gpt-image-1",
              input: "draw a cat",
              stream: false,
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });

          assert.equal(response.statusCode, 200);
          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.id, "resp-requesty");
        },
      );
    },
  );
});

test("requesty gpt chat requests route through /v1/responses with prefixed model and normalized reasoning summary", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: "req-token-1",
      REQUESTY_API_KEY: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      GEMINI_PROVIDER_ID: undefined,
    },
    async () => {
      let observedPath = "";
      let observedBody: Record<string, unknown> | undefined;

      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "requesty",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            observedPath = request.url ?? "";
            observedBody = JSON.parse(body) as Record<string, unknown>;

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "resp_requesty_gpt54_chat",
                object: "response",
                created_at: 1772516800,
                model: "gpt-5.4",
                output: [
                  {
                    id: "msg_requesty_gpt54_chat",
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "requesty-gpt-chat-ok",
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 7,
                  output_tokens: 4,
                  total_tokens: 11,
                },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: {
              authorization: "Bearer local-test",
              "content-type": "application/json",
            },
            payload: {
              model: "gpt-5.4",
              messages: [{ role: "user", content: "hello" }],
              stream: false,
              reasoningSummary: "auto",
            },
          });

          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["x-open-hax-upstream-provider"], "requesty");
          assert.equal(response.headers["x-open-hax-upstream-mode"], "responses");
          assert.equal(observedPath, "/v1/responses");
          assert.ok(isRecord(observedBody));
          assert.equal(observedBody.model, "openai/gpt-5.4");
          const observedReasoning = observedBody.reasoning;
          assert.ok(isRecord(observedReasoning));
          assert.equal(observedReasoning.summary, "auto");
          assert.equal(observedBody.reasoning_summary, undefined);

          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.object, "chat.completion");
          assert.ok(Array.isArray(payload.choices));
          assert.ok(isRecord(payload.choices[0]));
          assert.ok(isRecord(payload.choices[0].message));
          assert.equal(payload.choices[0].message.content, "requesty-gpt-chat-ok");
        },
      );
    },
  );
});

test("requesty /v1/responses preserves nested reasoning summary for gpt models", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: "req-token-1",
      REQUESTY_API_KEY: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      GEMINI_PROVIDER_ID: undefined,
    },
    async () => {
      let observedPath = "";
      let observedBody: Record<string, unknown> | undefined;

      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "requesty",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            observedPath = request.url ?? "";
            observedBody = JSON.parse(body) as Record<string, unknown>;

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "resp_requesty_nested_reasoning",
                object: "response",
                created_at: 1772516800,
                model: "gpt-5.4",
                output: [
                  {
                    id: "msg_requesty_nested_reasoning",
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "requesty-nested-reasoning-ok",
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 8,
                  output_tokens: 4,
                  total_tokens: 12,
                },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/responses",
            headers: {
              authorization: "Bearer local-test",
              "content-type": "application/json",
            },
            payload: {
              model: "gpt-5.4",
              input: "hello",
              stream: false,
              reasoning: {
                summary: "auto",
                effort: "low",
              },
            },
          });

          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["x-open-hax-upstream-provider"], "requesty");
          assert.equal(response.headers["x-open-hax-upstream-mode"], "responses_passthrough");
          assert.equal(observedPath, "/v1/responses");
          assert.ok(isRecord(observedBody));
          assert.equal(observedBody.model, "openai/gpt-5.4");
          const observedReasoning = observedBody.reasoning;
          assert.ok(isRecord(observedReasoning));
          assert.equal(observedReasoning.summary, "auto");
          assert.equal(observedReasoning.effort, "low");
          assert.equal(observedBody.reasoning_summary, undefined);

          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.id, "resp_requesty_nested_reasoning");
        },
      );
    },
  );
});

test("routes /v1/images/generations through requesty", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: "req-token-1",
      REQUESTY_API_KEY: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      GEMINI_PROVIDER_ID: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "requesty",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            assert.equal(request.url, "/v1/images/generations");
            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.equal(parsed.model, "openai/gpt-image-1");

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                created: 1,
                data: [{ b64_json: "AAAA" }],
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/images/generations",
            payload: {
              model: "gpt-image-1",
              prompt: "a red square",
              response_format: "b64_json",
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });

          assert.equal(response.statusCode, 200);
          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.deepEqual(payload.data, [{ b64_json: "AAAA" }]);
        },
      );
    },
  );
});

test("OpenAI images auto mode routes OAuth tokens to Platform API only", { concurrency: false }, async () => {
  const seenUrls: string[] = [];
  const openaiApiBaseUrl = "https://api.openai.com";
  const openaiBaseUrl = "https://chatgpt.com/backend-api";

  await withPatchedFetch(
    async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.includes("images")) {
        return undefined;
      }

      seenUrls.push(url);

      if (url === `${openaiApiBaseUrl}/v1/images/generations`) {
        return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "AAAA" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: `Unexpected URL: ${url}` } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: {
            providers: {
              openai: {
                auth: "oauth_bearer",
                accounts: [
                  {
                    access_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
                    chatgpt_account_id: "acc-1",
                  },
                ],
              },
            },
          },
          configOverrides: {
            upstreamProviderId: "openai",
            openaiProviderId: "openai",
            openaiImagesUpstreamMode: "auto",
            openaiApiBaseUrl,
            openaiBaseUrl,
          },
          upstreamHandler: async () => {
            return { status: 500, body: "unexpected upstream call" };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/images/generations",
            payload: {
              model: "gpt-image-1",
              prompt: "a red square",
              response_format: "b64_json",
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });

          assert.equal(response.statusCode, 200);
          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.deepEqual(payload.data, [{ b64_json: "AAAA" }]);
        },
      );
    },
  );

  // auto mode should only hit the Platform API -- the ChatGPT backend doesn't support image gen.
  assert.deepEqual(seenUrls, [
    `${openaiApiBaseUrl}/v1/images/generations`,
  ]);
});

test("OpenAI images auto mode falls back to Codex Responses image_generation when Platform rejects OAuth scopes", { concurrency: false }, async () => {
  const seenUrls: string[] = [];
  const seenBodies: Record<string, unknown>[] = [];
  const openaiApiBaseUrl = "https://api.openai.com";
  const openaiBaseUrl = "https://chatgpt.com/backend-api";

  const codexResponsesSse =
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "image_generation_call", id: "ig_1", status: "completed", result: "AAAA" },
    })}\n\n` +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [{ type: "image_generation_call", id: "ig_1", status: "completed", result: "AAAA" }],
      },
    })}\n\n` +
    "data: [DONE]\n\n";

  await withPatchedFetch(
    async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.includes("openai.com") && !url.includes("chatgpt.com")) {
        return undefined;
      }

      if (init?.body && typeof init.body === "string") {
        try {
          seenBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        } catch {
          // ignore
        }
      }

      seenUrls.push(url);

      if (url === `${openaiApiBaseUrl}/v1/images/generations`) {
        return new Response(
          JSON.stringify({ error: { message: "Missing scopes: api.model.images.request", type: "invalid_request_error" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      if (url === `${openaiBaseUrl}/codex/responses`) {
        return new Response(codexResponsesSse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }

      return new Response(JSON.stringify({ error: { message: `Unexpected URL: ${url}` } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: {
            providers: {
              openai: {
                auth: "oauth_bearer",
                accounts: [
                  {
                    access_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
                    chatgpt_account_id: "acc-1",
                  },
                ],
              },
            },
          },
          configOverrides: {
            upstreamProviderId: "openai",
            openaiProviderId: "openai",
            openaiImagesUpstreamMode: "auto",
            openaiApiBaseUrl,
            openaiBaseUrl,
            openaiResponsesPath: "/codex/responses",
          },
          upstreamHandler: async () => {
            return { status: 500, body: "unexpected upstream call" };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/images/generations",
            payload: {
              model: "gpt-image-1",
              prompt: "a red square",
              response_format: "b64_json",
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });

          assert.equal(response.statusCode, 200);
          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.deepEqual(payload.data, [{ b64_json: "AAAA" }]);
        },
      );
    },
  );

  assert.deepEqual(seenUrls, [
    `${openaiApiBaseUrl}/v1/images/generations`,
    `${openaiBaseUrl}/codex/responses`,
  ]);

  // Ensure the fallback request is a Responses API payload forcing image_generation.
  const fallbackBody = seenBodies.find((body) => body["tools"] !== undefined);
  assert.ok(fallbackBody && isRecord(fallbackBody));
  assert.equal(fallbackBody["model"], "gpt-5.4-mini");
  assert.equal(fallbackBody["tool_choice"], "required");
  assert.ok(Array.isArray(fallbackBody["tools"]));
  const tools = fallbackBody["tools"] as unknown[];
  assert.ok(isRecord(tools[0]));
  assert.equal((tools[0] as Record<string, unknown>)["type"], "image_generation");
});

test("routes chat completions through native Gemini generateContent when GEMINI_API_KEY is configured", { concurrency: false }, async () => {
  await withEnv(
    {
      GEMINI_API_KEY: "gem-key-1", // pragma: allowlist secret
      GEMINI_PROVIDER_ID: undefined,
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "gemini",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            assert.match(request.url ?? "", /\/models\/gemini-2\.5-pro:generateContent$/);
            assert.equal(request.headers["x-goog-api-key"], "gem-key-1");
            assert.equal(request.headers.authorization, undefined);

            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.ok(Array.isArray(parsed.contents));

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "gemini-2.5-pro",
              messages: [{ role: "user", content: "hello" }],
              stream: false,
            },
            headers: {
              authorization: "Bearer local-test",
            },
          });

          assert.equal(response.statusCode, 200);
          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.object, "chat.completion");
          assert.equal((payload.choices as any)[0].message.content, "hi");
          assert.equal((payload.usage as any).total_tokens, 3);
        },
      );
    },
  );
});

test("maps Gemini 2.5 Flash reasoning effort to thinkingBudget and reasoning_content", { concurrency: false }, async () => {
  await withEnv(
    {
      GEMINI_API_KEY: "gem-key-1", // pragma: allowlist secret
      GEMINI_PROVIDER_ID: undefined,
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "gemini",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            assert.match(request.url ?? "", /\/models\/gemini-2\.5-flash:generateContent$/);
            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.ok(isRecord(parsed.generationConfig));
            assert.ok(isRecord(parsed.generationConfig.thinkingConfig));
            assert.equal(parsed.generationConfig.thinkingConfig.thinkingBudget, 24576);
            assert.equal(parsed.generationConfig.thinkingConfig.includeThoughts, true);

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                candidates: [{
                  content: {
                    role: "model",
                    parts: [
                      { text: "gemini-thought", thought: true },
                      { text: "gemini-answer" },
                    ],
                  },
                  finishReason: "STOP",
                }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "gemini-2.5-flash",
              messages: [{ role: "user", content: "hello" }],
              reasoning_effort: "xhigh",
              include: ["reasoning.encrypted_content"],
              stream: false,
            },
          });

          assert.equal(response.statusCode, 200);
          const payload = response.json();
          assert.ok(isRecord(payload));
          assert.equal((payload.choices as any)[0].message.content, "gemini-answer");
          assert.equal((payload.choices as any)[0].message.reasoning_content, "gemini-thought");
        },
      );
    },
  );
});

test("maps Gemini 3.1 Pro reasoning effort to thinkingLevel", { concurrency: false }, async () => {
  await withEnv(
    {
      GEMINI_API_KEY: "gem-key-1", // pragma: allowlist secret
      GEMINI_PROVIDER_ID: undefined,
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "gemini",
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            assert.match(request.url ?? "", /\/models\/gemini-3\.1-pro-preview:generateContent$/);
            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.ok(isRecord(parsed.generationConfig));
            assert.ok(isRecord(parsed.generationConfig.thinkingConfig));
            assert.equal(parsed.generationConfig.thinkingConfig.thinkingLevel, "HIGH");

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "gemini-3.1-pro-preview",
              messages: [{ role: "user", content: "hello" }],
              reasoning_effort: "xhigh",
              stream: false,
            },
          });

          assert.equal(response.statusCode, 200);
        },
      );
    },
  );
});

test("routes glm chat requests through z.ai custom chat-completions path when ZAI_API_KEY is configured", { concurrency: false }, async () => {
  await withZaiProxyApp(
    async (request, body) => {
      assert.equal(request.url, "/api/paas/v4/chat/completions");
      assert.equal(request.headers.authorization, "Bearer zai-key-1");

      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.equal(parsed.model, "glm-5");
      assert.ok(Array.isArray(parsed.messages));

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "chatcmpl_zai",
          object: "chat.completion",
          created: 1772516801,
          model: "glm-5",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "zai-glm-ok" },
            finish_reason: "stop",
          }],
        }),
      };
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "zai");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal((payload.choices as any)[0].message.content, "zai-glm-ok");
    },
  );
});

test("lists z.ai models through the custom models path when ZAI_API_KEY is configured", { concurrency: false }, async () => {
  await withZaiProxyApp(
    async (request) => {
      assert.equal(request.url, "/api/paas/v4/models");

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          object: "list",
          data: [
            { id: "glm-5" },
            { id: "glm-4.7-flash" },
          ],
        }),
      };
    },
    async ({ app }) => {
      const response = await app.inject({ method: "GET", url: "/v1/models" });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "list");
      assert.ok(Array.isArray(payload.data));
      assert.ok(payload.data.some((entry: unknown) => isRecord(entry) && entry.id === "glm-5"));
      assert.ok(payload.data.some((entry: unknown) => isRecord(entry) && entry.id === "glm-4.7-flash"));
    },
  );
});

test("records z.ai chat-completions usage in request logs", { concurrency: false }, async () => {
  await withZaiProxyApp(
    async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "chatcmpl_zai_usage",
        object: "chat.completion",
        created: 1772516801,
        model: "glm-5-turbo",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "zai-usage-ok" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }),
    }),
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5-turbo",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }
      });

      assert.equal(response.statusCode, 200);

      const logsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/request-logs?providerId=zai&limit=1"
      });
      assert.equal(logsResponse.statusCode, 200);

      const payload: unknown = logsResponse.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.entries));
      assert.ok(isRecord(payload.entries[0]));
      assert.equal(payload.entries[0].providerId, "zai");
      assert.equal(payload.entries[0].promptTokens, 11);
      assert.equal(payload.entries[0].completionTokens, 7);
      assert.equal(payload.entries[0].totalTokens, 18);
      assert.equal(payload.entries[0].cachedPromptTokens, 3);
      assert.equal(payload.entries[0].cacheHit, true);
    },
  );
});

test("routes mistral chat requests through env-backed Mistral provider", { concurrency: false }, async () => {
  await withEnv(
    {
      MISTRAL_API_KEY: "mistral-key-1", // pragma: allowlist secret
      MISTRAL_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
    },
    async () => {
      await withProxyApp(
        {
          keys: [],
          keysPayload: { providers: {} },
          configOverrides: {
            upstreamProviderId: "mistral",
            localOllamaEnabled: false,
          },
          upstreamHandler: async (request, body) => {
            assert.equal(request.url, "/v1/chat/completions");
            assert.equal(request.headers.authorization, "Bearer mistral-key-1");

            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.equal(parsed.model, "mistral-small-latest");
            assert.ok(Array.isArray(parsed.messages));

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "chatcmpl_mistral",
                object: "chat.completion",
                created: 1772516801,
                model: "mistral-small-latest",
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: "mistral-ok" },
                  finish_reason: "stop",
                }],
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: {
              "content-type": "application/json"
            },
            payload: {
              model: "mistral-small-latest",
              messages: [{ role: "user", content: "hello" }],
              stream: false,
            }
          });

          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["x-open-hax-upstream-provider"], "mistral");
          const payload: unknown = response.json();
          assert.ok(isRecord(payload));
          assert.equal((payload.choices as any)[0].message.content, "mistral-ok");
        },
      );
    },
  );
});

test("reuses the same upstream account for repeated prompt_cache_key requests", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion", choices: [] })
        };
      }
    },
    async ({ app }) => {
      for (let index = 0; index < 3; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: {
            "content-type": "application/json"
          },
          payload: {
            model: "gemini-3.1-pro-preview",
            messages: [{ role: "user", content: "hello" }],
            prompt_cache_key: "sticky-key-1",
            stream: false
          }
        });

        assert.equal(response.statusCode, 200);
      }

      assert.deepEqual(observedKeys, ["key-a", "key-a", "key-a"]);
    }
  );
});

test("reassigns prompt_cache_key affinity when the pinned account becomes rate-limited", async () => {
  const observedKeys: string[] = [];
  let keyAAttempts = 0;

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-a") {
          keyAAttempts += 1;
          if (keyAAttempts >= 2) {
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "retry-after": "60"
            };
            return {
              status: 429,
              headers,
              body: JSON.stringify({ error: { message: "rate limit" } })
            };
          }
        }

        const headers: Record<string, string> = {
          "content-type": "application/json"
        };

        return {
          status: 200,
          headers,
          body: JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion", choices: [] })
        };
      }
    },
    async ({ app }) => {
      const basePayload = {
        model: "gemini-3.1-pro-preview",
        messages: [{ role: "user", content: "hello" }],
        prompt_cache_key: "sticky-key-2",
        stream: false
      };

      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: basePayload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: basePayload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: basePayload })).statusCode, 200);

      assert.deepEqual(observedKeys, ["key-a", "key-a", "key-b", "key-b"]);
    }
  );
});

test("reassigns ollama session-limited prompt_cache_key affinity after one fallback success", async () => {
  const observedKeys: string[] = [];
  let ollamaAAttempts = 0;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-a", "ollama-b"],
        },
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
        keyCooldownJitterFactor: 0,
      },
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer ollama-a") {
          ollamaAAttempts += 1;
          if (ollamaAAttempts >= 2) {
            return {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "1",
              } as Record<string, string>,
              body: JSON.stringify({
                error: {
                  message: "you (ollama-a) have reached your session usage limit, upgrade for higher limits: https://ollama.com/upgrade",
                },
              }),
            };
          }
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          } as Record<string, string>,
          body: JSON.stringify({
            id: crypto.randomUUID(),
            object: "chat.completion",
            model: "glm-5.1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "glm-ok",
                },
                finish_reason: "stop",
              },
            ],
          }),
        };
      },
    },
    async ({ app }) => {
      const payload = {
        model: "glm-5.1",
        messages: [{ role: "user", content: "hello" }],
        prompt_cache_key: "sticky-ollama-session-1",
        stream: false,
      };

      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);

      assert.deepEqual(observedKeys, ["ollama-a", "ollama-a", "ollama-b", "ollama-b"]);
    },
  );
});

test("persists request logs with usage counts for dashboard surfaces", async () => {
  let requestLogsJson = "";

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "resp_usage_dashboard",
          object: "response",
          created_at: 1772516812,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "msg_usage_dashboard",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "dashboard-usage-ok"
                }
              ]
            }
          ],
          usage: {
            input_tokens: 15,
            output_tokens: 9,
            total_tokens: 24
          }
        })
      })
    },
    async ({ app, tempDir }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          requestLogsJson = await readFile(path.join(tempDir, "request-logs.jsonl"), "utf8");
          if (requestLogsJson.includes("gpt-5.3-codex")) {
            break;
          }
        } catch {
          // Wait for async persistence.
        }

        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      const overviewResponse = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overview",
      });
      assert.equal(overviewResponse.statusCode, 200);
      const overviewPayload: unknown = overviewResponse.json();
      assert.ok(isRecord(overviewPayload));
      assert.ok(isRecord(overviewPayload.summary));
      assert.ok(isRecord(overviewPayload.summary.serviceTierRequests24h));
      assert.equal(overviewPayload.summary.serviceTierRequests24h.fastMode, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.priority, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.standard, 1);

      const overviewWeeklyResponse = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overview?window=weekly",
      });
      assert.equal(overviewWeeklyResponse.statusCode, 200);
      const weeklyPayload: unknown = overviewWeeklyResponse.json();
      assert.ok(isRecord(weeklyPayload));
      assert.equal((weeklyPayload as any).window, "weekly");
      assert.ok(isRecord((weeklyPayload as any).summary));
      assert.equal((weeklyPayload as any).summary.requests24h, 1);
    }
  );

  assert.ok(requestLogsJson.length > 0);
  const parsed = requestLogsJson
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const latestEntries = new Map<string, Record<string, unknown>>();
  for (const entry of parsed) {
    assert.ok(isRecord(entry));
    const entryId = entry.id;
    if (typeof entryId !== "string") {
      throw new Error("expected request log entry to include an id");
    }
    latestEntries.set(entryId, entry);
  }

  assert.equal(latestEntries.size, 1);
  const [entry] = [...latestEntries.values()];
  assert.ok(entry);
  assert.equal(entry.model, "gpt-5.3-codex");
  assert.equal(entry.serviceTier, undefined);
  assert.equal(entry.serviceTierSource, "none");
  assert.equal(entry.promptTokens, 15);
  assert.equal(entry.completionTokens, 9);
  assert.equal(entry.totalTokens, 24);
});

test("fetches live OpenAI Codex quota windows and persists refreshed OAuth tokens", async () => {
  const originalFetch = globalThis.fetch;
  const refreshedAccessToken = makeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "workspace-a",
      chatgpt_plan_type: "pro",
    },
    "https://api.openai.com/profile": {
      email: "quota@example.com",
    },
    sub: "user-quota",
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url === "https://auth.openai.com/oauth/token") {
      return new Response(JSON.stringify({
        access_token: refreshedAccessToken,
        refresh_token: "refresh-token-new",
        expires_in: 3600,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${refreshedAccessToken}`);
      assert.equal(headers.get("chatgpt-account-id"), "workspace-a");
      assert.equal(headers.get("originator"), "codex_cli_rs");

      return new Response(JSON.stringify({
        usage: {
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: {
              remaining_percent: 72,
              limit_window_seconds: 18000,
              reset_after_seconds: 1800,
            },
            secondary_window: {
              allowed: false,
              remaining_percent: 54,
              limit_window_seconds: 604800,
              resets_at: "2030-01-01T00:00:00.000Z",
            },
          },
          code_review_rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              remaining_percent: 100,
              limit_window_seconds: 604800,
              reset_after_seconds: 3600,
            },
          },
          plan_type: "pro",
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected fetch URL in quota test: ${url}`);
  };

  try {
    await withProxyApp(
      {
        keys: [],
        models: ["gpt-5.4-mini"],
        keysPayload: {
          providers: {
            openai: {
              auth: "oauth_bearer",
              accounts: [
                {
                  id: "openai-a",
                  access_token: makeJwt({
                    "https://api.openai.com/auth": {
                      chatgpt_account_id: "workspace-a",
                      chatgpt_plan_type: "plus",
                    },
                    "https://api.openai.com/profile": {
                      email: "quota@example.com",
                    },
                    sub: "user-quota",
                  }),
                  refresh_token: "refresh-token-old",
                  expires_at: Date.now() - 1000,
                  chatgpt_account_id: "workspace-a",
                  email: "quota@example.com",
                  plan_type: "plus",
                },
              ],
            },
          },
        },
        configOverrides: {
          openaiBaseUrl: "https://chatgpt.com/backend-api",
          openaiResponsesPath: "/codex/responses",
        },
        upstreamHandler: async () => ({
          status: 404,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ error: "not_used" }),
        }),
      },
      async ({ app, tempDir }) => {
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/credentials/openai/quota",
        });

        assert.equal(response.statusCode, 200);
        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.ok(Array.isArray(payload.accounts));
        assert.equal(payload.accounts.length, 1);
        assert.ok(isRecord(payload.accounts[0]));
        assert.equal(payload.accounts[0].providerId, "openai");
        assert.equal(payload.accounts[0].accountId, "openai-a");
        assert.equal(payload.accounts[0].status, "ok");
        assert.equal(payload.accounts[0].planType, "pro");
        assert.ok(isRecord(payload.accounts[0].fiveHour));
        assert.equal(payload.accounts[0].fiveHour.remainingPercent, 72);
        assert.equal(payload.accounts[0].fiveHour.limitWindowSeconds, 18000);
        assert.ok(isRecord(payload.accounts[0].weekly));
        assert.equal(payload.accounts[0].weekly.remainingPercent, 54);
        assert.equal(payload.accounts[0].weekly.limitWindowSeconds, 604800);
        assert.ok(isRecord(payload.accounts[0].rateLimit));
        assert.equal(payload.accounts[0].rateLimit.allowed, false);
        assert.ok(isRecord(payload.accounts[0].codeReviewRateLimit));
        assert.equal(payload.accounts[0].codeReviewRateLimit.allowed, true);

        const keysJson = await readFile(path.join(tempDir, "keys.json"), "utf8");
        const parsedKeys: unknown = JSON.parse(keysJson);
        assert.ok(isRecord(parsedKeys));
        assert.ok(isRecord(parsedKeys.providers));
        assert.ok(isRecord(parsedKeys.providers.openai));
        assert.ok(Array.isArray(parsedKeys.providers.openai.accounts));
        assert.ok(isRecord(parsedKeys.providers.openai.accounts[0]));
        assert.equal(parsedKeys.providers.openai.accounts[0].access_token, refreshedAccessToken);
        assert.equal(parsedKeys.providers.openai.accounts[0].refresh_token, "refresh-token-new");
        assert.equal(parsedKeys.providers.openai.accounts[0].plan_type, "pro");
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probes an OpenAI account with a minimal hello request", async () => {
  const originalFetch = globalThis.fetch;
  const observedRequests: Array<{ readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://chatgpt.com/backend-api/codex/responses") {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      observedRequests.push({ url, headers, body });

      return new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_probe_hello",
              status: "completed",
              model: "gpt-5.4-mini",
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              }],
              usage: {
                input_tokens: 5,
                output_tokens: 1,
                total_tokens: 6,
              },
            },
          })}`,
          "",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    }

    throw new Error(`Unexpected fetch URL in probe test: ${url}`);
  };

  try {
    await withProxyApp(
      {
        keys: [],
        keysPayload: {
          providers: {
            openai: {
              auth: "oauth_bearer",
              accounts: [
                {
                  id: "openai-probe-a",
                  access_token: makeJwt({
                    "https://api.openai.com/auth": {
                      chatgpt_account_id: "workspace-probe-a",
                      chatgpt_plan_type: "free",
                    },
                    sub: "user-probe-a",
                  }),
                  chatgpt_account_id: "workspace-probe-a",
                },
              ],
            },
          },
        },
        configOverrides: {
          openaiBaseUrl: "https://chatgpt.com/backend-api",
          openaiResponsesPath: "/codex/responses",
        },
        upstreamHandler: async () => ({
          status: 404,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ error: "not_used" }),
        }),
      },
      async ({ app }) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/credentials/openai/probe",
          payload: {
            accountId: "openai-probe-a",
          },
        });

        assert.equal(response.statusCode, 200);
        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.equal(payload.status, "ok");
        assert.equal(payload.ok, true);
        assert.equal(payload.matchesExpectedOutput, true);
        assert.equal(payload.outputText, "hello");
        assert.equal(payload.model, "gpt-5.4-mini");
      },
    );

    assert.equal(observedRequests.length, 1);
    assert.equal(observedRequests[0]?.headers.get("chatgpt-account-id"), "workspace-probe-a");
    assert.equal(observedRequests[0]?.headers.get("originator"), "codex_cli_rs");
    assert.equal(observedRequests[0]?.body.model, "gpt-5.4-mini");
    assert.equal((observedRequests[0]?.body.reasoning as { readonly effort?: string } | undefined)?.effort, "none");
    assert.equal(observedRequests[0]?.body.stream, true);
    assert.equal(observedRequests[0]?.body.store, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probes an Ollama Cloud account with a minimal hello request", async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": {
            auth: "api_key",
            accounts: [
              {
                id: "ollama-probe-a",
                api_key: "ollama-cloud-key",
              },
            ],
          },
        },
      },
      upstreamHandler: async (request, body) => {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/api/chat");
        assert.equal(request.headers.authorization, "Bearer ollama-cloud-key");

        const parsed = JSON.parse(body) as Record<string, unknown>;
        assert.equal(parsed.model, "gemma4:31b");
        assert.equal(parsed.stream, false);
        assert.equal(parsed.think, false);
        assert.ok(Array.isArray(parsed.messages));
        assert.ok(isRecord(parsed.messages[0]));
        assert.equal(parsed.messages[0].role, "user");
        assert.equal(parsed.messages[0].content, "Reply with exactly hello.");

        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gemma4:31b",
            created_at: "2026-04-21T00:00:00.000Z",
            message: {
              role: "assistant",
              content: "hello",
            },
            done: true,
            done_reason: "stop",
          }),
        };
      },
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/credentials/ollama-cloud/probe",
        payload: {
          accountId: "ollama-probe-a",
        },
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.providerId, "ollama-cloud");
      assert.equal(payload.accountId, "ollama-probe-a");
      assert.equal(payload.status, "ok");
      assert.equal(payload.ok, true);
      assert.equal(payload.matchesExpectedOutput, true);
      assert.equal(payload.outputText, "hello");
      assert.equal(payload.model, "gemma4:31b");
    },
  );
});

test("does not misclassify gemini models as local ollama because they contain mini", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: "chatcmpl-gemini", object: "chat.completion", choices: [] })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-mode"], "chat_completions");
      assert.deepEqual(observedKeys, ["key-a"]);
    }
  );
});

test("prefers zai over vivgrid for glm shared models when both are available", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: ["vivgrid-failing-key"],
          zai: ["zai-working-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string" && request.method === "POST") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer vivgrid-failing-key") {
          return {
            status: 401,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "unauthorized" } })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "chatcmpl-provider-fallback-1",
            object: "chat.completion",
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "provider-fallback-ok"
                },
                finish_reason: "stop"
              }
            ]
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "zai");
      assert.deepEqual(observedAuth, ["zai-working-key"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "provider-fallback-ok");
    }
  );
});

test("continues trying accounts after model-not-found response", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          requesty: ["requesty-missing-a", "requesty-missing-b"],
          vivgrid: ["vivgrid-working-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "requesty",
      },
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string" && request.method === "POST") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer requesty-missing-a" || auth === "Bearer requesty-missing-b") {
          return {
            status: 404,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              error: {
                message: "model \"glm-5\" not found"
              }
            })
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.equal(parsedBody.model, "glm-5");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "chatcmpl-model-found-fallback",
            object: "chat.completion",
            created: 1772516816,
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "fallback-after-missing-model"
                },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "vivgrid");
      const requestyAttempts = observedAuth.filter((entry) => entry === "requesty-missing-a" || entry === "requesty-missing-b");
      assert.equal(requestyAttempts.length, 2);
      assert.equal(observedAuth[observedAuth.length - 1], "vivgrid-working-key");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "fallback-after-missing-model");
    }
  );
});

test("tries all candidate keys until one succeeds", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b", "key-c"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-a" || auth === "Bearer key-b") {
          return {
            status: 401,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "invalid key" } })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: "chatcmpl-final-key-success", object: "chat.completion", choices: [] })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(observedAuth, ["key-a", "key-b", "key-c"]);
    }
  );
});

test("glm provider ordering uses zai before vivgrid candidate keys", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: ["vivgrid-bad-a", "vivgrid-bad-b", "vivgrid-bad-c"],
          zai: ["zai-good"]
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string" && request.method === "POST") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (request.method !== "POST") {
          return {
            status: 404,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "not_found" } })
          };
        }

        if (auth === "Bearer zai-good") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ id: "chatcmpl-provider-interleave-ok", object: "chat.completion", choices: [] })
          };
        }

        return {
          status: 401,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ error: { message: "invalid key" } })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "zai");
      assert.deepEqual(observedAuth, ["zai-good"]);
    }
  );
});

test("falls back from openai-prefixed codex route to standard fallback providers", async () => {
  const observedPaths: string[] = [];
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: [
            { id: "oa-a", access_token: "openai-rate-limited", chatgpt_account_id: "cgpt-a" }
          ],
          vivgrid: ["vivgrid-working-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request, body) => {
        if (request.url === "/api/embed" || request.url === "/api/embeddings") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }
        observedPaths.push(request.url ?? "");

        if (auth === "Bearer openai-rate-limited") {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "retry-after": "60"
          };
          return {
            status: 429,
            headers,
            body: JSON.stringify({ error: { message: "rate limit" } })
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.equal(parsedBody.model, "gpt-5.4");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp-openai-fallback-standard-provider",
            object: "response",
            created_at: 1772916800,
            model: "gpt-5.4",
            output: [
              {
                id: "msg-openai-fallback-standard-provider",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "standard-provider-fallback-ok"
                  }
                ]
              }
            ]
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "vivgrid");
      assert.equal(response.headers["x-open-hax-upstream-mode"], "responses");
      assert.deepEqual(observedPaths, ["/v1/responses", "/v1/responses"]);
      assert.deepEqual(observedAuth, ["openai-rate-limited", "vivgrid-working-key"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "standard-provider-fallback-ok");
    }
  );
});

test("falls back from vivgrid to codex oauth accounts for gpt routing", async () => {
  const observedPaths: string[] = [];
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: ["vivgrid-rate-limited"],
          openai: [
            { id: "oa-fallback", access_token: "openai-codex-working", chatgpt_account_id: "cgpt-fallback" }
          ]
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request, body) => {
        if (request.url === "/api/embed" || request.url === "/api/embeddings") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }
        observedPaths.push(request.url ?? "");

        if (auth === "Bearer vivgrid-rate-limited") {
          const ratelimitHeaders: Record<string, string> = {
            "content-type": "application/json",
            "retry-after": "60",
          };
          return {
            status: 429,
            headers: ratelimitHeaders,
            body: JSON.stringify({ error: { message: "rate limit" } }),
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        if (parsedBody.model === "nomic-embed-text:latest") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            } as Record<string, string>,
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        assert.equal(parsedBody.model, "gpt-5.4");
        assert.equal(request.headers["chatgpt-account-id"], "cgpt-fallback");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp-standard-openai-fallback",
            object: "response",
            created_at: 1772916801,
            model: "gpt-5.4",
            output: [
              {
                id: "msg-standard-openai-fallback",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "codex-oauth-fallback-ok"
                  }
                ]
              }
            ]
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "openai");
      assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
      assert.deepEqual(observedPaths, ["/v1/responses", "/v1/responses"]);
      assert.deepEqual(observedAuth, ["vivgrid-rate-limited", "openai-codex-working"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "codex-oauth-fallback-ok");
    }
  );
});

test("falls back from vivgrid through free codex oauth to paid accounts for gpt-5.4", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: ["vivgrid-failing-key"],
          openai: {
            auth: "oauth_bearer",
            accounts: [
              {
                id: "oa-free",
                access_token: "openai-free-unsupported",
                chatgpt_account_id: "cgpt-free",
                plan_type: "free"
              },
              {
                id: "oa-plus",
                access_token: "openai-plus-working",
                chatgpt_account_id: "cgpt-plus",
                plan_type: "plus"
              }
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request, body) => {
        if (request.url === "/api/embed" || request.url === "/api/embeddings") {
          return {
            status: 200,
            headers: { "content-type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer vivgrid-failing-key") {
          return {
            status: 401,
            headers: { "content-type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ error: { message: "unauthorized" } })
          };
        }

        if (auth === "Bearer openai-free-unsupported") {
          return {
            status: 400,
            headers: { "content-type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account." })
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        if (parsedBody.model !== "gpt-5.4") {
          return {
            status: 200,
            headers: { "content-type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        assert.equal(request.headers["chatgpt-account-id"], "cgpt-plus");

        return {
          status: 200,
          headers: { "content-type": "application/json" } as Record<string, string>,
          body: JSON.stringify({
            id: "resp-paid-openai-fallback",
            object: "response",
            created_at: 1772916802,
            model: "gpt-5.4",
            output: [
              {
                id: "msg-paid-openai-fallback",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "paid-codex-account-ok"
                  }
                ]
              }
            ]
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
          max_completion_tokens: 8,
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "openai");
      assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
      assert.deepEqual(observedAuth, ["vivgrid-failing-key", "openai-free-unsupported", "openai-plus-working"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "paid-codex-account-ok");
    }
  );
});

test("prefers free codex oauth accounts for gpt-5.4-mini before paid accounts", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              {
                id: "oa-plus",
                access_token: "openai-plus-second",
                chatgpt_account_id: "cgpt-plus",
                plan_type: "plus"
              },
              {
                id: "oa-free",
                access_token: "openai-free-first",
                chatgpt_account_id: "cgpt-free",
                plan_type: "free"
              }
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.equal(parsedBody.model, "gpt-5.4-mini");
        assert.equal(request.headers["chatgpt-account-id"], "cgpt-free");

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "resp-free-openai-priority",
            object: "response",
            created_at: 1772916804,
            model: "gpt-5.4-mini",
            output: [
              {
                id: "msg-free-openai-priority",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "free-first-ok"
                  }
                ]
              }
            ],
            usage: {
              input_tokens: 9,
              output_tokens: 4,
              total_tokens: 13
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "openai");
      assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
      assert.deepEqual(observedAuth, ["openai-free-first"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "gpt-5.4-mini");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "free-first-ok");
    }
  );
});

test("falls back from vivgrid to expired openai account which refreshes token before gpt-5.4 fallback", async () => {
  const observedAuth: string[] = [];
  const refreshedAccessToken = makeJwt({
    chatgpt_account_id: "cgpt-refreshed",
    chatgpt_plan_type: "plus",
  });
  let refreshCalls = 0;

  await withPatchedFetch(
    async (input, init, originalFetch) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === "https://auth.openai.com/oauth/token") {
        refreshCalls += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        assert.match(body, /grant_type=refresh_token/);
        assert.match(body, /refresh_t…56938 tokens truncated…responses reasoning output into chat reasoning_content for stream clients", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp_reasoning_stream",
            object: "response",
            created_at: 1772516803,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "rs_1",
                type: "reasoning",
                summary: [
                  {
                    type: "summary_text",
                    text: "reasoning-trace-ok"
                  }
                ]
              },
              {
                id: "msg_reasoning_stream",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "stream-with-reasoning-ok"
                  }
                ]
              }
            ]
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.ok(isRecord(observedBody));
      assert.ok(observedBody.stream === false || observedBody.stream === undefined);
      assert.ok(response.body.includes("\"reasoning_content\":\"reasoning-trace-ok\""));
      assert.ok(response.body.includes("stream-with-reasoning-ok"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("fails over stream accounts when an upstream stream returns only [DONE]", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-bad", "key-good"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-bad") {
          return {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=utf-8"
            },
            body: "data: [DONE]\n\n"
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          },
          body:
            "data: {\"id\":\"chatcmpl_stream_ok\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"Kimi-K2.5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"stream-failover-ok\"},\"finish_reason\":null}]}\n\n" +
            "data: {\"id\":\"chatcmpl_stream_ok\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"Kimi-K2.5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: [DONE]\n\n"
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "Kimi-K2.5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(typeof response.headers["content-type"] === "string");
      assert.match(String(response.headers["content-type"]), /text\/event-stream/i);
      assert.ok(response.body.includes("stream-failover-ok"));
      assert.ok(response.body.includes("data: [DONE]"));
      assert.deepEqual(observedKeys, ["key-bad", "key-good"]);
    }
  );
});

test("fails over stream accounts when the first upstream stream handshake times out", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-slow", "key-fast"],
      configOverrides: {
        requestTimeoutMs: 1000,
        streamBootstrapTimeoutMs: 50,
        embedMaxContextTokens: 262144,
      },
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-slow") {
          await new Promise((resolve) => {
            setTimeout(resolve, 200);
          });
          return {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            },
            body:
              "data: {\"id\":\"chatcmpl_stream_slow\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"slow\"},\"finish_reason\":null}]}\n\n" +
              "data: [DONE]\n\n"
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          },
          body:
            "data: {\"id\":\"chatcmpl_stream_timeout_fallback\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"stream-timeout-fallback-ok\"},\"finish_reason\":null}]}\n\n" +
            "data: {\"id\":\"chatcmpl_stream_timeout_fallback\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: [DONE]\n\n"
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("stream-timeout-fallback-ok"));
      assert.deepEqual(observedKeys, ["key-slow", "key-fast"]);
    }
  );
});

test("fails over stream accounts when the first upstream stream sends headers but never boots", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-stalled", "key-fast"],
      configOverrides: {
        requestTimeoutMs: 1000,
        streamBootstrapTimeoutMs: 50,
        embedMaxContextTokens: 262144,
      },
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-stalled") {
          return {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            },
            streamBody: async (response) => {
              response.flushHeaders();
              await new Promise((resolve) => {
                setTimeout(resolve, 200);
              });
              response.write(
                "data: {\"id\":\"chatcmpl_stream_stalled\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"too-late\"},\"finish_reason\":null}]}\n\n"
              );
              response.write("data: [DONE]\n\n");
              response.end();
            },
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          },
          body:
            "data: {\"id\":\"chatcmpl_stream_bootstrap_fallback\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"stream-bootstrap-fallback-ok\"},\"finish_reason\":null}]}\n\n" +
            "data: {\"id\":\"chatcmpl_stream_bootstrap_fallback\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: [DONE]\n\n"
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("stream-bootstrap-fallback-ok"));
      // Prove the stalled upstream is cut off - the late "too-late" chunk must NOT appear.
      assert.ok(!response.body.includes("too-late"), "stalled upstream should not leak late chunks");
      assert.ok(!response.body.includes("chatcmpl_stream_stalled"), "stalled upstream ID should not appear");
      assert.deepEqual(observedKeys, ["key-stalled", "key-fast"]);
    }
  );
});

test("returns 502 when the final upstream stream has no substantive chunks", async () => {
  await withProxyApp(
    {
      keys: ["key-empty"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        },
        body: "data: [DONE]\n\n"
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 502);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "upstream_unavailable");
    }
  );
});

test("starts hosted upstream streams after the first substantive chunk instead of buffering the full body", async () => {
  let _upstreamCompleted = false;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        },
        streamBody: async (response) => {
          response.flushHeaders();
          response.write(
            "data: {\"id\":\"chatcmpl_stream_early\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"early-hosted-stream\"},\"finish_reason\":null}]}\n\n"
          );
          await new Promise((resolve) => {
            setTimeout(resolve, 250);
          });
          response.write(
            "data: {\"id\":\"chatcmpl_stream_early\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
          );
          response.write("data: [DONE]\n\n");
          _upstreamCompleted = true;
          response.end();
        },
      })
    },
    async ({ app }) => {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve app address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
      assert.ok(response.body);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (!buffer.includes("\n\n")) {
          const { done, value } = await reader.read();
          assert.equal(done, false);
          buffer += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }

      // Note: we intentionally do NOT assert upstreamCompleted === false here.
      // In local loopback tests, undici/body teeing can buffer enough of the upstream
      // that the server-side completion flag flips before the client observes the first
      // SSE frame. The regression we actually care about is that the proxy emits a valid
      // first chat chunk rather than waiting for a fully buffered JSON response.
      const firstEvent = parseSseDataPayloads(buffer)[0];
      assert.ok(firstEvent);
      const firstChunk = JSON.parse(firstEvent);
      assert.equal(firstChunk.object, "chat.completion.chunk");
      assert.equal(firstChunk.choices[0].delta.content, "early-hosted-stream");
    }
  );
});

test("does not classify normal stream content as quota errors", async () => {
  const chunkA = JSON.stringify({
    id: "chatcmpl_stream_balance_phrase",
    object: "chat.completion.chunk",
    created: 1772516802,
    model: "glm-5",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "An outstanding balance sheet can still be healthy."
        },
        finish_reason: null
      }
    ]
  });
  const chunkB = JSON.stringify({
    id: "chatcmpl_stream_balance_phrase",
    object: "chat.completion.chunk",
    created: 1772516802,
    model: "glm-5",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop"
      }
    ]
  });

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        },
        body: `data: ${chunkA}\n\ndata: ${chunkB}\n\ndata: [DONE]\n\n`
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(typeof response.headers["content-type"] === "string");
      assert.match(String(response.headers["content-type"]), /text\/event-stream/i);
      assert.ok(response.body.includes("outstanding balance sheet"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("fails over stream accounts when upstream emits error event with outstanding_balance", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-bad", "key-good"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-bad") {
          return {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            },
            body: "data: {\"type\":\"error\",\"detail\":\"outstanding_balance\"}\n\n"
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          },
          body:
            "data: {\"id\":\"chatcmpl_stream_quota_fallback\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"fallback-stream-ok\"},\"finish_reason\":null}]}\n\n" +
            "data: {\"id\":\"chatcmpl_stream_quota_fallback\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: [DONE]\n\n"
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("fallback-stream-ok"));
      assert.deepEqual(observedKeys, ["key-bad", "key-good"]);
    }
  );
});

test("forces SSE content-type for validated stream pass-through", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body:
          "data: {\"id\":\"chatcmpl_stream_content_type\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"content-type-normalized\"},\"finish_reason\":null}]}\n\n" +
          "data: {\"id\":\"chatcmpl_stream_content_type\",\"object\":\"chat.completion.chunk\",\"created\":1772516802,\"model\":\"glm-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
          "data: [DONE]\n\n"
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.ok(response.body.includes("content-type-normalized"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("fails over claude accounts when requested reasoning trace is missing", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-no-thinking", "key-with-thinking"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-no-thinking") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "msg_claude_no_reasoning",
              model: "claude-opus-4-5-20251101",
              role: "assistant",
              type: "message",
              content: [
                {
                  type: "text",
                  text: "no-thinking"
                }
              ],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 10,
                output_tokens: 4
              }
            })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_with_reasoning",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "thinking",
                thinking: "fallback-thinking-ok"
              },
              {
                type: "text",
                text: "with-thinking"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 4
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "medium",
          include: ["reasoning.encrypted_content"],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(observedKeys, ["key-no-thinking", "key-with-thinking"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "with-thinking");
      assert.equal(payload.choices[0].message.reasoning_content, "fallback-thinking-ok");
    }
  );
});

test("routes claude chat requests to messages endpoint and maps response", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_1",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "text",
                text: "claude-mapped-ok"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 11,
              output_tokens: 7
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [
            { role: "system", content: "You are terse" },
            { role: "user", content: "hello", cache_control: { type: "ephemeral" } }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/messages");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "claude-opus-4-5");
      assert.equal(observedBody.system, "You are terse");
      assert.ok(Array.isArray(observedBody.messages));
      assert.equal(observedBody.messages.length, 1);
      assert.ok(isRecord(observedBody.messages[0]));
      assert.equal(observedBody.messages[0].role, "user");
      assert.equal(observedBody.messages[0].cache_control, undefined);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "claude-opus-4-5-20251101");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "claude-mapped-ok");
      assert.ok(isRecord(payload.usage));
      assert.equal(payload.usage.prompt_tokens, 11);
      assert.equal(payload.usage.completion_tokens, 7);
      assert.equal(payload.usage.total_tokens, 18);
    }
  );
});

test("maps reasoning effort to messages thinking payload and beta header", async () => {
  let observedBody: unknown;
  let observedBetaHeader = "";

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (request, body) => {
        observedBody = JSON.parse(body);
        const betaHeader = request.headers["anthropic-beta"];
        observedBetaHeader = Array.isArray(betaHeader)
          ? betaHeader.join(",")
          : (betaHeader ?? "");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_reasoning_cfg",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "thinking",
                thinking: "configured-thinking-ok"
              },
              {
                type: "text",
                text: "configured-text-ok"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 18,
              output_tokens: 10
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
          include: ["reasoning.encrypted_content"],
          reasoning_effort: "high",
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(isRecord(observedBody.thinking));
      assert.equal(observedBody.thinking.type, "enabled");
      assert.equal(observedBody.thinking.budget_tokens, 24576);
      assert.match(observedBetaHeader, /interleaved-thinking-2025-05-14/);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "configured-text-ok");
      assert.equal(payload.choices[0].message.reasoning_content, "configured-thinking-ok");
    }
  );
});

test("maps disabled reasoning effort to messages thinking disabled", async () => {
  let observedBody: unknown;
  let observedBetaHeader = "";

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (request, body) => {
        observedBody = JSON.parse(body);
        const betaHeader = request.headers["anthropic-beta"];
        observedBetaHeader = Array.isArray(betaHeader)
          ? betaHeader.join(",")
          : (betaHeader ?? "");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_reasoning_disabled",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "text",
                text: "disabled-thinking-ok"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 8,
              output_tokens: 6
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "none",
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(isRecord(observedBody.thinking));
      assert.equal(observedBody.thinking.type, "disabled");
      assert.equal(observedBetaHeader, "");
    }
  );
});

test("maps claude thinking blocks to chat reasoning_content", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "msg_claude_thinking",
          model: "claude-opus-4-5-20251101",
          role: "assistant",
          type: "message",
          content: [
            {
              type: "thinking",
              thinking: "claude-thinking-ok"
            },
            {
              type: "text",
              text: "claude-text-ok"
            }
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 14,
            output_tokens: 9
          }
        })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "claude-text-ok");
      assert.equal(payload.choices[0].message.reasoning_content, "claude-thinking-ok");
    }
  );
});

test("maps claude tool_use content to chat tool_calls", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_2",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "bash",
                input: {
                  command: "pwd"
                }
              }
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 22,
              output_tokens: 9
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "run pwd" }],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                description: "run shell command",
                parameters: {
                  type: "object",
                  properties: {
                    command: {
                      type: "string"
                    }
                  },
                  required: ["command"],
                  additionalProperties: false
                }
              }
            }
          ],
          tool_choice: "required",
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.tools));
      assert.ok(isRecord(observedBody.tools[0]));
      assert.equal(observedBody.tools[0].name, "bash");
      assert.ok(isRecord(observedBody.tool_choice));
      assert.equal(observedBody.tool_choice.type, "any");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.equal(payload.choices[0].finish_reason, "tool_calls");
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, null);
      assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0]));
      assert.equal(payload.choices[0].message.tool_calls[0].id, "toolu_123");
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0].function));
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, "bash");
      assert.equal(payload.choices[0].message.tool_calls[0].function.arguments, "{\"command\":\"pwd\"}");
    }
  );
});

test("maps claude interleaved thinking with tool_use", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "msg_claude_interleaved",
          model: "claude-opus-4-5-20251101",
          role: "assistant",
          type: "message",
          content: [
            {
              type: "thinking",
              thinking: "thinking-before-tool "
            },
            {
              type: "text",
              text: "I will run a command."
            },
            {
              type: "tool_use",
              id: "toolu_interleaved",
              name: "bash",
              input: {
                command: "pwd"
              }
            },
            {
              type: "thinking",
              thinking: "thinking-after-tool"
            }
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 26,
            output_tokens: 12
          }
        })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "run pwd" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.equal(payload.choices[0].finish_reason, "tool_calls");
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "I will run a command.");
      assert.equal(payload.choices[0].message.reasoning_content, "thinking-before-tool thinking-after-tool");
      assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0]));
      assert.equal(payload.choices[0].message.tool_calls[0].id, "toolu_interleaved");
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0].function));
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, "bash");
      assert.equal(payload.choices[0].message.tool_calls[0].function.arguments, "{\"command\":\"pwd\"}");
    }
  );
});

test("maps assistant tool_calls + tool result transcript to messages format", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_transcript",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "text",
                text: "claude-transcript-ok"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 40,
              output_tokens: 8
            }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: "{\"command\":\"pwd\"}"
                  }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: "/tmp"
            },
            {
              role: "user",
              content: "continue"
            }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.messages));
      assert.equal(observedBody.messages.length, 3);

      assert.ok(isRecord(observedBody.messages[0]));
      assert.equal(observedBody.messages[0].role, "assistant");
      assert.ok(Array.isArray(observedBody.messages[0].content));
      assert.ok(isRecord(observedBody.messages[0].content[0]));
      assert.equal(observedBody.messages[0].content[0].type, "tool_use");
      assert.equal(observedBody.messages[0].content[0].id, "call_1");
      assert.equal(observedBody.messages[0].content[0].name, "bash");

      assert.ok(isRecord(observedBody.messages[1]));
      assert.equal(observedBody.messages[1].role, "user");
      assert.ok(Array.isArray(observedBody.messages[1].content));
      assert.ok(isRecord(observedBody.messages[1].content[0]));
      assert.equal(observedBody.messages[1].content[0].type, "tool_result");
      assert.equal(observedBody.messages[1].content[0].tool_use_id, "call_1");
      assert.equal(observedBody.messages[1].content[0].content, "/tmp");

      assert.ok(isRecord(observedBody.messages[2]));
      assert.equal(observedBody.messages[2].role, "user");
      assert.equal(observedBody.messages[2].content, "continue");
    }
  );
});

test("returns synthetic chat-completion SSE for claude stream requests", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request) => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "msg_claude_stream",
          model: "claude-opus-4-5-20251101",
          role: "assistant",
          type: "message",
          content: [
            {
              type: "thinking",
              thinking: "claude-stream-thinking-ok"
            },
            {
              type: "text",
              text: "claude-stream-chat-ok"
            }
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 12,
            output_tokens: 8
          }
        })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.ok(response.body.includes("chat.completion.chunk"));
      assert.ok(response.body.includes("\"reasoning_content\":\"claude-stream-thinking-ok\""));
      assert.ok(response.body.includes("claude-stream-chat-ok"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("reports health diagnostics with key-pool state", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/health"
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.authMode, "unauthenticated");
      assert.ok(isRecord(payload.keyPool));
      assert.equal(payload.keyPool.totalKeys, 1);
      assert.equal(payload.keyPool.availableKeys, 1);
      assert.equal(payload.keyPool.cooldownKeys, 0);
      assert.equal(payload.keyPool.nextReadyInMs, 0);
    }
  );
});

test("allows unauthenticated access to health when proxy auth is enabled", async () => {
  await withProxyApp(
    {
      proxyAuthToken: "proxy-secret",
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      }),
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/health"
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.ok, true);
      assert.equal(payload.authMode, "token");
    }
  );
});

test("serves a public landing page at root when proxy auth is enabled", async () => {
  await withProxyApp(
    {
      proxyAuthToken: "proxy-secret",
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      }),
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/",
        headers: {
          host: "localhost:8789",
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
      assert.match(response.body, /Open Hax OpenAI Proxy/);
      assert.match(response.body, /http:\/\/localhost:5174/);
      assert.match(response.body, /Proxy Token/);
    }
  );
});

test("landing page prefers forwarded host when inferring web console url", async () => {
  await withProxyApp(
    {
      proxyAuthToken: "proxy-secret",
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      }),
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/",
        headers: {
          host: "internal-proxy:8789",
          "x-forwarded-host": "proxy.example.com:443",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(response.statusCode, 200);
      assert.match(response.body, /https:\/\/proxy\.example\.com:5174/);
    }
  );
});

test("serves preferred model ordering from models JSON file", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      handleModelCatalog: true,
      models: {
        preferred: ["gpt-5.3-codex", "gemini-3.1-pro-preview"],
        disabled: [],
        aliases: {},
      },
      keysPayload: {
        providers: {
          vivgrid: ["key-a"],
        },
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request) => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: request.method === "GET" && request.url === "/v1/models"
          ? JSON.stringify({
              object: "list",
              data: [
                { id: "gpt-5.3-codex" },
                { id: "gemini-3.1-pro-preview" }
              ]
            })
          : JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const listResponse = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(listResponse.statusCode, 200);

      const listPayload: unknown = listResponse.json();
      assert.ok(isRecord(listPayload));
      assert.equal(listPayload.object, "list");
      assert.ok(Array.isArray(listPayload.data));
      assert.equal(listPayload.data.length, 2);
      assert.ok(isRecord(listPayload.data[0]));
      assert.equal(listPayload.data[0].id, "gpt-5.3-codex");
      assert.ok(isRecord(listPayload.data[1]));
      assert.equal(listPayload.data[1].id, "gemini-3.1-pro-preview");

      const modelResponse = await app.inject({ method: "GET", url: "/v1/models/gpt-5.3-codex" });
      assert.equal(modelResponse.statusCode, 200);
      const modelPayload: unknown = modelResponse.json();
      assert.ok(isRecord(modelPayload));
      assert.equal(modelPayload.id, "gpt-5.3-codex");
    }
  );
});

test("publishes declared static and synthetic models from models JSON alongside discovered models", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      handleModelCatalog: true,
      models: {
        models: ["gpt-5.4-mini", "gpt-5.4-nano", "auto:cheapest"],
        preferred: ["gpt-5.3-codex"],
        disabled: [],
        aliases: {},
      },
      keysPayload: {
        providers: {
          vivgrid: ["key-a"],
        },
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request) => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: request.method === "GET" && request.url === "/v1/models"
          ? JSON.stringify({
              object: "list",
              data: [
                { id: "gpt-5.3-codex" },
              ]
            })
          : JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const listResponse = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(listResponse.statusCode, 200);

      const listPayload: unknown = listResponse.json();
      assert.ok(isRecord(listPayload));
      assert.ok(Array.isArray(listPayload.data));
      const modelIds = listPayload.data
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => entry.id)
        .filter((entry): entry is string => typeof entry === "string");

      assert.ok(modelIds.includes("gpt-5.3-codex"));
      assert.ok(modelIds.includes("gpt-5.4-mini"));
      assert.ok(modelIds.includes("gpt-5.4-nano"));
      assert.ok(modelIds.includes("auto:cheapest"));
    }
  );
});

test("routes declared alias models without requiring provider catalog discovery", async () => {
  const observedModels: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a"],
      models: {
        models: ["model-f16.gguf"],
        preferred: [],
        disabled: [],
        aliases: {
          "blongs-definately-legit-model": "model-f16.gguf",
        },
      },
      keysPayload: {
        providers: {
          vivgrid: ["key-a"],
        },
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request, body) => {
        if (request.method === "POST" && request.url === "/v1/chat/completions") {
          const parsedBody = JSON.parse(body);
          assert.ok(isRecord(parsedBody));
          observedModels.push(typeof parsedBody.model === "string" ? parsedBody.model : "");

          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "chatcmpl-blongs",
              object: "chat.completion",
              model: "model-f16.gguf",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "blongs-ok"
                  },
                  finish_reason: "stop"
                }
              ]
            })
          };
        }

        return {
          status: 404,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ error: { message: "catalog not configured" } })
        };
      }
    },
    async ({ app }) => {
      const listResponse = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(listResponse.statusCode, 200);
      const listPayload: unknown = listResponse.json();
      assert.ok(isRecord(listPayload));
      assert.ok(Array.isArray(listPayload.data));
      const modelIds = listPayload.data
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => entry.id)
        .filter((entry): entry is string => typeof entry === "string");

      assert.ok(modelIds.includes("model-f16.gguf"));
      assert.ok(modelIds.includes("blongs-definately-legit-model"));

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "blongs-definately-legit-model",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-model-alias"], "blongs-definately-legit-model->model-f16.gguf");
      assert.deepEqual(observedModels, ["model-f16.gguf"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "blongs-ok");
    }
  );
});

test("auto:cheapest falls through to the next ranked model when the cheapest priced candidate fails", async () => {
  const observedModels: string[] = [];

  await withProxyApp(
    {
      keys: [],
      handleModelCatalog: true,
      models: {
        models: ["gpt-5.4-nano", "deepseek-v3.2", "auto:cheapest"],
        preferred: [],
        disabled: [],
        aliases: {},
      },
      keysPayload: {
        providers: {
          openai: ["openai-key"],
          "ollama-cloud": ["ollama-key"],
        },
      },
      configOverrides: {
        upstreamProviderId: "openai",
        localOllamaEnabled: false,
      },
      upstreamHandler: async (request, body) => {
        const authorization = request.headers.authorization;
        if (request.method === "GET" && request.url === "/v1/models") {
          if (authorization === "Bearer openai-key") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ object: "list", data: [{ id: "gpt-5.4-nano" }] })
            };
          }

          if (authorization === "Bearer ollama-key") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ object: "list", data: [{ id: "deepseek-v3.2" }] })
            };
          }
        }

        if (request.method === "POST") {
          const parsed = JSON.parse(body) as { readonly model?: string };
          if (typeof parsed.model === "string") {
            observedModels.push(parsed.model);
          }

          if (parsed.model === "gpt-5.4-nano") {
            return {
              status: 400,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ error: { message: "model unavailable" } })
            };
          }

          if (parsed.model === "deepseek-v3.2") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "chatcmpl-auto",
                object: "chat.completion",
                created: 1,
                model: "deepseek-v3.2",
                choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
              })
            };
          }
        }

        return {
          status: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { message: "unexpected request" } })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "auto:cheapest",
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          stream: false,
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-auto-model-candidates"], "gpt-5.4-nano,deepseek-v3.2");
      assert.deepEqual(observedModels, ["gpt-5.4-nano", "deepseek-v3.2"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.model, "deepseek-v3.2");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "OK");
    }
  );
});

test("/v1/responses auto:cheapest ranks only models reachable by responses providers", async () => {
  const observedModels: string[] = [];

  await withProxyApp(
    {
      keys: [],
      handleModelCatalog: true,
      models: {
        models: ["deepseek-v3.2", "gpt-5.4", "auto:cheapest"],
        preferred: [],
        disabled: [],
        aliases: {},
      },
      keysPayload: {
        providers: {
          openai: ["openai-key"],
          "ollama-cloud": ["ollama-key"],
        },
      },
      configOverrides: {
        upstreamProviderId: "openai",
        localOllamaEnabled: false,
      },
      upstreamHandler: async (request, body) => {
        const authorization = request.headers.authorization;
        if (request.method === "GET" && request.url === "/v1/models") {
          if (authorization === "Bearer openai-key") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ object: "list", data: [{ id: "gpt-5.4" }] })
            };
          }

          if (authorization === "Bearer ollama-key") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ object: "list", data: [{ id: "deepseek-v3.2" }] })
            };
          }
        }

        if (request.method === "POST" && request.url === "/v1/responses") {
          const parsed = JSON.parse(body) as { readonly model?: string };
          if (typeof parsed.model === "string") {
            observedModels.push(parsed.model);
          }

          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "resp_auto",
              object: "response",
              model: parsed.model,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "OK", annotations: [] }]
                }
              ]
            })
          };
        }

        return {
          status: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { message: "unexpected request" } })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "auto:cheapest",
          input: "Reply with exactly OK.",
          stream: false,
          max_output_tokens: 8,
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-auto-model-candidates"], "gpt-5.4");
      assert.deepEqual(observedModels, ["gpt-5.4"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.model, "gpt-5.4");
    }
  );
});

test("returns 403 when requested model is disabled", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      handleModelCatalog: true,
      models: {
        preferred: ["gpt-5.3-codex", "gemini-3.1-pro-preview"],
        disabled: ["gemini-3.1-pro-preview"],
        aliases: {},
      },
      keysPayload: {
        providers: {
          vivgrid: ["key-a"],
        },
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request) => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: request.method === "GET" && request.url === "/v1/models"
          ? JSON.stringify({
              object: "list",
              data: [
                { id: "gpt-5.3-codex" },
                { id: "gemini-3.1-pro-preview" }
              ]
            })
          : JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 403);
      assert.equal(response.headers["x-open-hax-error-code"], "model_disabled");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "model_disabled");
    }
  );
});

test("persists stable prompt cache keys on sessions and exposes them via UI API", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          title: "Caching test"
        }
      });

      assert.equal(createResponse.statusCode, 201);
      const createdPayload: unknown = createResponse.json();
      assert.ok(isRecord(createdPayload));
      assert.ok(isRecord(createdPayload.session));
      const createdSession = createdPayload.session;
      const promptCacheKey = typeof createdSession.promptCacheKey === "string" ? createdSession.promptCacheKey : "";
      assert.ok(promptCacheKey.length > 0);
      const sessionId = typeof createdSession.id === "string" ? createdSession.id : "";
      assert.ok(sessionId.length > 0);
      const cacheKeyResponse = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/cache-key`
      });

      assert.equal(cacheKeyResponse.statusCode, 200);
      const cacheKeyPayload: unknown = cacheKeyResponse.json();
      assert.ok(isRecord(cacheKeyPayload));
      assert.equal(cacheKeyPayload.promptCacheKey, promptCacheKey);

      const getSessionResponse = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}`
      });
      const getSessionPayload: unknown = getSessionResponse.json();
      assert.ok(isRecord(getSessionPayload));
      assert.ok(isRecord(getSessionPayload.session));
      assert.equal(getSessionPayload.session.promptCacheKey, promptCacheKey);
    }
  );
});

test("session UI routes support append, fork, and search after extraction from ui-routes monolith", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          title: "Session route extraction test"
        }
      });

      assert.equal(createResponse.statusCode, 201);
      const createPayload: unknown = createResponse.json();
      assert.ok(isRecord(createPayload));
      assert.ok(isRecord(createPayload.session));
      const sessionId = typeof createPayload.session.id === "string" ? createPayload.session.id : "";
      assert.ok(sessionId.length > 0);

      const appendResponse = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        headers: {
          "content-type": "application/json"
        },
        payload: {
          role: "user",
          content: "hello extracted session routes"
        }
      });

      assert.equal(appendResponse.statusCode, 201);
      const appendPayload: unknown = appendResponse.json();
      assert.ok(isRecord(appendPayload));
      assert.equal(appendPayload.sessionId, sessionId);
      assert.ok(isRecord(appendPayload.message));
      assert.equal(appendPayload.message.content, "hello extracted session routes");

      const forkResponse = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/fork`,
        headers: {
          "content-type": "application/json"
        },
        payload: {}
      });

      assert.equal(forkResponse.statusCode, 201);
      const forkPayload: unknown = forkResponse.json();
      assert.ok(isRecord(forkPayload));
      assert.ok(isRecord(forkPayload.session));
      assert.equal(forkPayload.session.forkedFromSessionId, sessionId);
      assert.ok(Array.isArray(forkPayload.session.messages));
      assert.equal(forkPayload.session.messages.length, 1);

      const searchResponse = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/search",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          query: "extracted session routes",
          limit: 5
        }
      });

      assert.equal(searchResponse.statusCode, 200);
      const searchPayload: unknown = searchResponse.json();
      assert.ok(isRecord(searchPayload));
      assert.ok(searchPayload.source === "fallback" || searchPayload.source === "chroma");
      assert.ok(Array.isArray(searchPayload.results));
      assert.ok(searchPayload.results.length >= 1);
      assert.ok(isRecord(searchPayload.results[0]));
      assert.equal(searchPayload.results[0].sessionId, sessionId);
    }
  );
});

test("/api/v1/sessions persist stable prompt cache keys and expose them via canonical control-plane routes", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          title: "Canonical caching test"
        }
      });

      assert.equal(createResponse.statusCode, 201);
      const createdPayload: unknown = createResponse.json();
      assert.ok(isRecord(createdPayload));
      assert.ok(isRecord(createdPayload.session));
      const createdSession = createdPayload.session;
      const promptCacheKey = typeof createdSession.promptCacheKey === "string" ? createdSession.promptCacheKey : "";
      assert.ok(promptCacheKey.length > 0);
      const sessionId = typeof createdSession.id === "string" ? createdSession.id : "";
      assert.ok(sessionId.length > 0);

      const cacheKeyResponse = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/cache-key`,
        headers: {
          authorization: "Bearer ui-token",
        },
      });

      assert.equal(cacheKeyResponse.statusCode, 200);
      const cacheKeyPayload: unknown = cacheKeyResponse.json();
      assert.ok(isRecord(cacheKeyPayload));
      assert.equal(cacheKeyPayload.promptCacheKey, promptCacheKey);

      const getSessionResponse = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}`,
        headers: {
          authorization: "Bearer ui-token",
        },
      });
      const getSessionPayload: unknown = getSessionResponse.json();
      assert.ok(isRecord(getSessionPayload));
      assert.ok(isRecord(getSessionPayload.session));
      assert.equal(getSessionPayload.session.promptCacheKey, promptCacheKey);
    }
  );
});

test("/api/v1/sessions support append, fork, and search on canonical control-plane routes", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          title: "Canonical session route extraction test"
        }
      });

      assert.equal(createResponse.statusCode, 201);
      const createPayload: unknown = createResponse.json();
      assert.ok(isRecord(createPayload));
      assert.ok(isRecord(createPayload.session));
      const sessionId = typeof createPayload.session.id === "string" ? createPayload.session.id : "";
      assert.ok(sessionId.length > 0);

      const appendResponse = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          role: "user",
          content: "hello canonical session routes"
        }
      });

      assert.equal(appendResponse.statusCode, 201);
      const appendPayload: unknown = appendResponse.json();
      assert.ok(isRecord(appendPayload));
      assert.equal(appendPayload.sessionId, sessionId);
      assert.ok(isRecord(appendPayload.message));
      assert.equal(appendPayload.message.content, "hello canonical session routes");

      const forkResponse = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/fork`,
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {}
      });

      assert.equal(forkResponse.statusCode, 201);
      const forkPayload: unknown = forkResponse.json();
      assert.ok(isRecord(forkPayload));
      assert.ok(isRecord(forkPayload.session));
      assert.equal(forkPayload.session.forkedFromSessionId, sessionId);
      assert.ok(Array.isArray(forkPayload.session.messages));
      assert.equal(forkPayload.session.messages.length, 1);

      const searchResponse = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/search",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          query: "canonical session routes",
          limit: 5
        }
      });

      assert.equal(searchResponse.statusCode, 200);
      const searchPayload: unknown = searchResponse.json();
      assert.ok(isRecord(searchPayload));
      assert.ok(searchPayload.source === "fallback" || searchPayload.source === "chroma");
      assert.ok(Array.isArray(searchPayload.results));
      assert.ok(searchPayload.results.length >= 1);
      assert.ok(isRecord(searchPayload.results[0]));
      assert.equal(searchPayload.results[0].sessionId, sessionId);
    }
  );
});

test("credential summary route works after extraction from ui-routes monolith", async () => {
  await withClearedAmbientProviders(async () => {
    await withProxyApp(
      {
        keys: [],
        keysPayload: {
          providers: {
            vivgrid: {
              auth: "api_key",
              accounts: [
                { id: "viv-a", api_key: "viv-secret-a" }
              ]
            },
            openai: {
              auth: "oauth_bearer",
              accounts: [
                { id: "openai-a", access_token: "openai-secret-a", refresh_token: "refresh-a" }
              ]
            }
          }
        },
        upstreamHandler: async () => ({
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ ok: true })
        })
      },
      async ({ app }) => {
        const hiddenResponse = await app.inject({
          method: "GET",
          url: "/api/v1/credentials"
        });

        assert.equal(hiddenResponse.statusCode, 200);
        const hiddenPayload: unknown = hiddenResponse.json();
        assert.ok(isRecord(hiddenPayload));
        assert.ok(Array.isArray(hiddenPayload.providers));
        assert.equal(hiddenPayload.providers.length, 2);
        assert.ok(isRecord(hiddenPayload.providers[0]));
        assert.ok(Array.isArray(hiddenPayload.providers[0].accounts));
        assert.ok(isRecord(hiddenPayload.providers[0].accounts[0]));
        assert.equal(hiddenPayload.providers[0].accounts[0].secret, undefined);
        assert.equal(typeof hiddenPayload.providers[0].accounts[0].secretPreview, "string");
        assert.ok(isRecord(hiddenPayload.keyPoolStatuses));
        assert.ok(isRecord(hiddenPayload.requestLogSummary));

        const revealResponse = await app.inject({
          method: "GET",
          url: "/api/v1/credentials?reveal=1"
        });

        assert.equal(revealResponse.statusCode, 200);
        const revealPayload: unknown = revealResponse.json();
        assert.ok(isRecord(revealPayload));
        assert.ok(Array.isArray(revealPayload.providers));
        const vivgridProvider = revealPayload.providers.find((provider: any) => provider?.id === "vivgrid");
        assert.ok(vivgridProvider);
        assert.ok(Array.isArray(vivgridProvider.accounts));
        assert.equal(vivgridProvider.accounts[0].secret, "viv-secret-a");
      }
    );
  });
});

test("/api/v1/credentials summary route works on the canonical control-plane surface", async () => {
  await withClearedAmbientProviders(async () => {
    await withProxyApp(
      {
        keys: [],
        keysPayload: {
          providers: {
            vivgrid: {
              auth: "api_key",
              accounts: [
                { id: "viv-a", api_key: "viv-secret-a" }
              ]
            },
            openai: {
              auth: "oauth_bearer",
              accounts: [
                { id: "openai-a", access_token: "openai-secret-a", refresh_token: "refresh-a" }
              ]
            }
          }
        },
        upstreamHandler: async () => ({
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ ok: true })
        })
      },
      async ({ app }) => {
        const hiddenResponse = await app.inject({
          method: "GET",
          url: "/api/v1/credentials"
        });

        assert.equal(hiddenResponse.statusCode, 200);
        const hiddenPayload: unknown = hiddenResponse.json();
        assert.ok(isRecord(hiddenPayload));
        assert.ok(Array.isArray(hiddenPayload.providers));
        assert.equal(hiddenPayload.providers.length, 2);
        assert.ok(isRecord(hiddenPayload.providers[0]));
        assert.ok(Array.isArray(hiddenPayload.providers[0].accounts));
        assert.ok(isRecord(hiddenPayload.providers[0].accounts[0]));
        assert.equal(hiddenPayload.providers[0].accounts[0].secret, undefined);
        assert.equal(typeof hiddenPayload.providers[0].accounts[0].secretPreview, "string");
        assert.ok(isRecord(hiddenPayload.keyPoolStatuses));
        assert.ok(isRecord(hiddenPayload.requestLogSummary));

        const revealResponse = await app.inject({
          method: "GET",
          url: "/api/v1/credentials?reveal=1"
        });

        assert.equal(revealResponse.statusCode, 200);
        const revealPayload: unknown = revealResponse.json();
        assert.ok(isRecord(revealPayload));
        assert.ok(Array.isArray(revealPayload.providers));
        const vivgridProvider = revealPayload.providers.find((provider: any) => provider?.id === "vivgrid");
        assert.ok(vivgridProvider);
        assert.ok(Array.isArray(vivgridProvider.accounts));
        assert.equal(vivgridProvider.accounts[0].secret, "viv-secret-a");
      }
    );
  });
});

test("/api/v1/request-logs, /api/v1/dashboard/overview, and /api/v1/analytics/provider-model work on the canonical observability surface", async () => {
  const now = Date.now();
  await withProxyApp(
    {
      keys: ["key-a"],
      requestLogsPayload: {
        entries: [
          {
            id: "entry-1",
            timestamp: now - 30_000,
            providerId: "openai",
            accountId: "acct-1",
            authType: "oauth_bearer",
            model: "gpt-5.4",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 120,
            promptTokens: 70,
            completionTokens: 30,
            totalTokens: 100,
            costUsd: 0.1,
            energyJoules: 10,
            waterEvaporatedMl: 0.005,
          },
        ],
        hourlyBuckets: [],
        dailyBuckets: [],
        dailyModelBuckets: [],
        dailyAccountBuckets: [],
        accountAccumulators: [],
      },
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const logsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/request-logs?limit=1",
      });
      assert.equal(logsResponse.statusCode, 200);
      const logsPayload: unknown = logsResponse.json();
      assert.ok(isRecord(logsPayload));
      assert.ok(Array.isArray(logsPayload.entries));
      assert.ok(isRecord(logsPayload.entries[0]));
      assert.equal(logsPayload.entries[0].providerId, "openai");

      const overviewResponse = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overview?window=daily",
      });
      assert.equal(overviewResponse.statusCode, 200);
      const overviewPayload: unknown = overviewResponse.json();
      assert.ok(isRecord(overviewPayload));
      assert.ok(isRecord(overviewPayload.summary));
      assert.equal(overviewPayload.summary.tokens24h, 100);
      assert.equal(overviewPayload.summary.topProvider, "openai");

      const analyticsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/provider-model?window=daily",
      });
      assert.equal(analyticsResponse.statusCode, 200);
      const analyticsPayload: unknown = analyticsResponse.json();
      assert.ok(isRecord(analyticsPayload));
      assert.ok(Array.isArray(analyticsPayload.models));
      assert.ok(isRecord(analyticsPayload.models[0]));
      assert.equal(analyticsPayload.models[0].model, "gpt-5.4");
    }
  );
});

test("/api/v1/tools returns seeded tools for the requested model", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/tools?model=gpt-5.3-codex",
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.model, "gpt-5.3-codex");
      assert.ok(Array.isArray(payload.tools));
      assert.ok(payload.tools.length > 0);
    },
  );
});

test("/api/v1/hosts/self and /api/v1/hosts/overview work on the canonical host dashboard surface", async () => {
  const previousTargets = process.env.HOST_DASHBOARD_TARGETS_JSON;
  const previousSelfId = process.env.HOST_DASHBOARD_SELF_ID;

  process.env.HOST_DASHBOARD_TARGETS_JSON = JSON.stringify([
    { id: "local", label: "Local host" },
  ]);
  process.env.HOST_DASHBOARD_SELF_ID = "local";

  try {
    await withProxyApp(
      {
        keys: ["key-a"],
        proxyAuthToken: "ui-token",
        upstreamHandler: async () => ({
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ ok: true })
        })
      },
      async ({ app }) => {
        const selfResponse = await app.inject({
          method: "GET",
          url: "/api/v1/hosts/self",
          headers: {
            authorization: "Bearer ui-token",
          },
        });

        assert.equal(selfResponse.statusCode, 200);
        const selfPayload: unknown = selfResponse.json();
        assert.ok(isRecord(selfPayload));
        assert.equal(selfPayload.id, "local");
        assert.equal(selfPayload.label, "Local host");
        assert.ok(Array.isArray(selfPayload.errors));

        const overviewResponse = await app.inject({
          method: "GET",
          url: "/api/v1/hosts/overview",
          headers: {
            authorization: "Bearer ui-token",
          },
        });

        assert.equal(overviewResponse.statusCode, 200);
        const overviewPayload: unknown = overviewResponse.json();
        assert.ok(isRecord(overviewPayload));
        assert.equal(overviewPayload.selfTargetId, "local");
        assert.ok(Array.isArray(overviewPayload.hosts));
        assert.equal(overviewPayload.hosts.length, 1);
        assert.ok(isRecord(overviewPayload.hosts[0]));
        assert.equal(overviewPayload.hosts[0].id, "local");
      },
    );
  } finally {
    if (previousTargets === undefined) {
      delete process.env.HOST_DASHBOARD_TARGETS_JSON;
    } else {
      process.env.HOST_DASHBOARD_TARGETS_JSON = previousTargets;
    }

    if (previousSelfId === undefined) {
      delete process.env.HOST_DASHBOARD_SELF_ID;
    } else {
      process.env.HOST_DASHBOARD_SELF_ID = previousSelfId;
    }
  }
});

test("/api/v1/events routes are wired and report missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/events",
        headers: {
          authorization: "Bearer ui-token",
        },
      });
      assert.equal(listResponse.statusCode, 503);
      assert.match(listResponse.body, /Event store not available/i);

      const tagsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/events/tags",
        headers: {
          authorization: "Bearer ui-token",
        },
      });
      assert.equal(tagsResponse.statusCode, 503);

      const addTagResponse = await app.inject({
        method: "POST",
        url: "/api/v1/events/example/tag",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json",
        },
        payload: { tag: "needs-review" },
      });
      assert.equal(addTagResponse.statusCode, 503);

      const removeTagResponse = await app.inject({
        method: "DELETE",
        url: "/api/v1/events/example/tag",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json",
        },
        payload: { tag: "needs-review" },
      });
      assert.equal(removeTagResponse.statusCode, 503);
    },
  );
});

test("federation self route stays wired after extraction from ui-routes monolith", async () => {
  const previous = {
    nodeId: process.env.FEDERATION_SELF_NODE_ID,
    groupId: process.env.FEDERATION_SELF_GROUP_ID,
    clusterId: process.env.FEDERATION_SELF_CLUSTER_ID,
    peerDid: process.env.FEDERATION_SELF_PEER_DID,
    publicBaseUrl: process.env.FEDERATION_SELF_PUBLIC_BASE_URL,
  };

  process.env.FEDERATION_SELF_NODE_ID = "node-1";
  process.env.FEDERATION_SELF_GROUP_ID = "group-1";
  process.env.FEDERATION_SELF_CLUSTER_ID = "cluster-1";
  process.env.FEDERATION_SELF_PEER_DID = "did:web:proxy.example";
  process.env.FEDERATION_SELF_PUBLIC_BASE_URL = "https://proxy.example";

  try {
    await withProxyApp(
      {
        keys: ["key-a"],
        proxyAuthToken: "ui-token",
        upstreamHandler: async () => ({
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ ok: true })
        })
      },
      async ({ app }) => {
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/federation/self",
          headers: {
            authorization: "Bearer ui-token"
          }
        });

        assert.equal(response.statusCode, 200);
        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.equal(payload.nodeId, "node-1");
        assert.equal(payload.groupId, "group-1");
        assert.equal(payload.clusterId, "cluster-1");
        assert.equal(payload.peerDid, "did:web:proxy.example");
        assert.equal(payload.publicBaseUrl, "https://proxy.example");
        assert.equal(payload.peerCount, 0);
      }
    );
  } finally {
    process.env.FEDERATION_SELF_NODE_ID = previous.nodeId;
    process.env.FEDERATION_SELF_GROUP_ID = previous.groupId;
    process.env.FEDERATION_SELF_CLUSTER_ID = previous.clusterId;
    process.env.FEDERATION_SELF_PEER_DID = previous.peerDid;
    process.env.FEDERATION_SELF_PUBLIC_BASE_URL = previous.publicBaseUrl;
  }
});

test("/api/v1/federation/self exposes canonical federation self metadata", async () => {
  const previous = {
    nodeId: process.env.FEDERATION_SELF_NODE_ID,
    groupId: process.env.FEDERATION_SELF_GROUP_ID,
    clusterId: process.env.FEDERATION_SELF_CLUSTER_ID,
    peerDid: process.env.FEDERATION_SELF_PEER_DID,
    publicBaseUrl: process.env.FEDERATION_SELF_PUBLIC_BASE_URL,
  };

  process.env.FEDERATION_SELF_NODE_ID = "node-1";
  process.env.FEDERATION_SELF_GROUP_ID = "group-1";
  process.env.FEDERATION_SELF_CLUSTER_ID = "cluster-1";
  process.env.FEDERATION_SELF_PEER_DID = "did:web:proxy.example";
  process.env.FEDERATION_SELF_PUBLIC_BASE_URL = "https://proxy.example";

  try {
    await withProxyApp(
      {
        keys: ["key-a"],
        proxyAuthToken: "ui-token",
        upstreamHandler: async () => ({
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ ok: true })
        })
      },
      async ({ app }) => {
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/federation/self",
          headers: {
            authorization: "Bearer ui-token"
          }
        });

        assert.equal(response.statusCode, 200);
        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.equal(payload.nodeId, "node-1");
        assert.equal(payload.groupId, "group-1");
        assert.equal(payload.clusterId, "cluster-1");
        assert.equal(payload.peerDid, "did:web:proxy.example");
        assert.equal(payload.publicBaseUrl, "https://proxy.example");
        assert.equal(payload.peerCount, 0);
      }
    );
  } finally {
    process.env.FEDERATION_SELF_NODE_ID = previous.nodeId;
    process.env.FEDERATION_SELF_GROUP_ID = previous.groupId;
    process.env.FEDERATION_SELF_CLUSTER_ID = previous.clusterId;
    process.env.FEDERATION_SELF_PEER_DID = previous.peerDid;
    process.env.FEDERATION_SELF_PUBLIC_BASE_URL = previous.publicBaseUrl;
  }
});

test("federation peer routes stay wired after extraction and report missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/federation/peers?ownerSubject=owner-1",
        headers: {
          authorization: "Bearer ui-token"
        }
      });

      assert.equal(listResponse.statusCode, 503);
      const listPayload: unknown = listResponse.json();
      assert.ok(isRecord(listPayload));
      assert.equal(listPayload.error, "federation_store_not_supported");

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/federation/peers",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          ownerCredential: "did:web:owner.example",
          label: "Peer 1",
          baseUrl: "https://peer.example"
        }
      });

      assert.equal(createResponse.statusCode, 503);
      const createPayload: unknown = createResponse.json();
      assert.ok(isRecord(createPayload));
      assert.equal(createPayload.error, "federation_store_not_supported");
    }
  );
});

test("/api/v1/federation peer and account routes stay wired and report missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const listPeersResponse = await app.inject({
        method: "GET",
        url: "/api/v1/federation/peers?ownerSubject=owner-1",
        headers: {
          authorization: "Bearer ui-token"
        }
      });

      assert.equal(listPeersResponse.statusCode, 503);
      const listPeersPayload: unknown = listPeersResponse.json();
      assert.ok(isRecord(listPeersPayload));
      assert.equal(listPeersPayload.error, "federation_store_not_supported");

      const createPeerResponse = await app.inject({
        method: "POST",
        url: "/api/v1/federation/peers",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          ownerCredential: "did:web:owner.example",
          label: "Peer 1",
          baseUrl: "https://peer.example"
        }
      });

      assert.equal(createPeerResponse.statusCode, 503);

      const accountsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/federation/accounts?ownerSubject=owner-1",
        headers: {
          authorization: "Bearer ui-token"
        }
      });

      assert.equal(accountsResponse.statusCode, 503);
      const accountsPayload: unknown = accountsResponse.json();
      assert.ok(isRecord(accountsPayload));
      assert.equal(accountsPayload.error, "federation_store_not_supported");
    }
  );
});

test("/api/v1/federation/bridges lists canonical bridge sessions", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/federation/bridges",
        headers: {
          authorization: "Bearer ui-token"
        }
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.sessions));
      assert.equal(payload.sessions.length, 0);
    }
  );
});


test("federation diff-events route stays wired after extraction and reports missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/federation/diff-events?ownerSubject=owner-1&afterSeq=5&limit=2",
        headers: {
          authorization: "Bearer ui-token"
        }
      });

      assert.equal(response.statusCode, 503);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.error, "federation_store_not_supported");
    }
  );
});

test("federation accounts route stays wired after extraction and reports missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/federation/accounts?ownerSubject=owner-1",
        headers: {
          authorization: "Bearer ui-token"
        }
      });

      assert.equal(response.statusCode, 503);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.error, "federation_store_not_supported");
    }
  );
});

test("federation projected-account import route stays wired after extraction and reports missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/federation/projected-accounts/import",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          accounts: [
            {
              sourcePeerId: "peer-1",
              ownerSubject: "did:plc:owner-1",
              providerId: "openai",
              accountId: "acct-1"
            }
          ]
        }
      });

      assert.equal(response.statusCode, 503);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.error, "federation_store_not_supported");
    }
  );
});

test("federation projected-account imported route stays wired after extraction and reports missing store cleanly", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "ui-token",
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/federation/projected-accounts/imported",
        headers: {
          authorization: "Bearer ui-token",
          "content-type": "application/json"
        },
        payload: {
          sourcePeerId: "peer-1",
          providerId: "openai",
          accountId: "acct-1"
        }
      });

      assert.equal(response.statusCode, 503);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.error, "federation_store_not_supported");
    }
  );
});

test("includes ollama provider catalog models and largest-size aliases in /v1/models", async () => {
  await withProxyApp(
    {
      keys: [],
      handleModelCatalog: true,
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-catalog-key"]
        }
      },
      models: {
        preferred: ["gpt-5.3-codex"],
        disabled: [],
        aliases: {},
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
      },
      upstreamHandler: async (request) => {
        if (request.method === "GET" && request.url === "/v1/models") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              object: "list",
              data: [
                { id: "qwen3.5:32b" },
                { id: "qwen3.5:397b" },
                { id: "qwen3-coder:30b" },
                { id: "qwen3-coder:480b" },
                { id: "qwen3-vl:90b-instruct" },
                { id: "qwen3-vl:235b" }
              ]
            })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ ok: true })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(response.statusCode, 200);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "list");
      assert.ok(Array.isArray(payload.data));

      const ids = payload.data
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => (typeof entry.id === "string" ? entry.id : undefined))
        .filter((entry): entry is string => typeof entry === "string");

      assert.ok(ids.includes("qwen3.5:397b"));
      assert.ok(ids.includes("qwen3-coder:480b"));
      assert.ok(ids.includes("qwen3-vl:235b"));
      assert.ok(ids.includes("qwen3.5"));
      assert.ok(ids.includes("qwen3-coder"));
      assert.ok(ids.includes("qwen3-vl"));
      assert.ok(!ids.includes("gpt-5.3-codex"));
    }
  );
});

test("returns 404 when requested model is not in provider catalogs", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      handleModelCatalog: true,
      models: {
        preferred: ["gpt-5.3-codex"],
        disabled: [],
        aliases: {},
      },
      keysPayload: {
        providers: {
          vivgrid: ["key-a"],
        },
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
      },
      upstreamHandler: async (request) => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: request.method === "GET" && request.url === "/v1/models"
          ? JSON.stringify({
              object: "list",
              data: [
                { id: "gpt-5.3-codex" }
              ]
            })
          : JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.headers["x-open-hax-error-code"], "model_not_found");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "model_not_found");
    }
  );
});

test("rewrites largest-model alias requests for ollama catalog models", async () => {
  const observedModels: string[] = [];

  await withProxyApp(
    {
      keys: [],
      handleModelCatalog: true,
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-alias-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
      },
      upstreamHandler: async (request, body) => {
        if (request.method === "GET" && request.url === "/v1/models") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              object: "list",
              data: [
                { id: "qwen3.5:32b" },
                { id: "qwen3.5:397b" }
              ]
            })
          };
        }

        if (request.method === "POST" && request.url === "/v1/chat/completions") {
          const parsedBody = JSON.parse(body);
          assert.ok(isRecord(parsedBody));
          observedModels.push(typeof parsedBody.model === "string" ? parsedBody.model : "");

          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "chatcmpl-qwen-alias",
              object: "chat.completion",
              model: "qwen3.5:397b",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "alias-ok"
                  },
                  finish_reason: "stop"
                }
              ]
            })
          };
        }

        return {
          status: 404,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ error: { message: "unexpected path" } })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "qwen3.5",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-model-alias"], "qwen3.5->qwen3.5:397b");
      assert.deepEqual(observedModels, ["qwen3.5:397b"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "alias-ok");
    }
  );
});
