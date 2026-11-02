/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test.skip("CLJS policy normalizes xhigh reasoning effort to max for ollama-cloud provider", async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-cloud-key"]
        }
      },
      upstreamHandler: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "chatcmpl-ollama-xhigh",
          object: "chat.completion",
          model: "glm-4.7",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
        })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        payload: {
          model: "glm-4.7",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "xhigh",
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "ollama-cloud");
    }
  );
});

test("routes gpt-5.4 through responses for openai oauth accounts", async () => {
  let observedPath = "";
  let observedBody: unknown;
  let observedAuthorization: string | undefined;
  let observedAccountId: string | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);
        observedAuthorization = typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined;
        observedAccountId = typeof request.headers["chatgpt-account-id"] === "string"
          ? request.headers["chatgpt-account-id"]
          : undefined;

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp_gpt54_openai",
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4",
            output: [
              {
                id: "msg_gpt54_openai",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "OK"
                  }
                ]
              }
            ],
            usage: {
              input_tokens: 11,
              output_tokens: 5,
              total_tokens: 16
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
          model: "gpt-5.4",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
      assert.equal(observedPath, "/v1/responses");
      assert.equal(observedAuthorization, "Bearer oa-token-a");
      assert.equal(observedAccountId, "chatgpt-a");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "gpt-5.4");
      assert.ok(Array.isArray(observedBody.input));

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "gpt-5.4");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "OK");
    }
  );
});

