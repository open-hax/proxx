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