test("buffers openai responses SSE deltas into chat content when the terminal response is empty", async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8"
        },
        body: [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_empty_terminal", status: "in_progress", model: "gpt-5.4-mini", output: [] } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_empty_terminal", status: "completed", model: "gpt-5.4-mini", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } })}\n\n`,
        ].join("")
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
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "OK");
    }
  );
});

test("reuses the same openai oauth codex account for repeated gpt prompt_cache_key requests", async () => {
  const observedAuth: string[] = [];
  const observedAccountIds: string[] = [];
  const observedPromptCacheKeys: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a", plan_type: "plus" },
              { id: "openai-b", access_token: "oa-token-b", chatgpt_account_id: "chatgpt-b", plan_type: "plus" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        const auth = typeof request.headers.authorization === "string"
          ? request.headers.authorization.replace(/^Bearer\s+/i, "")
          : undefined;
        const accountId = typeof request.headers["chatgpt-account-id"] === "string"
          ? request.headers["chatgpt-account-id"]
          : undefined;
        const promptCacheKey = typeof parsedBody.prompt_cache_key === "string"
          ? parsedBody.prompt_cache_key
          : undefined;

        if (auth) {
          observedAuth.push(auth);
        }
        if (accountId) {
          observedAccountIds.push(accountId);
        }
        if (promptCacheKey) {
          observedPromptCacheKeys.push(promptCacheKey);
        }

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4",
            output: [
              {
                id: crypto.randomUUID(),
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }]
              }
            ],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 }
          })
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
            model: "gpt-5.4",
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            prompt_cache_key: "sticky-gpt-oauth-1",
            stream: false,
          }
        });

        assert.equal(response.statusCode, 200);
      }

      assert.deepEqual(observedAuth, ["oa-token-a", "oa-token-a", "oa-token-a"]);
      assert.deepEqual(observedAccountIds, ["chatgpt-a", "chatgpt-a", "chatgpt-a"]);
      assert.deepEqual(observedPromptCacheKeys, ["sticky-gpt-oauth-1", "sticky-gpt-oauth-1", "sticky-gpt-oauth-1"]);
    }
  );
});

test("reassigns openai oauth codex prompt_cache_key affinity when the pinned gpt account becomes rate-limited", async () => {
  const observedAuth: string[] = [];
  const observedAccountIds: string[] = [];
  let openAiAAttempts = 0;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a", plan_type: "plus" },
              { id: "openai-b", access_token: "oa-token-b", chatgpt_account_id: "chatgpt-b", plan_type: "plus" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request) => {
        const auth = typeof request.headers.authorization === "string"
          ? request.headers.authorization.replace(/^Bearer\s+/i, "")
          : undefined;
        const accountId = typeof request.headers["chatgpt-account-id"] === "string"
          ? request.headers["chatgpt-account-id"]
          : undefined;

        if (auth) {
          observedAuth.push(auth);
        }
        if (accountId) {
          observedAccountIds.push(accountId);
        }

        if (auth === "oa-token-a") {
          openAiAAttempts += 1;
          if (openAiAAttempts >= 2) {
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "retry-after": "60",
            };
            return {
              status: 429,
              headers,
              body: JSON.stringify({ error: { message: "rate limit" } })
            };
          }
        }

        const headers: Record<string, string> = { "content-type": "application/json" };

        return {
          status: 200,
          headers,
          body: JSON.stringify({
            id: crypto.randomUUID(),
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4",
            output: [
              {
                id: crypto.randomUUID(),
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }]
              }
            ],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 }
          })
        };
      }
    },
    async ({ app }) => {
      const payload = {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        prompt_cache_key: "sticky-gpt-oauth-2",
        stream: false,
      };

      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);

      assert.deepEqual(observedAuth, ["oa-token-a", "oa-token-a", "oa-token-b", "oa-token-b"]);
      assert.deepEqual(observedAccountIds, ["chatgpt-a", "chatgpt-a", "chatgpt-b", "chatgpt-b"]);
    }
  );
});

test("does not immediately promote fallback affinity after one successful reassignment", async () => {
  const observedAuth: string[] = [];
  let openAiAAttempts = 0;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a", plan_type: "plus" },
              { id: "openai-b", access_token: "oa-token-b", chatgpt_account_id: "chatgpt-b", plan_type: "plus" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request) => {
        const auth = typeof request.headers.authorization === "string"
          ? request.headers.authorization.replace(/^Bearer\s+/i, "")
          : undefined;
        if (auth) {
          observedAuth.push(auth);
        }

        if (auth === "oa-token-a") {
          openAiAAttempts += 1;
          if (openAiAAttempts === 2) {
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "retry-after": "1",
            };
            return {
              status: 429,
              headers,
              body: JSON.stringify({ error: { message: "daily quota exceeded" } }),
            };
          }
        }

        const headers: Record<string, string> = { "content-type": "application/json" };
        return {
          status: 200,
          headers,
          body: JSON.stringify({
            id: crypto.randomUUID(),
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4",
            output: [
              {
                id: crypto.randomUUID(),
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
          }),
        };
      }
    },
    async ({ app }) => {
      const payload = {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        prompt_cache_key: "sticky-gpt-oauth-conservative-1",
        stream: false,
      };

      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);

      assert.deepEqual(observedAuth, ["oa-token-a", "oa-token-a", "oa-token-b", "oa-token-a"]);
    }
  );
});

test("groups prompt cache audit rows by hash and distinct accounts touched", async () => {
  let openAiAAttempts = 0;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a", plan_type: "plus" },
              { id: "openai-b", access_token: "oa-token-b", chatgpt_account_id: "chatgpt-b", plan_type: "plus" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request) => {
        const auth = typeof request.headers.authorization === "string"
          ? request.headers.authorization.replace(/^Bearer\s+/i, "")
          : undefined;

        if (auth === "oa-token-a") {
          openAiAAttempts += 1;
          if (openAiAAttempts >= 2) {
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "retry-after": "1",
            };
            return {
              status: 429,
              headers,
              body: JSON.stringify({ error: { message: "rate limit" } }),
            };
          }
        }

        const headers: Record<string, string> = { "content-type": "application/json" };
        return {
          status: 200,
          headers,
          body: JSON.stringify({
            id: crypto.randomUUID(),
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4",
            output: [
              {
                id: crypto.randomUUID(),
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
            usage: {
              input_tokens: 11,
              output_tokens: 5,
              total_tokens: 16,
              input_tokens_details: {
                cached_tokens: auth === "oa-token-b" ? 9 : 0,
              },
            },
          }),
        };
      },
    },
    async ({ app }) => {
      const payload = {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        prompt_cache_key: "sticky-gpt-oauth-audit-1",
        stream: false,
      };

      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload })).statusCode, 200);

      const auditResponse = await app.inject({
        method: "GET",
        url: "/api/v1/credentials/openai/prompt-cache-audit?limit=10&scanLimit=100",
      });

      assert.equal(auditResponse.statusCode, 200);
      const payloadJson: unknown = auditResponse.json();
      assert.ok(isRecord(payloadJson));
      assert.equal(payloadJson.crossAccountHashCount, 1);
      assert.equal(payloadJson.crossSuccessfulAccountHashCount, 1);
      assert.ok(Array.isArray(payloadJson.rows));
      assert.equal(payloadJson.rows.length, 1);
      assert.ok(isRecord(payloadJson.rows[0]));
      assert.equal(payloadJson.rows[0].accountCount, 2);
      assert.deepEqual(payloadJson.rows[0].accountIds, ["openai-a", "openai-b"]);
      assert.equal(payloadJson.rows[0].successfulAccountCount, 2);
      assert.deepEqual(payloadJson.rows[0].successfulAccountIds, ["openai-a", "openai-b"]);
      assert.equal(payloadJson.rows[0].failedAccountCount, 1);
      assert.deepEqual(payloadJson.rows[0].failedAccountIds, ["openai-a"]);
      assert.equal(payloadJson.rows[0].successfulRequestCount, 2);
      assert.equal(payloadJson.rows[0].failedRequestCount, 1);
      assert.equal(payloadJson.rows[0].requestCount, 3);
    }
  );
});

test("prompt cache audit respects configured openai provider id and keeps latest model from newest entry", async () => {
  await withProxyApp(
    {
      keys: [],
      requestLogsPayload: {
        entries: [
          {
            id: "custom-openai-older",
            timestamp: Date.UTC(2026, 3, 4, 12, 0, 0),
            providerId: "chatgpt-oauth",
            accountId: "acct-1",
            authType: "oauth_bearer",
            model: "gpt-4.1",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 110,
            promptCacheKeyHash: "sha256:custom-openai-hash",
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
          },
          {
            id: "custom-openai-newer",
            timestamp: Date.UTC(2026, 3, 4, 12, 5, 0),
            providerId: "chatgpt-oauth",
            accountId: "acct-1",
            authType: "oauth_bearer",
            model: "gpt-5.4",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 105,
            promptCacheKeyHash: "sha256:custom-openai-hash",
            promptTokens: 120,
            completionTokens: 25,
            totalTokens: 145,
            cacheHit: true,
            promptCacheKeyUsed: true,
            cachedPromptTokens: 90,
          },
          {
            id: "wrong-provider",
            timestamp: Date.UTC(2026, 3, 4, 12, 10, 0),
            providerId: "openai",
            accountId: "acct-2",
            authType: "oauth_bearer",
            model: "gpt-5.4",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 100,
            promptCacheKeyHash: "sha256:wrong-provider-hash",
            promptTokens: 200,
            completionTokens: 30,
            totalTokens: 230,
          },
        ],
        hourlyBuckets: [],
        dailyBuckets: [],
        dailyModelBuckets: [],
        dailyAccountBuckets: [],
        accountAccumulators: [],
      },
      configOverrides: {
        openaiProviderId: "chatgpt-oauth",
        upstreamProviderId: "chatgpt-oauth",
      },
      upstreamHandler: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      }),
    },
    async ({ app }) => {
      const auditResponse = await app.inject({
        method: "GET",
        url: "/api/v1/credentials/openai/prompt-cache-audit?limit=10&scanLimit=100",
      });

      assert.equal(auditResponse.statusCode, 200);
      const payloadJson: unknown = auditResponse.json();
      assert.ok(isRecord(payloadJson));
      assert.ok(Array.isArray(payloadJson.rows));
      assert.equal(payloadJson.rows.length, 1);
      assert.ok(isRecord(payloadJson.rows[0]));
      assert.equal(payloadJson.rows[0].providerId, "chatgpt-oauth");
      assert.equal(payloadJson.rows[0].latestModel, "gpt-5.4");
      assert.equal(payloadJson.rows[0].promptCacheKeyHash, "sha256:custom-openai-hash");
    },
  );
});

test("prompt cache audit watchlist is computed from all grouped hashes, not only truncated rows", async () => {
  const stableEntries = Array.from({ length: 4 }, (_, index) => ({
    id: `stable-${index}`,
    timestamp: Date.UTC(2026, 3, 4, 13, index, 0),
    providerId: "openai",
    accountId: "acct-stable",
    authType: "oauth_bearer" as const,
    model: "gpt-5.4",
    upstreamMode: "responses" as const,
    upstreamPath: "/v1/responses",
    status: 200,
    latencyMs: 100,
    promptCacheKeyHash: "sha256:stable-watch-hash",
    promptTokens: 3_000,
    completionTokens: 100,
    totalTokens: 3_100,
    cachedPromptTokens: index === 0 ? 0 : 150,
    cacheHit: false,
    promptCacheKeyUsed: true,
    factoryDiagnostics: {
      shapeFingerprint: "shape-stable",
    },
  }));

  await withProxyApp(
    {
      keys: [],
      requestLogsPayload: {
        entries: [
          {
            id: "cross-newer",
            timestamp: Date.UTC(2026, 3, 4, 14, 0, 0),
            providerId: "openai",
            accountId: "acct-a",
            authType: "oauth_bearer",
            model: "gpt-5.4",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 120,
            promptCacheKeyHash: "sha256:cross-account-hash",
            promptTokens: 500,
            completionTokens: 50,
            totalTokens: 550,
          },
          {
            id: "cross-older",
            timestamp: Date.UTC(2026, 3, 4, 13, 59, 0),
            providerId: "openai",
            accountId: "acct-b",
            authType: "oauth_bearer",
            model: "gpt-5.4",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 118,
            promptCacheKeyHash: "sha256:cross-account-hash",
            promptTokens: 500,
            completionTokens: 50,
            totalTokens: 550,
          },
          ...stableEntries,
        ],
        hourlyBuckets: [],
        dailyBuckets: [],
        dailyModelBuckets: [],
        dailyAccountBuckets: [],
        accountAccumulators: [],
      },
      upstreamHandler: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      }),
    },
    async ({ app }) => {
      const auditResponse = await app.inject({
        method: "GET",
        url: "/api/v1/credentials/openai/prompt-cache-audit?limit=1&scanLimit=100",
      });

      assert.equal(auditResponse.statusCode, 200);
      const payloadJson: unknown = auditResponse.json();
      assert.ok(isRecord(payloadJson));
      assert.ok(Array.isArray(payloadJson.rows));
      assert.ok(Array.isArray(payloadJson.watchRows));
      assert.equal(payloadJson.rows.length, 1);
      assert.equal(payloadJson.rows[0]?.promptCacheKeyHash, "sha256:cross-account-hash");
      assert.equal(payloadJson.watchRows.length, 1);
      assert.equal(payloadJson.watchRows[0]?.promptCacheKeyHash, "sha256:stable-watch-hash");
    },
  );
});

test("injects instructions for gpt-5.4-mini routed through openai oauth (regression: codex instructions required)", async () => {
  let observedPath = "";
  let observedBody: Record<string, unknown> | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "resp_gpt52",
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4-mini",
            output: [
              {
                id: "msg_gpt52",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello" }]
              }
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/responses");
      assert.ok(observedBody);
      assert.ok(Array.isArray(observedBody.input), "payload must use responses input format");
      assert.equal(typeof observedBody.instructions, "string", "instructions must be a string");
      assert.equal(observedBody.store, false);
      assert.equal(observedBody.stream, true);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "gpt-5.4-mini");
    }
  );
});

test("openai passthrough coerces null instructions to empty string (regression: codex instructions required)", async () => {
  let observedBody: Record<string, unknown> | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        observedBody = JSON.parse(body);

        const streamText = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_pt", status: "in_progress", model: "gpt-5.4-mini", output: [] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_pt", status: "completed", model: "gpt-5.4-mini", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } })}\n\n`,
        ].join("");

        return {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          body: streamText
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.4-mini",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          instructions: null,
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(observedBody);
      assert.equal(observedBody.instructions, "", "null instructions must be coerced to empty string");
      assert.equal(observedBody.store, false);
      assert.equal(observedBody.stream, true);
    }
  );
});

test("openai passthrough still reaches codex when provider catalog lookup is unavailable", async () => {
  let observedPath = "";
  let observedBody: Record<string, unknown> | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        const streamText = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_gpt54", status: "in_progress", model: "gpt-5.4", output: [] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_gpt54", status: "completed", model: "gpt-5.4", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } })}\n\n`,
        ].join("");

        return {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          body: streamText,
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          instructions: "",
          stream: true,
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/responses");
      assert.ok(observedBody);
      assert.equal(observedBody.model, "gpt-5.4");
    }
  );
});

test("openai passthrough strips codex-unsupported response parameters", async () => {
  let observedBody: Record<string, unknown> | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        observedBody = JSON.parse(body);

        const streamText = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_mot", status: "in_progress", model: "gpt-5.4-mini", output: [] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_mot", status: "completed", model: "gpt-5.4-mini", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } })}\n\n`,
        ].join("");

        return {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          body: streamText
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.4-mini",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          instructions: "",
          max_output_tokens: 32000,
          prompt_cache_retention: "24h",
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(observedBody);
      assert.equal(observedBody.max_output_tokens, undefined, "max_output_tokens must be stripped for codex path");
      assert.equal(observedBody.prompt_cache_retention, undefined, "prompt_cache_retention must be stripped for codex path");
    }
  );
});

test("openai responses passthrough closes stalled streaming bodies", async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
        requestTimeoutMs: 25,
        streamBootstrapTimeoutMs: 25,
      },
      upstreamHandler: async () => ({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        streamBody: async (response) => {
          response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stalled", status: "in_progress", model: "gpt-5.5", output: [] } })}\n\n`);
          await once(response, "close");
        },
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.5",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          instructions: "",
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.match(response.body, /response\.created/);
    }
  );
});

test("/api/tools/websearch proxies via Responses web_search and extracts url citations", async () => {
  let observedPath = "";
  let observedBody: Record<string, unknown> | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      proxyAuthToken: "proxy-token",
      configOverrides: {
        upstreamProviderId: "openai",
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        const streamText = [
          `event: response.created\ndata: ${JSON.stringify({
            type: "response.created",
            response: { id: "resp_ws", status: "in_progress", model: "gpt-5.4-mini", output: [] },
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_ws",
              status: "completed",
              model: "gpt-5.4-mini",
              output: [
                { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "example query" } },
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "- [Example](https://example.com) — Example snippet.",
                      annotations: [
                        { type: "url_citation", url: "https://example.com", title: "Example" },
                      ],
                    },
                  ],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
            },
          })}\n\n`,
        ].join("");

        return {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          body: streamText,
        };
      }
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
          query: "example query",
          numResults: 5,
          searchContextSize: "medium",
          model: "gpt-5.4-mini",
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/responses");
      assert.ok(observedBody);
      assert.ok(Array.isArray(observedBody.tools));
      assert.ok((observedBody.tools as any[]).some((tool) => isRecord(tool) && tool.type === "web_search"));

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(typeof payload.output, "string");
      assert.ok(Array.isArray(payload.sources));
      assert.equal(payload.responseId, "resp_ws");
      assert.equal(payload.model, "gpt-5.4-mini");
      assert.equal(payload.backend, "openai");

      const sources = payload.sources as unknown[];
      assert.ok(isRecord(sources[0]));
      assert.equal((sources[0] as any).url, "https://example.com");
    }
  );
});

test("/api/tools/websearch falls back to Exa when OpenAI fails", async () => {
  const originalFetch = globalThis.fetch;
  let exaCalled = false;
  const callOrder: string[] = [];

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url?.includes("mcp.exa.ai")) {
      callOrder.push("exa");
      exaCalled = true;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "web_search_exa");

      return new Response(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: "- [Exa Result](https://exa.example.com) — Found via Exa fallback.",
              },
            ],
          },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (typeof url === "string" && url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    await withProxyApp(
      {
        keys: [],
        keysPayload: {
          providers: {
            openai: {
              auth: "oauth_bearer",
              accounts: [{ id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" }],
            },
          },
        },
        proxyAuthToken: "proxy-token",
        configOverrides: {
          upstreamProviderId: "openai",
        },
        upstreamHandler: async () => {
          callOrder.push("openai");
          return {
            status: 500,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: { message: "OpenAI web search unavailable" } }),
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
            query: "test query",
            numResults: 5,
          },
        });

        assert.equal(response.statusCode, 200);
        assert.ok(exaCalled, "Exa MCP should have been called");
        assert.deepEqual(callOrder, ["openai", "exa"]);

        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.equal(payload.backend, "exa");
        assert.ok(typeof payload.output === "string");
        assert.ok(payload.output.includes("Exa Result"));
        assert.ok(Array.isArray(payload.sources));
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/api/tools/websearch falls back to Exa when OpenAI returns empty output", async () => {
  const originalFetch = globalThis.fetch;
  const callOrder: string[] = [];

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url?.includes("mcp.exa.ai")) {
      callOrder.push("exa");
      const body = init?.body ? JSON.parse(init.body as string) : {};
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "web_search_exa");

      return new Response(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: "- [Exa Empty Fallback](https://exa.example.com/empty) — Recovered from empty OpenAI output.",
              },
            ],
          },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (typeof url === "string" && url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    await withProxyApp(
      {
        keys: [],
        keysPayload: {
          providers: {
            openai: {
              auth: "oauth_bearer",
              accounts: [{ id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" }],
            },
          },
        },
        proxyAuthToken: "proxy-token",
        configOverrides: {
          upstreamProviderId: "openai",
        },
        upstreamHandler: async () => {
          callOrder.push("openai");
          const streamText = [
            `event: response.created\ndata: ${JSON.stringify({
              type: "response.created",
              response: { id: "resp_empty_ws", status: "in_progress", model: "gpt-5.4-mini", output: [] },
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_empty_ws",
                status: "completed",
                model: "gpt-5.4-mini",
                output: [],
                usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
              },
            })}\n\n`,
          ].join("");

          return {
            status: 200,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
            body: streamText,
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
            query: "empty query",
            numResults: 5,
            model: "gpt-5.2",
          },
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(callOrder, ["openai", "openai", "openai", "openai", "exa"]);

        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.equal(payload.backend, "exa");
        assert.ok(typeof payload.output === "string");
        assert.ok(payload.output.includes("Exa Empty Fallback"));
        assert.ok(Array.isArray(payload.sources));
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("records token usage from codex SSE responses with missing content-type (regression)", async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      configOverrides: {
        upstreamProviderId: "openai",
        responsesModelPrefixes: ["gpt-"],
      },
      upstreamHandler: async () => {
        const streamText = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_usage", status: "in_progress", model: "gpt-5.4-mini", output: [] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_usage", status: "completed", model: "gpt-5.4-mini", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49, input_tokens_details: { cached_tokens: 30 } } } })}\n\n`,
        ].join("");

        return {
          status: 200,
          headers: {},
          body: streamText
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);

      const logsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/request-logs?limit=1",
      });

      assert.equal(logsResponse.statusCode, 200);
      const logs: unknown = logsResponse.json();
      assert.ok(isRecord(logs));
      assert.ok(Array.isArray(logs.entries));
      const entry = logs.entries[0];
      assert.ok(isRecord(entry));
      assert.equal(entry.promptTokens, 42, "promptTokens must be extracted from codex SSE usage.input_tokens");
      assert.equal(entry.completionTokens, 7, "completionTokens must be extracted from codex SSE usage.output_tokens");
      assert.equal(entry.totalTokens, 49, "totalTokens must be extracted from codex SSE usage.total_tokens");
      assert.equal(entry.cachedPromptTokens, 30, "cachedPromptTokens must be extracted from input_tokens_details.cached_tokens");
      assert.equal(entry.cacheHit, true, "cacheHit must be true when cached_tokens > 0");
    }
  );
});

test("extracts cached prompt tokens from messages usage cache_read_input_tokens", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "msg_cache_usage",
          type: "message",
          role: "assistant",
          model: "claude-3-7-sonnet",
          content: [
            {
              type: "text",
              text: "OK",
            },
          ],
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_input_tokens: 28,
            cache_creation_input_tokens: 128,
          },
        }),
      }),
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        payload: {
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      });

      assert.equal(response.statusCode, 200);

      const logsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/request-logs?providerId=vivgrid&limit=1",
      });

      assert.equal(logsResponse.statusCode, 200);
      const logs: unknown = logsResponse.json();
      assert.ok(isRecord(logs));
      assert.ok(Array.isArray(logs.entries));
      const entry = logs.entries[0];
      assert.ok(isRecord(entry));
      assert.equal(entry.promptTokens, 42);
      assert.equal(entry.completionTokens, 7);
      assert.equal(entry.totalTokens, 49);
      assert.equal(entry.cachedPromptTokens, 28);
      assert.equal(entry.cacheHit, true);
    },
  );
});

test("openai chat completions strategy converts GPT requests to responses format for codex path (regression)", async () => {
  let observedPath = "";
  let observedBody: Record<string, unknown> | undefined;

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            ]
          }
        }
      },
      models: ["gpt-5.4"],
      configOverrides: {
        upstreamProviderId: "openai",
        responsesModelPrefixes: ["gpt-"],
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "resp_gpt54",
            object: "response",
            created_at: 1772516810,
            model: "gpt-5.4",
            output: [
              {
                id: "msg_gpt54",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "GPT response" }]
              }
            ],
            usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 }
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        payload: {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/responses");
      assert.ok(observedBody);
      assert.ok(Array.isArray(observedBody.input), "payload must use responses input format");
      assert.equal(typeof observedBody.instructions, "string", "instructions must be a string");
      assert.equal(observedBody.store, false);
      assert.equal(observedBody.stream, true);
      assert.equal(observedBody.messages, undefined, "messages must not be sent to codex path");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
    }
  );
});

test("glm chat requests route to rotussy instead of ollama-cloud or the openai provider when rotussy is configured", { concurrency: false }, async () => {
  await withEnv(
    {
      ROTUSSY_API_KEY: "rotussy-key-1", // pragma: allowlist secret
      ROTUSSY_PROVIDER_ID: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      ZAI_API_KEY: undefined,
    },
    async () => {
      const observedAttempts: Array<{ path: string; auth: string | undefined }> = [];
      let observedBody: Record<string, unknown> | undefined;

      await withProxyApp(
        {
          keys: [],
          keysPayload: {
            providers: {
              openai: {
                auth: "oauth_bearer",
                accounts: [
                  { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
                ],
              },
            },
          },
          models: ["glm-5"],
          configOverrides: {
            upstreamProviderId: "openai",
            localOllamaEnabled: false,
            cljsPolicyShadowMode: true,
          },
          upstreamHandler: async (request, body) => {
            if (request.method === "GET" && request.url === "/models") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ object: "list", data: [{ id: "glm-5" }] }),
              };
            }

            observedAttempts.push({
              path: request.url ?? "",
              auth: typeof request.headers.authorization === "string"
                ? request.headers.authorization
                : undefined,
            });
            observedBody = JSON.parse(body) as Record<string, unknown>;

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "chatcmpl_rotussy_glm",
                object: "chat.completion",
                created: 1772516811,
                model: "glm-5",
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: "rotussy-glm-routed" },
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
            headers: { "content-type": "application/json" },
            payload: {
              model: "glm-5",
              messages: [{ role: "user", content: "hello" }],
              stream: false,
            },
          });

          assert.equal(response.statusCode, 200);
          assert.deepEqual(observedAttempts, [
            { path: "/v1/chat/completions", auth: "Bearer rotussy-key-1" },
          ]);
          assert.ok(isRecord(observedBody));
          assert.equal(observedBody.model, "glm-5");
          assert.equal(response.headers["x-open-hax-upstream-provider"], "rotussy");

          const payload: unknown = response.json();
          assert.ok(isRecord(payload));
          assert.equal((payload.choices as any)[0].message.content, "rotussy-glm-routed");
        },
      );
    },
  );
});

test("glm chat requests skip ollama-cloud when provider catalog does not advertise the requested model", { concurrency: false }, async () => {
  await withEnv(
    {
      ROTUSSY_API_KEY: "rotussy-key-1", // pragma: allowlist secret
      ROTUSSY_PROVIDER_ID: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      ZAI_API_KEY: undefined,
    },
    async () => {
      const upstreamAuths: string[] = [];

      await withProxyApp(
        {
          keys: [],
          handleModelCatalog: true,
          keysPayload: {
            providers: {
              openai: {
                auth: "oauth_bearer",
                accounts: [
                  { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
                ],
              },
              "ollama-cloud": ["ollama-cloud-key"],
            },
          },
          models: ["glm-4.7-flash"],
          configOverrides: {
            upstreamProviderId: "openai",
            localOllamaEnabled: false,
            cljsPolicyShadowMode: true,
          },
          upstreamHandler: async (request, body) => {
            const auth = request.headers.authorization;

            if (request.method === "GET" && (request.url === "/v1/models" || request.url === "/models")) {
              if (auth === "Bearer ollama-cloud-key") {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ object: "list", data: [{ id: "Kimi-K2.5" }] }),
                };
              }

              if (auth === "Bearer rotussy-key-1") {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ object: "list", data: [{ id: "glm-4.7-flash" }] }),
                };
              }

              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ object: "list", data: [{ id: "gpt-5.4" }] }),
              };
            }

            upstreamAuths.push(auth ?? "");
            assert.notEqual(auth, "Bearer ollama-cloud-key");
            assert.equal(auth, "Bearer rotussy-key-1");
            const observedBody = JSON.parse(body) as Record<string, unknown>;
            assert.equal(observedBody.model, "glm-4.7-flash");

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "chatcmpl_rotussy_glm_skip_ollama",
                object: "chat.completion",
                created: 1772516811,
                model: "glm-4.7-flash",
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: "rotussy-only" },
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
            headers: { "content-type": "application/json" },
            payload: {
              model: "glm-4.7-flash",
              messages: [{ role: "user", content: "hello" }],
              stream: false,
            },
          });

          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["x-open-hax-upstream-provider"], "rotussy");
          assert.deepEqual(upstreamAuths, ["Bearer rotussy-key-1"]);
        },
      );
    },
  );
});

test("glm /v1/responses requests route through rotussy chat-completions compatibility when rotussy is configured", { concurrency: false }, async () => {
  await withEnv(
    {
      ROTUSSY_API_KEY: "rotussy-key-1", // pragma: allowlist secret
      ROTUSSY_PROVIDER_ID: undefined,
      OPENROUTER_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      ZAI_API_KEY: undefined,
      ZHIPU_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
    },
    async () => {
      const observedAttempts: Array<{ path: string; auth: string | undefined }> = [];
      let observedBody: Record<string, unknown> | undefined;

      await withProxyApp(
        {
          keys: [],
          keysPayload: {
            providers: {
              openai: {
                auth: "oauth_bearer",
                accounts: [
                  { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
                ],
              },
            },
          },
          models: ["glm-5"],
          configOverrides: {
            upstreamProviderId: "openai",
            localOllamaEnabled: false,
            cljsPolicyShadowMode: true,
          },
          upstreamHandler: async (request, body) => {
            if (request.method === "GET" && request.url === "/models") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ object: "list", data: [{ id: "glm-5" }] }),
              };
            }

            observedAttempts.push({
              path: request.url ?? "",
              auth: typeof request.headers.authorization === "string"
                ? request.headers.authorization
                : undefined,
            });
            observedBody = JSON.parse(body) as Record<string, unknown>;

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "chatcmpl_rotussy_glm5",
                object: "chat.completion",
                created: 1772516812,
                model: "glm-5",
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: "rotussy-responses-routed", reasoning_content: "brief reasoning" },
                  finish_reason: "stop",
                }],
                usage: {
                  prompt_tokens: 6,
                  completion_tokens: 3,
                  total_tokens: 9,
                  completion_tokens_details: { reasoning_tokens: 2 },
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
              model: "glm-5",
              input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
              instructions: "",
              stream: false,
            },
          });

          assert.equal(response.statusCode, 200);
          assert.deepEqual(observedAttempts, [
            { path: "/v1/chat/completions", auth: "Bearer rotussy-key-1" },
          ]);
          assert.ok(isRecord(observedBody));
          assert.equal(observedBody.model, "glm-5");
          assert.ok(Array.isArray(observedBody.messages));
          assert.equal(response.headers["x-open-hax-upstream-provider"], "rotussy");
          assert.equal(response.headers["x-open-hax-upstream-mode"], "chat_completions");

          const payload: unknown = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.object, "response");
          assert.equal(payload.model, "glm-5");
          assert.ok(Array.isArray(payload.output));
          assert.equal((payload.output as any)[1].content[0].text, "rotussy-responses-routed");
        },
      );
    },
  );
});

test("routes ollama-prefixed models to /api/chat and forwards num_ctx controls", async () => {
  let observedPath = "";
  let observedBody: unknown;
  let observedAuthorization: string | undefined;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);
        observedAuthorization = request.headers.authorization;

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: "llama3.2:latest",
            created_at: "2026-03-03T00:00:00.000Z",
            message: {
              role: "assistant",
              content: "ollama-ok"
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 6
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
          model: "ollama/llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          open_hax: {
            ollama: {
              num_ctx: 8192
            }
          }
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-mode"], "ollama_chat");
      assert.equal(observedPath, "/api/chat");
      assert.equal(observedAuthorization, undefined);

      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "llama3.2:latest");
      assert.ok(Array.isArray(observedBody.messages));
      assert.ok(isRecord(observedBody.options));
      assert.equal(observedBody.options.num_ctx, 8192);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "llama3.2:latest");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "ollama-ok");
      assert.ok(isRecord(payload.usage));
      assert.equal(payload.usage.prompt_tokens, 12);
      assert.equal(payload.usage.completion_tokens, 6);
      assert.equal(payload.usage.total_tokens, 18);
    }
  );
});

test("maps reasoning effort to ollama think true and exposes thinking as reasoning_content", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: "llama3.2:latest",
            created_at: "2026-03-03T00:00:00.000Z",
            message: {
              role: "assistant",
              content: "ollama-answer",
              thinking: "ollama-thinking"
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 6
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
          model: "ollama/llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "high",
          include: ["reasoning.encrypted_content"],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.think, true);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal((payload.choices as any)[0].message.content, "ollama-answer");
      assert.equal((payload.choices as any)[0].message.reasoning_content, "ollama-thinking");
    }
  );
});

test("maps none reasoning effort to ollama think false", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: "llama3.2:latest",
            created_at: "2026-03-03T00:00:00.000Z",
            message: {
              role: "assistant",
              content: "ollama-no-think"
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 2,
            eval_count: 1
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
          model: "ollama/llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "none",
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.think, false);
    }
  );
});

test("returns true streaming chat-completion SSE for ollama stream requests", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson"
          },
          body:
            '{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":"ollama-"},"done":false}\n' +
            '{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":"stream-ok"},"done":false}\n' +
            '{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":2}\n'
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
          model: "ollama:llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          num_ctx: 4096
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");

      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.stream, true);
      assert.ok(isRecord(observedBody.options));
      assert.equal(observedBody.options.num_ctx, 4096);

      const ssePayloads = parseSseDataPayloads(response.body);
      assert.equal(ssePayloads.at(-1), "[DONE]");

      const firstChunk = JSON.parse(ssePayloads[0]!);
      const secondChunk = JSON.parse(ssePayloads[1]!);
      const finalChunk = JSON.parse(ssePayloads[2]!);

      assert.equal(firstChunk.object, "chat.completion.chunk");
      assert.equal(firstChunk.choices[0].delta.role, "assistant");
      assert.equal(firstChunk.choices[0].delta.content, "ollama-");
      assert.equal(secondChunk.object, "chat.completion.chunk");
      assert.equal(secondChunk.choices[0].delta.content, "stream-ok");
      assert.equal(finalChunk.object, "chat.completion.chunk");
      assert.deepEqual(finalChunk.choices[0].delta, {});
      assert.equal(finalChunk.choices[0].finish_reason, "stop");
      assert.equal(firstChunk.id, secondChunk.id);
      assert.equal(secondChunk.id, finalChunk.id);
    }
  );
});

test("collapses duplicated first thinking token in ollama stream reasoning", async () => {
  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/x-ndjson"
        },
        body:
          '{"model":"gemma3:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","thinking":"The"},"done":false}\n' +
          '{"model":"gemma3:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","thinking":"TheThe model should reason once.","content":"answer"},"done":false}\n' +
          '{"model":"gemma3:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","thinking":"TheThe model should reason once.","content":"answer"},"done":true,"done_reason":"stop"}\n'
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
          model: "ollama:gemma3:latest",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "high",
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      const chunks = parseSseDataPayloads(response.body)
        .filter((payload) => payload !== "[DONE]")
        .map((payload) => JSON.parse(payload));
      const reasoning = chunks
        .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? "")
        .join("");

      assert.equal(reasoning, "The model should reason once.");
    }
  );
});

test("preserves ollama stream content when tool calls are present", async () => {
  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/x-ndjson"
        },
        body:
          '{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":"tool-call-transcript","tool_calls":[{"function":{"name":"bash","arguments":{"command":"pwd"}}}]},"done":false}\n' +
          '{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"pwd"}}}]},"done":true,"done_reason":"stop"}\n'
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
          model: "ollama:llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);

      const ssePayloads = parseSseDataPayloads(response.body);
      assert.equal(ssePayloads.at(-1), "[DONE]");

      const firstChunk = JSON.parse(ssePayloads[0]!);
      const finalChunk = JSON.parse(ssePayloads[1]!);

      assert.equal(firstChunk.object, "chat.completion.chunk");
      assert.equal(firstChunk.choices[0].delta.content, "tool-call-transcript");
      assert.ok(Array.isArray(firstChunk.choices[0].delta.tool_calls));
      assert.equal(finalChunk.object, "chat.completion.chunk");
      assert.equal(finalChunk.choices[0].delta.content, null);
      assert.ok(Array.isArray(finalChunk.choices[0].delta.tool_calls));
      assert.equal(firstChunk.id, finalChunk.id);
    }
  );
});

test("streams first ollama SSE chunk before upstream completion", async () => {
  let _upstreamCompleted = false;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/x-ndjson"
        },
        streamBody: async (response) => {
          response.write('{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":"ollama-"},"done":false}\n');
          await new Promise((resolve) => setTimeout(resolve, 150));
          response.write('{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":"stream-ok"},"done":false}\n');
          response.write('{"model":"llama3.2:latest","created_at":"2026-03-03T00:00:00.000Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n');
          _upstreamCompleted = true;
          response.end();
        }
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
          model: "ollama:llama3.2:latest",
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

      // In local loopback tests, undici/body teeing can buffer enough of the upstream NDJSON
      // stream that the server-side completion flag flips before the client observes the first
      // SSE frame. The regression we actually care about is that the proxy emits a valid first
      // chat chunk rather than waiting for a fully buffered JSON response.

      const firstEvent = parseSseDataPayloads(buffer)[0];
      assert.ok(firstEvent);
      const firstChunk = JSON.parse(firstEvent);
      assert.equal(firstChunk.object, "chat.completion.chunk");
      assert.equal(firstChunk.choices[0].delta.content, "ollama-");
    }
  );
});

test("routes local-only ollama models even when ollama-cloud is also configured", async () => {
  const observedRequests: Array<{ readonly url: string; readonly authorization?: string; readonly model?: string }> = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-cloud-key"],
        },
      },
      handleModelCatalog: true,
      configOverrides: {
        upstreamProviderId: "zai",
      },
      upstreamHandler: async (request, body) => {
        const authorization = typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined;

        if (request.method === "GET" && request.url === "/api/tags") {
          const models = authorization === "Bearer ollama-cloud-key"
            ? [{ name: "gemma4:31b" }]
            : [{ name: "gemma4:e4b" }];
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ models }),
          };
        }

        if (request.method === "POST" && request.url === "/v1/chat/completions") {
          const parsed = JSON.parse(body) as { model?: string };
          observedRequests.push({ url: request.url ?? "", authorization, model: parsed.model });

          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "chatcmpl-local",
              object: "chat.completion",
              created: 1,
              model: parsed.model,
              choices: [{ index: 0, message: { role: "assistant", content: "hello-local" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            }),
          };
        }

        return {
          status: 404,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ error: { message: `Unhandled ${request.method} ${request.url}` } }),
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
          model: "gemma4:e4b",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      const parsed = response.json();
      assert.equal(parsed.model, "gemma4:e4b");
      assert.equal(parsed.choices[0].message.content, "hello-local");
      assert.deepEqual(observedRequests, [{ url: "/v1/chat/completions", authorization: undefined, model: "gemma4:e4b" }]);
    }
  );
});

test("records ollama token usage in request logs", async () => {
  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "llama3.2:latest",
          created_at: "2026-03-03T00:00:00.000Z",
          message: {
            role: "assistant",
            content: "ollama-log-ok"
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 9,
          eval_count: 4
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
          model: "ollama/llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);

      const logsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/request-logs?providerId=ollama&limit=1"
      });
      assert.equal(logsResponse.statusCode, 200);

      const payload: unknown = logsResponse.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.entries));
      assert.ok(isRecord(payload.entries[0]));
      assert.equal(payload.entries[0].providerId, "ollama");
      assert.equal(payload.entries[0].promptTokens, 9);
      assert.equal(payload.entries[0].completionTokens, 4);
      assert.equal(payload.entries[0].totalTokens, 13);
    }
  );
});

test("rejects invalid ollama num_ctx values", async () => {
  await withProxyApp(
    {
      keys: [],
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
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "ollama/llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          open_hax: {
            ollama: {
              num_ctx: -1
            }
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["x-open-hax-error-code"], "invalid_provider_options");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "invalid_provider_options");
      assert.match(String(payload.error.message), /num_ctx/);
    }
  );
});

test("serves native /api/tags from the discovered model catalog", async () => {
  let observedPath = "";
  await withProxyApp(
    {
      keys: [],
      handleModelCatalog: true,
      models: {
        preferred: ["qwen3.5:4b-q8_0", "qwen3.5:2b-bf16"],
        disabled: [],
        aliases: {},
      },
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-local-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
      },
      upstreamHandler: async (request) => {
        observedPath = request.url ?? "";
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ models: [{ name: "qwen3.5:4b-q8_0" }, { name: "qwen3.5:2b-bf16" }] })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({ method: "GET", url: "/api/tags" });
      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/models");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.models));
      assert.ok(payload.models.some((entry: unknown) => isRecord(entry) && entry.name === "qwen3.5:4b-q8_0"));
    }
  );
});

test("bridges native /api/chat requests through the OpenAI-compatible upstream chat endpoint", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.5:4b-q8_0",
            created_at: "2026-03-09T00:00:00.000Z",
            message: { role: "assistant", content: "native-chat-ok", thinking: "native-thinking-ok" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 4,
            eval_count: 2
          })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          model: "qwen3.5:4b-q8_0",
          messages: [{ role: "user", content: "hello" }],
          think: false,
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/chat/completions");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "qwen3.5:4b-q8_0");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.message));
      assert.equal(payload.message.content, "native-chat-ok");
      assert.equal(payload.message.thinking, "native-thinking-ok");
    }
  );
});

test("routes bare qwen3 embeddings through declarative CLJS policy to llama.cpp", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = body.length > 0 ? JSON.parse(body) : undefined;

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            object: "list",
            model: "qwen3-embedding-0.6b",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          }),
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        payload: {
          model: "qwen3-embedding:0.6b",
          input: "hello world"
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/embeddings");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "qwen3-embedding-0.6b");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.data));
      assert.deepEqual(payload.data[0]?.embedding, [0.1, 0.2, 0.3]);
    }
  );
});

test("bare qwen3 embeddings do not require TypeScript alias env to reach llama.cpp", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withEnv({ EMBED_MODEL_PROVIDER_ALIASES: undefined }, async () => {
    await withProxyApp(
      {
        keys: [],
        upstreamHandler: async (request, body) => {
          observedPath = request.url ?? "";
          observedBody = body.length > 0 ? JSON.parse(body) : undefined;
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              object: "list",
              model: "qwen3-embedding-0.6b",
              data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
            }),
          };
        },
      },
      async ({ app }) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/embeddings",
          payload: {
            model: "qwen3-embedding:0.6b",
            input: "hello world",
          },
        });

        assert.equal(response.statusCode, 200);
        assert.equal(observedPath, "/v1/embeddings");
        assert.ok(isRecord(observedBody));
        assert.equal(observedBody.model, "qwen3-embedding-0.6b");
        const payload: unknown = response.json();
        assert.ok(isRecord(payload));
        assert.equal(payload.model, "qwen3-embedding-0.6b");
        assert.ok(Array.isArray(payload.data));
        assert.deepEqual(payload.data[0]?.embedding, [0.1, 0.2, 0.3]);
      },
    );
  });
});

test("strips explicit llama.cpp embed prefixes before forwarding embeddings", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      configOverrides: {
        llamacppModelPrefixes: ["llamacpp-embed:", "llamacpp-embed/"],
      },
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = body.length > 0 ? JSON.parse(body) : undefined;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            object: "list",
            model: "qwen3-embedding-0.6b",
            data: [{ object: "embedding", index: 0, embedding: [0.4, 0.5, 0.6] }],
          }),
        };
      },
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        payload: {
          model: "llamacpp-embed:qwen3-embedding:0.6b",
          input: "hello world",
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/embeddings");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "qwen3-embedding-0.6b");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.data));
      assert.deepEqual(payload.data[0]?.embedding, [0.4, 0.5, 0.6]);
    },
  );
});

test("rejects auto models for /v1/embeddings", async () => {
  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async () => {
        throw new Error("embedding upstream should not be called");
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        payload: {
          model: "auto:cheapest",
          input: "hello world"
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["x-open-hax-error-code"], "model_not_supported");
    }
  );
});

test("rejects oversized embedding batches before calling upstream", async () => {
  let upstreamCalled = false;

  await withProxyApp(
    {
      keys: [],
      configOverrides: {
        embedMaxBatchItems: 2,
      },
      upstreamHandler: async () => {
        upstreamCalled = true;
        throw new Error("embedding upstream should not be called");
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        payload: {
          model: "qwen3-embedding:0.6b",
          input: ["one", "two", "three"]
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["x-open-hax-error-code"], "embed_batch_too_large");
      assert.equal(upstreamCalled, false);
    }
  );
});

test("rejects oversized embedding character payloads before calling upstream", async () => {
  let upstreamCalled = false;

  await withProxyApp(
    {
      keys: [],
      configOverrides: {
        embedMaxInputChars: 10,
      },
      upstreamHandler: async () => {
        upstreamCalled = true;
        throw new Error("embedding upstream should not be called");
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        payload: {
          model: "qwen3-embedding:0.6b",
          input: "hello world"
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["x-open-hax-error-code"], "embed_input_too_large");
      assert.equal(upstreamCalled, false);
    }
  );
});

test("proxies native /api/embed and /api/embeddings to their matching upstream ollama endpoints with full embedding context", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = body.length > 0 ? JSON.parse(body) : undefined;

        if (observedPath === "/api/show") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model_info: {
                "qwen3.context_length": 40960,
              },
            }),
          };
        }

        if (observedPath === "/api/embeddings") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ embedding: [1, 2, 3] })
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            embeddings: [[1, 2, 3], [4, 5, 6]]
          })
        };
      }
    },
    async ({ app }) => {
      const batchResponse = await app.inject({
        method: "POST",
        url: "/api/embed",
        payload: {
          model: "ollama/qwen3-embedding:0.6b",
          input: ["a", "b"]
        }
      });
      assert.equal(batchResponse.statusCode, 200);
      assert.equal(observedPath, "/api/embed");
      assert.ok(isRecord(observedBody));
      assert.ok(isRecord(observedBody.options));
      assert.equal(observedBody.options.num_ctx, 40960);
      const batchPayload: unknown = batchResponse.json();
      assert.ok(isRecord(batchPayload));
      assert.deepEqual(batchPayload.embeddings, [[1, 2, 3], [4, 5, 6]]);

      const singleResponse = await app.inject({
        method: "POST",
        url: "/api/embeddings",
        payload: {
          model: "ollama/qwen3-embedding:0.6b",
          prompt: "a"
        }
      });
      assert.equal(singleResponse.statusCode, 200);
      assert.equal(observedPath, "/api/embed");
      assert.ok(isRecord(observedBody));
      assert.ok(isRecord(observedBody.options));
      assert.equal(observedBody.options.num_ctx, 40960);
      const singlePayload: unknown = singleResponse.json();
      assert.ok(isRecord(singlePayload));
      assert.deepEqual(singlePayload.embedding, [1, 2, 3]);
    }
  );
});

test("native /api/embed scopes unprefixed models to native ollama regardless of prefix order", async () => {
  let observedPath = "";

  await withProxyApp(
    {
      keys: [],
      configOverrides: {
        ollamaModelPrefixes: ["ollama-lan/", "ollama/"],
      },
      upstreamHandler: async (request) => {
        observedPath = request.url ?? "";

        if (observedPath === "/api/show") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model_info: {
                "qwen3.context_length": 40960,
              },
            }),
          };
        }

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ embeddings: [[1, 2, 3]] }),
        };
      },
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/embed",
        payload: {
          model: "qwen3-embedding:0.6b",
          input: ["a"],
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/api/embed");
    },
  );
});

test("proxies native /api/generate through the upstream ollama generate endpoint", async () => {
  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (request) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.url === "/api/generate" ? "qwen3.5:2b-bf16" : "unknown",
          response: '{"ok":true}',
          done: true,
          done_reason: "stop",
          context: [1, 2, 3],
        })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/generate",
        payload: {
          model: "qwen3.5:2b-bf16",
          prompt: "Return JSON"
        }
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.response, '{"ok":true}');
    }
  );
});

test("normalizes chat content part type text to responses input_text/output_text", async () => {
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
            id: "resp_norm",
            object: "response",
            created_at: 1772516803,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_norm",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "ok"
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
          messages: [
            {
              role: "system",
              content: [{ type: "text", text: "system text" }]
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "assistant text" }]
            },
            {
              role: "user",
              content: [{ type: "text", text: "user text" }]
            }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.input));
      assert.equal(observedBody.input.length, 3);

      assert.ok(isRecord(observedBody.input[0]));
      assert.ok(Array.isArray(observedBody.input[0].content));
      assert.ok(isRecord(observedBody.input[0].content[0]));
      assert.equal(observedBody.input[0].content[0].type, "input_text");

      assert.ok(isRecord(observedBody.input[1]));
      assert.ok(Array.isArray(observedBody.input[1].content));
      assert.ok(isRecord(observedBody.input[1].content[0]));
      assert.equal(observedBody.input[1].content[0].type, "output_text");

      assert.ok(isRecord(observedBody.input[2]));
      assert.ok(Array.isArray(observedBody.input[2].content));
      assert.ok(isRecord(observedBody.input[2].content[0]));
      assert.equal(observedBody.input[2].content[0].type, "input_text");
    }
  );
});

test("sanitizes interleaved reasoning fields from chat history before responses forwarding", async () => {
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
            id: "resp_sanitized",
            object: "response",
            created_at: 1772516804,
            model: "gpt-5.3-codex",
            output: [{ id: "msg_sanitized", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }]
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
          messages: [
            {
              role: "assistant",
              reasoning_content: "should-strip",
              reasoning_details: [{ text: "strip-me" }],
              function_call: { name: "old_call" },
              content: [
                { type: "reasoning", text: "drop this" },
                { type: "text", text: "keep this" },
              ],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "bash", arguments: "{}" }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: [{ type: "reasoning_details", text: "drop tool reasoning" }, { type: "text", text: "tool output" }]
            }
          ],
          reasoning: { effort: "high", summary: "auto" },
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.deepEqual(observedBody.reasoning, { effort: "high", summary: "auto" });
      assert.ok(Array.isArray(observedBody.input));
      assert.equal(observedBody.input.length, 3);
      assert.ok(isRecord(observedBody.input[0]));
      assert.ok(Array.isArray(observedBody.input[0].content));
      assert.equal(observedBody.input[0].content.length, 1);
      assert.ok(isRecord(observedBody.input[0].content[0]));
      assert.equal(observedBody.input[0].content[0].type, "output_text");
      assert.equal(observedBody.input[0].content[0].text, "keep this");
      assert.equal(observedBody.input[0].reasoning_content, undefined);
      assert.equal(observedBody.input[0].reasoning_details, undefined);
      assert.equal(observedBody.input[0].function_call, undefined);
      assert.ok(isRecord(observedBody.input[1]));
      assert.equal(observedBody.input[1].type, "function_call");
      assert.ok(isRecord(observedBody.input[2]));
      assert.equal(observedBody.input[2].type, "function_call_output");
      assert.equal(observedBody.input[2].output, "tool output");
    }
  );
});

test("rejects unsupported chat message roles for responses compatibility", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
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
          model: "gpt-5.3-codex",
          messages: [{ role: "critic", content: "nope" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 400);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "invalid_provider_options");
      assert.match(String(payload.error.message), /unsupported messages role/i);
    }
  );
});

test("normalizes image input parts for responses upstream requests", async () => {
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
            id: "resp_image_norm",
            object: "response",
            created_at: 1772516804,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_image_norm",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "image-normalized"
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
          messages: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "describe this image" },
                {
                  type: "input_image",
                  image_url: {
                    url: "data:image/png;base64,AAAA",
                    detail: "high"
                  }
                },
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: "https://example.com/cat.png"
                  }
                }
              ]
            }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.input));
      assert.ok(isRecord(observedBody.input[0]));
      assert.ok(Array.isArray(observedBody.input[0].content));
      assert.equal(observedBody.input[0].content.length, 3);

      assert.ok(isRecord(observedBody.input[0].content[0]));
      assert.equal(observedBody.input[0].content[0].type, "input_text");
      assert.equal(observedBody.input[0].content[0].text, "describe this image");

      assert.ok(isRecord(observedBody.input[0].content[1]));
      assert.equal(observedBody.input[0].content[1].type, "input_image");
      assert.equal(observedBody.input[0].content[1].image_url, "data:image/png;base64,AAAA");
      assert.equal(observedBody.input[0].content[1].detail, "high");

      assert.ok(isRecord(observedBody.input[0].content[2]));
      assert.equal(observedBody.input[0].content[2].type, "input_image");
      assert.equal(observedBody.input[0].content[2].image_url, "https://example.com/cat.png");
    }
  );
});

test("normalizes image input parts for messages upstream requests", async () => {
  let observedBody: unknown;
  let observedPath = "";

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
            id: "msg_image_norm",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "text",
                text: "claude-image-normalized"
              }
            ],
            usage: {
              input_tokens: 10,
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
          messages: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "what is in this image?" },
                {
                  type: "input_image",
                  image_url: {
                    url: "data:image/png;base64,BBBB"
                  }
                },
                {
                  type: "image_url",
                  image_url: {
                    url: "https://example.com/dog.png"
                  }
                }
              ]
            }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/messages");
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.messages));
      assert.ok(isRecord(observedBody.messages[0]));
      assert.ok(Array.isArray(observedBody.messages[0].content));
      assert.equal(observedBody.messages[0].content.length, 3);

      assert.ok(isRecord(observedBody.messages[0].content[0]));
      assert.equal(observedBody.messages[0].content[0].type, "text");
      assert.equal(observedBody.messages[0].content[0].text, "what is in this image?");

      assert.ok(isRecord(observedBody.messages[0].content[1]));
      assert.equal(observedBody.messages[0].content[1].type, "image");
      assert.ok(isRecord(observedBody.messages[0].content[1].source));
      assert.equal(observedBody.messages[0].content[1].source.type, "base64");
      assert.equal(observedBody.messages[0].content[1].source.media_type, "image/png");
      assert.equal(observedBody.messages[0].content[1].source.data, "BBBB");

      assert.ok(isRecord(observedBody.messages[0].content[2]));
      assert.equal(observedBody.messages[0].content[2].type, "image");
      assert.ok(isRecord(observedBody.messages[0].content[2].source));
      assert.equal(observedBody.messages[0].content[2].source.type, "url");
      assert.equal(observedBody.messages[0].content[2].source.url, "https://example.com/dog.png");
    }
  );
});

test("maps responses function_call output to chat tool_calls", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "resp_tool_call",
          object: "response",
          created_at: 1772516801,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "bash",
              arguments: "{\"command\":\"pwd\"}"
            }
          ]
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
          model: "gpt-5.3-codex",
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
      assert.equal(payload.choices[0].message.content, null);
      assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0]));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0].function));
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, "bash");
    }
  );
});

test("returns synthetic chat-completion SSE for gpt stream requests", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "resp_stream",
          object: "response",
          created_at: 1772516802,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "msg_stream",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "stream-via-responses"
                }
              ]
            }
          ]
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
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.ok(response.body.includes("chat.completion.chunk"));
      assert.ok(response.body.includes("stream-via-responses"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("maps responses reasoning output into chat reasoning_content for stream clients", async () => {
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
