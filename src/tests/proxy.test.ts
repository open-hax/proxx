import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";

interface TestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
}

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

async function withProxyApp(
  options: {
    readonly keys: readonly string[];
    readonly keysPayload?: unknown;
    readonly models?: readonly string[];
    readonly proxyAuthToken?: string;
    readonly allowUnauthenticated?: boolean;
    readonly configOverrides?: Partial<ProxyConfig>;
    readonly upstreamHandler: (request: IncomingMessage, body: string) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;
  },
  fn: (ctx: TestContext) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "open-hax-proxy-test-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");
  const requestLogsPath = path.join(tempDir, "request-logs.json");
  const promptAffinityPath = path.join(tempDir, "prompt-affinity.json");
  const settingsPath = path.join(tempDir, "proxy-settings.json");

  const keysPayload = options.keysPayload ?? { keys: options.keys };
  await writeFile(keysPath, JSON.stringify(keysPayload, null, 2), "utf8");
  if (options.models) {
    await writeFile(modelsPath, JSON.stringify({ models: options.models }, null, 2), "utf8");
  }

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
    },
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    openaiProviderId: "openai",
    openaiBaseUrl: `http://127.0.0.1:${address.port}`,
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
    keyReloadMs: 50,
    keyCooldownMs: 10000,
    requestTimeoutMs: 2000,
    streamBootstrapTimeoutMs: 2000,
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
    ...options.configOverrides,
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
            "retry-after": "1"
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
            upstreamFallbackProviderIds: [],
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
            upstreamFallbackProviderIds: [],
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
              "retry-after": "1"
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
          requestLogsJson = await readFile(path.join(tempDir, "request-logs.json"), "utf8");
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
        url: "/api/ui/dashboard/overview",
      });
      assert.equal(overviewResponse.statusCode, 200);
      const overviewPayload: unknown = overviewResponse.json();
      assert.ok(isRecord(overviewPayload));
      assert.ok(isRecord(overviewPayload.summary));
      assert.ok(isRecord(overviewPayload.summary.serviceTierRequests24h));
      assert.equal(overviewPayload.summary.serviceTierRequests24h.fastMode, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.priority, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.standard, 1);
    }
  );

  assert.ok(requestLogsJson.length > 0);
  const parsed: unknown = JSON.parse(requestLogsJson);
  assert.ok(isRecord(parsed));
  assert.ok(Array.isArray(parsed.entries));
  assert.equal(parsed.entries.length, 1);
  assert.ok(isRecord(parsed.entries[0]));
  assert.equal(parsed.entries[0].model, "gpt-5.3-codex");
  assert.equal(parsed.entries[0].serviceTier, undefined);
  assert.equal(parsed.entries[0].serviceTierSource, "none");
  assert.equal(parsed.entries[0].promptTokens, 15);
  assert.equal(parsed.entries[0].completionTokens, 9);
  assert.equal(parsed.entries[0].totalTokens, 24);
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
            primary_window: {
              remaining_percent: 72,
              reset_after_seconds: 1800,
            },
            secondary_window: {
              remaining_percent: 54,
              resets_at: "2030-01-01T00:00:00.000Z",
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
          url: "/api/ui/credentials/openai/quota",
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
        assert.ok(isRecord(payload.accounts[0].weekly));
        assert.equal(payload.accounts[0].weekly.remainingPercent, 54);

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

test("falls back from vivgrid to ollama-cloud for shared models when primary provider auth fails", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: ["vivgrid-failing-key"],
          "ollama-cloud": ["ollama-cloud-working-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
        upstreamFallbackProviderIds: ["ollama-cloud"]
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
      assert.equal(response.headers["x-open-hax-upstream-provider"], "ollama-cloud");
      assert.ok(observedAuth.length >= 2);
      assert.deepEqual(observedAuth.slice(-2), ["vivgrid-failing-key", "ollama-cloud-working-key"]);

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
          "ollama-cloud": ["ollama-missing-a", "ollama-missing-b"],
          vivgrid: ["vivgrid-working-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
        upstreamFallbackProviderIds: ["vivgrid"]
      },
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string" && request.method === "POST") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer ollama-missing-a" || auth === "Bearer ollama-missing-b") {
          return {
            status: 404,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              error: {
                message: "model \"gpt-5.3-codex\" not found"
              }
            })
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.equal(parsedBody.model, "gpt-5.3-codex");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp-model-found-fallback",
            object: "response",
            created_at: 1772516816,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg-model-found-fallback",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "fallback-after-missing-model"
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
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "vivgrid");
      const ollamaAttempts = observedAuth.filter((entry) => entry === "ollama-missing-a" || entry === "ollama-missing-b");
      assert.equal(ollamaAttempts.length, 2);
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

test("tries all primary provider accounts before fallback provider accounts", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: ["vivgrid-bad-a", "vivgrid-bad-b", "vivgrid-bad-c"],
          "ollama-cloud": ["ollama-good"]
        }
      },
      configOverrides: {
        upstreamProviderId: "vivgrid",
        upstreamFallbackProviderIds: ["ollama-cloud"]
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

        if (auth === "Bearer ollama-good") {
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
      assert.equal(response.headers["x-open-hax-upstream-provider"], "ollama-cloud");
      assert.deepEqual(observedAuth, ["vivgrid-bad-a", "vivgrid-bad-b", "vivgrid-bad-c", "ollama-good"]);
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
        upstreamFallbackProviderIds: [],
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
          return {
            status: 429,
            headers: {
              "content-type": "application/json"
            },
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

test("de-prioritizes vivgrid behind codex oauth accounts for gpt routing", async () => {
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
        upstreamFallbackProviderIds: []
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

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        if (parsedBody.model === "nomic-embed-text:latest") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
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
      assert.deepEqual(observedPaths, ["/v1/responses"]);
      assert.deepEqual(observedAuth, ["openai-codex-working"]);

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

test("prefers paid codex oauth accounts for gpt-5.4 over free accounts", async () => {
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
        upstreamFallbackProviderIds: []
      },
      upstreamHandler: async (request, body) => {
        if (request.url === "/api/embed" || request.url === "/api/embeddings") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer openai-free-unsupported") {
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account." })
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        if (parsedBody.model !== "gpt-5.4") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })
          };
        }

        assert.equal(request.headers["chatgpt-account-id"], "cgpt-plus");

        return {
          status: 200,
          headers: { "content-type": "application/json" },
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
      assert.deepEqual(observedAuth, ["openai-plus-working"]);

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

test("prefers free codex oauth accounts for gpt-5.3-codex before paid accounts", async () => {
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
        upstreamFallbackProviderIds: []
      },
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.equal(parsedBody.model, "gpt-5.3-codex");
        assert.equal(request.headers["chatgpt-account-id"], "cgpt-free");

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "resp-free-openai-priority",
            object: "response",
            created_at: 1772916804,
            model: "gpt-5.3-codex",
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
          model: "gpt-5.3-codex",
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
      assert.equal(payload.model, "gpt-5.3-codex");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "free-first-ok");
    }
  );
});

test("refreshes expired openai fallback accounts before gpt-5.4 fallback", async () => {
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
        assert.match(body, /refresh_token=expired-openai-refresh/);
        return new Response(JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: "refreshed-openai-refresh",
          expires_in: 3600,
          chatgpt_plan_type: "plus",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return originalFetch(input, init);
    },
    async () => {
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
                    id: "oa-expired-plus",
                    access_token: "expired-openai-access",
                    refresh_token: "expired-openai-refresh",
                    expires_at: Date.now() - 1000,
                    chatgpt_account_id: "cgpt-stale",
                    plan_type: "plus",
                  },
                ],
              },
            },
          },
          configOverrides: {
            upstreamProviderId: "vivgrid",
            upstreamFallbackProviderIds: [],
          },
          upstreamHandler: async (request, body) => {
            if (request.url === "/api/embed" || request.url === "/api/embeddings") {
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
              };
            }

            const auth = request.headers.authorization;
            if (typeof auth === "string") {
              observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
            }

            assert.equal(auth, `Bearer ${refreshedAccessToken}`);
            assert.equal(request.headers["chatgpt-account-id"], "cgpt-refreshed");

            const parsedBody = JSON.parse(body);
            assert.ok(isRecord(parsedBody));
            assert.equal(parsedBody.model, "gpt-5.4");

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "resp-refreshed-openai-fallback",
                object: "response",
                created_at: 1772916803,
                model: "gpt-5.4",
                output: [
                  {
                    id: "msg-refreshed-openai-fallback",
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "refreshed-openai-account-ok",
                      },
                    ],
                  },
                ],
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: {
              "content-type": "application/json",
            },
            payload: {
              model: "gpt-5.4",
              messages: [{ role: "user", content: "hello" }],
              stream: false,
            },
          });

          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["x-open-hax-upstream-provider"], "openai");
          assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
          assert.equal(refreshCalls, 1);
          assert.deepEqual(observedAuth, [refreshedAccessToken]);

          const payload: unknown = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.object, "chat.completion");
          assert.ok(Array.isArray(payload.choices));
          assert.ok(isRecord(payload.choices[0]));
          assert.ok(isRecord(payload.choices[0].message));
          assert.equal(payload.choices[0].message.content, "refreshed-openai-account-ok");
        },
      );
    },
  );
});

test("refreshes oauth tokens on 401 unauthorized before marking rate-limited", async () => {
  const observedAuth: string[] = [];
  const validAccessToken = makeJwt({
    chatgpt_account_id: "cgpt-refreshed-from-401",
    chatgpt_plan_type: "team",
  });
  let refreshCalls = 0;
  let firstRequest = true;

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
        assert.match(body, /refresh_token=revoked-openai-refresh/);
        return new Response(JSON.stringify({
          access_token: validAccessToken,
          refresh_token: "refreshed-from-401-refresh",
          expires_in: 3600,
          chatgpt_plan_type: "team",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return originalFetch(input, init);
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
                    id: "oa-revoked-team",
                    access_token: "revoked-openai-access",
                    refresh_token: "revoked-openai-refresh",
                    expires_at: Date.now() + 86400000,
                    chatgpt_account_id: "cgpt-revoked",
                    plan_type: "team",
                  },
                ],
              },
            },
          },
          configOverrides: {
            upstreamProviderId: "openai",
            upstreamFallbackProviderIds: [],
          },
          upstreamHandler: async (request, body) => {
            const auth = request.headers.authorization;
            if (typeof auth === "string") {
              observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
            }

            if (firstRequest && auth === "Bearer revoked-openai-access") {
              firstRequest = false;
              return {
                status: 401,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error" } }),
              };
            }

            assert.equal(auth, `Bearer ${validAccessToken}`);
            assert.equal(request.headers["chatgpt-account-id"], "cgpt-refreshed-from-401");

            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "resp-refreshed-after-401",
                object: "response",
                created_at: 1772916803,
                model: "gpt-5.4",
                output: [
                  {
                    id: "msg-refreshed-after-401",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "refreshed-after-401-ok" }],
                  },
                ],
              }),
            };
          },
        },
        async ({ app }) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "gpt-5.4",
              messages: [{ role: "user", content: "test" }],
            }),
          });

          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["x-open-hax-upstream-provider"], "openai");
          assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
          assert.equal(refreshCalls, 1);
          assert.deepEqual(observedAuth, ["revoked-openai-access", validAccessToken]);

          const payload: unknown = response.json();
          assert.ok(isRecord(payload));
          assert.equal(payload.object, "chat.completion");
          assert.ok(Array.isArray(payload.choices));
          assert.ok(isRecord(payload.choices[0]));
          assert.ok(isRecord(payload.choices[0].message));
          assert.equal(payload.choices[0].message.content, "refreshed-after-401-ok");
        },
      );
    },
  );
});

test("falls back from ollama-cloud to vivgrid for shared models when primary provider auth fails", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-cloud-failing-key"],
          vivgrid: ["vivgrid-working-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
        upstreamFallbackProviderIds: ["vivgrid"]
      },
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer ollama-cloud-failing-key") {
          return {
            status: 403,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "forbidden" } })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "chatcmpl-provider-fallback-2",
            object: "chat.completion",
            model: "Kimi-K2.5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "provider-fallback-reverse-ok"
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
          model: "Kimi-K2.5",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "vivgrid");
      assert.ok(observedAuth.length >= 2);
      assert.deepEqual(observedAuth.slice(-2), ["ollama-cloud-failing-key", "vivgrid-working-key"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "provider-fallback-reverse-ok");
    }
  );
});

test("falls back from ollama-cloud to vivgrid when gpt model is missing on ollama", async () => {
  const observedAuth: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-cloud-missing-model-key"],
          vivgrid: ["vivgrid-gpt-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
        upstreamFallbackProviderIds: ["vivgrid"]
      },
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedAuth.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer ollama-cloud-missing-model-key") {
          return {
            status: 404,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              error: {
                message: "model \"gpt-5.3-codex\" not found"
              }
            })
          };
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.equal(parsedBody.model, "gpt-5.3-codex");

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp-gpt-fallback-ok",
            object: "response",
            created_at: 1772516816,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg-gpt-fallback-ok",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "gpt-fallback-ok"
                  }
                ]
              }
            ]
          })
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
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-provider"], "vivgrid");
      assert.ok(observedAuth.length >= 2);
      assert.deepEqual(observedAuth.slice(-2), ["ollama-cloud-missing-model-key", "vivgrid-gpt-key"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "gpt-fallback-ok");
    }
  );
});

test("requires bearer token when proxy auth token is configured", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "proxy-secret",
      allowUnauthenticated: false,
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ id: "chatcmpl-auth", object: "chat.completion", choices: [] })
      })
    },
    async ({ app }) => {
      const unauthorized = await app.inject({
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

      assert.equal(unauthorized.statusCode, 401);
      assert.equal(unauthorized.headers["x-open-hax-error-code"], "unauthorized");

      const unauthorizedPayload: unknown = unauthorized.json();
      assert.ok(isRecord(unauthorizedPayload));
      assert.ok(isRecord(unauthorizedPayload.error));
      assert.equal(unauthorizedPayload.error.code, "unauthorized");

      const authorized = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer proxy-secret",
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(authorized.statusCode, 200);
      assert.equal(authorized.headers["x-open-hax-upstream-mode"], "chat_completions");
    }
  );
});

test("accepts proxy auth token from cookie for browser-served UI and API requests", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      proxyAuthToken: "proxy-secret",
      allowUnauthenticated: false,
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ id: "chatcmpl-cookie-auth", object: "chat.completion", choices: [] })
      })
    },
    async ({ app }) => {
      const authorized = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          cookie: "open_hax_proxy_auth_token=proxy-secret",
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(authorized.statusCode, 200);
      assert.equal(authorized.headers["x-open-hax-upstream-mode"], "chat_completions");
    }
  );
});

test("returns OpenAI-style error for unsupported /v1 endpoints", async () => {
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
        url: "/v1/unknown"
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.headers["x-open-hax-error-code"], "unsupported_endpoint");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "unsupported_endpoint");
      assert.match(String(payload.error.message), /Supported endpoints:/);
    }
  );
});

test("restricts OPTIONS preflight to declared endpoints", async () => {
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
      const known = await app.inject({
        method: "OPTIONS",
        url: "/v1/chat/completions"
      });

      assert.equal(known.statusCode, 204);

      const unknown = await app.inject({
        method: "OPTIONS",
        url: "/v1/unknown"
      });

      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.headers["x-open-hax-error-code"], "unsupported_endpoint");
    }
  );
});

test("returns 429 when every key is rate-limited", async () => {
  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async () => ({
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2"
        },
        body: JSON.stringify({ error: { message: "rate limit" } })
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
          stream: false
        }
      });

      assert.equal(response.statusCode, 429);
      assert.ok(response.headers["retry-after"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "no_available_key");
    }
  );
});

test("does not classify successful payload text as quota exhaustion", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-a") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "chatcmpl-first-key-success",
              object: "chat.completion",
              message: "An outstanding balance sheet can still be healthy.",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "ok-from-first-key"
                  },
                  finish_reason: "stop"
                }
              ]
            })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "chatcmpl-second-key-should-not-run",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "unexpected-second-key"
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
      assert.deepEqual(observedKeys, ["key-a"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.id, "chatcmpl-first-key-success");
    }
  );
});

test("treats 503 + retry-after as upstream server error, not account rate limit", async () => {
  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async () => ({
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "1"
        },
        body: JSON.stringify({ error: { message: "temporary upstream outage" } })
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
          stream: false
        }
      });

      assert.equal(response.statusCode, 502);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "upstream_server_error");
    }
  );
});

test("returns 400 when invalid-request and rate-limit responses are mixed", async () => {
  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (auth === "Bearer key-a") {
          const headers: Record<string, string> = {
            "content-type": "application/json"
          };

          return {
            status: 400,
            headers,
            body: JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "bad_request",
                message: "unsupported request parameter: stream_options"
              }
            })
          };
        }

        const headers: Record<string, string> = {
          "content-type": "application/json",
          "retry-after": "1"
        };

        return {
          status: 429,
          headers,
          body: JSON.stringify({ error: { message: "rate limit" } })
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
          stream: false,
          stream_options: { include_usage: true }
        }
      });

      assert.equal(response.statusCode, 400);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.type, "invalid_request_error");
      assert.equal(payload.error.code, "upstream_rejected_request");
    }
  );
});

test("returns graceful aggregated error when all upstream accounts fail with auth errors", async () => {
  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (auth === "Bearer key-a") {
          return {
            status: 401,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "token invalidated" } })
          };
        }

        return {
          status: 403,
          headers: {
            "content-type": "application/octet-stream"
          },
          body: ""
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

      assert.equal(response.statusCode, 502);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "upstream_unavailable");
    }
  );
});

test("returns graceful invalid-request error when the final upstream candidate rejects the payload", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 400,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "bad_request",
            message: "unsupported request parameter: stream_options"
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
          model: "glm-5",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          stream_options: { include_usage: true }
        }
      });

      assert.equal(response.statusCode, 400);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "upstream_rejected_request");
    }
  );
});

test("treats outstanding_balance responses as rate-limit-like and rotates keys", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-a") {
          return {
            status: 402,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              error: {
                code: "outstanding_balance",
                message: "outstanding_balance"
              }
            })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: "chatcmpl-outstanding-fallback", object: "chat.completion", choices: [] })
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
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(observedKeys, ["key-a", "key-b"]);
    }
  );
});

test("returns 429 when every key has outstanding_balance", async () => {
  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async () => ({
        status: 402,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          error: {
            code: "outstanding_balance",
            message: "outstanding_balance"
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
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 429);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "no_available_key");
      assert.match(String(payload.error.message), /outstanding balances|quota-exhausted/i);
    }
  );
});

test("retries with next key when upstream returns 500", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-a") {
          return {
            status: 500,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "temporary upstream error" } })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: "chatcmpl-500-fallback", object: "chat.completion", choices: [] })
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
      assert.equal(payload.id, "chatcmpl-500-fallback");
      assert.deepEqual(observedKeys, ["key-a", "key-b"]);
    }
  );
});

test("retries transient upstream server errors on the same key before rotating", async () => {
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
          if (keyAAttempts < 3) {
            return {
              status: 503,
              headers: {
                "content-type": "application/json"
              },
              body: JSON.stringify({ error: { message: "temporary upstream outage" } })
            };
          }
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: "chatcmpl-retry-same-key", object: "chat.completion", choices: [] })
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
      assert.equal(payload.id, "chatcmpl-retry-same-key");
      assert.deepEqual(observedKeys, ["key-a", "key-a", "key-a"]);
    }
  );
});

test("applies global fast mode to responses requests through proxy settings", async () => {
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
            id: "resp_fast_mode",
            object: "response",
            created_at: 1772516800,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_fast_mode",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "fast-mode-ok"
                  }
                ]
              }
            ]
          })
        };
      }
    },
    async ({ app }) => {
      const settingsResponse = await app.inject({
        method: "POST",
        url: "/api/ui/settings",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          fastMode: true
        }
      });

      assert.equal(settingsResponse.statusCode, 200);

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
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.service_tier, "priority");
      assert.equal(observedBody.open_hax, undefined);

      const requestLogsPayload = await app.inject({
        method: "GET",
        url: "/api/ui/request-logs?limit=1",
      });
      assert.equal(requestLogsPayload.statusCode, 200);
      const requestLogsBody: unknown = requestLogsPayload.json();
      assert.ok(isRecord(requestLogsBody));
      assert.ok(Array.isArray(requestLogsBody.entries));
      assert.ok(isRecord(requestLogsBody.entries[0]));
      assert.equal(requestLogsBody.entries[0].serviceTier, "priority");
      assert.equal(requestLogsBody.entries[0].serviceTierSource, "fast_mode");

      const overviewResponse = await app.inject({
        method: "GET",
        url: "/api/ui/dashboard/overview",
      });
      assert.equal(overviewResponse.statusCode, 200);
      const overviewPayload: unknown = overviewResponse.json();
      assert.ok(isRecord(overviewPayload));
      assert.ok(isRecord(overviewPayload.summary));
      assert.ok(isRecord(overviewPayload.summary.serviceTierRequests24h));
      assert.equal(overviewPayload.summary.serviceTierRequests24h.fastMode, 1);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.priority, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.standard, 0);
    }
  );
});

test("request-level service tier overrides global fast mode", async () => {
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
            id: "resp_service_tier_override",
            object: "response",
            created_at: 1772516800,
            model: "gpt-5.3-codex",
            output: []
          })
        };
      }
    },
    async ({ app }) => {
      await app.inject({
        method: "POST",
        url: "/api/ui/settings",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          fastMode: true
        }
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          service_tier: "default"
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.service_tier, "default");

      const requestLogsPayload = await app.inject({
        method: "GET",
        url: "/api/ui/request-logs?limit=1",
      });
      assert.equal(requestLogsPayload.statusCode, 200);
      const requestLogsBody: unknown = requestLogsPayload.json();
      assert.ok(isRecord(requestLogsBody));
      assert.ok(Array.isArray(requestLogsBody.entries));
      assert.ok(isRecord(requestLogsBody.entries[0]));
      assert.equal(requestLogsBody.entries[0].serviceTier, "default");
      assert.equal(requestLogsBody.entries[0].serviceTierSource, "explicit");

      const overviewResponse = await app.inject({
        method: "GET",
        url: "/api/ui/dashboard/overview",
      });
      assert.equal(overviewResponse.statusCode, 200);
      const overviewPayload: unknown = overviewResponse.json();
      assert.ok(isRecord(overviewPayload));
      assert.ok(isRecord(overviewPayload.summary));
      assert.ok(isRecord(overviewPayload.summary.serviceTierRequests24h));
      assert.equal(overviewPayload.summary.serviceTierRequests24h.fastMode, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.priority, 0);
      assert.equal(overviewPayload.summary.serviceTierRequests24h.standard, 1);
    }
  );
});

test("does not tag non-responses requests with a service tier", async () => {
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
            id: "chatcmpl_non_responses_tier",
            object: "chat.completion",
            created: 1772516801,
            model: "claude-3-7-sonnet",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "ok"
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
          "content-type": "application/json",
          "x-open-hax-fast-mode": "true"
        },
        payload: {
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.service_tier, undefined);

      const requestLogsPayload = await app.inject({
        method: "GET",
        url: "/api/ui/request-logs?limit=1",
      });
      assert.equal(requestLogsPayload.statusCode, 200);
      const requestLogsBody: unknown = requestLogsPayload.json();
      assert.ok(isRecord(requestLogsBody));
      assert.ok(Array.isArray(requestLogsBody.entries));
      assert.ok(isRecord(requestLogsBody.entries[0]));
      assert.equal(requestLogsBody.entries[0].serviceTier, undefined);
      assert.equal(requestLogsBody.entries[0].serviceTierSource, "none");
    }
  );
});

test("routes gpt chat requests to responses endpoint and maps response", async () => {
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
            id: "resp_abc",
            object: "response",
            created_at: 1772516800,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_abc",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "responses-route-ok"
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
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          max_tokens: 256,
          reasoningEffort: "high",
          reasoningSummary: "auto",
          textVerbosity: "low",
          include: ["reasoning.encrypted_content"],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                description: "Run shell command",
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
          tool_choice: {
            type: "function",
            function: {
              name: "bash"
            }
          }
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/responses");
      assert.ok(isRecord(observedBody));
      assert.ok(observedBody.stream === false || observedBody.stream === undefined);
      assert.equal(observedBody.max_output_tokens, 256);
      assert.ok(Array.isArray(observedBody.input));
      assert.ok(Array.isArray(observedBody.tools));
      assert.ok(isRecord(observedBody.tools[0]));
      assert.equal(observedBody.tools[0].name, "bash");
      assert.equal(observedBody.tools[0].type, "function");
      assert.ok(isRecord(observedBody.tool_choice));
      assert.equal(observedBody.tool_choice.type, "function");
      assert.equal(observedBody.tool_choice.name, "bash");
      assert.ok(isRecord(observedBody.reasoning));
      assert.equal(observedBody.reasoning.effort, "high");
      assert.equal(observedBody.reasoning.summary, "auto");
      assert.ok(isRecord(observedBody.text));
      assert.equal(observedBody.text.verbosity, "low");
      assert.ok(Array.isArray(observedBody.include));
      assert.equal(observedBody.include[0], "reasoning.encrypted_content");
      assert.ok(observedBody.prompt_cache_key === undefined || typeof observedBody.prompt_cache_key === "string");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "gpt-5.3-codex");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "responses-route-ok");
      assert.ok(isRecord(payload.usage));
      assert.equal(payload.usage.total_tokens, 13);
    }
  );
});

test("routes glm chat requests to chat-completions upstream", async () => {
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
            id: "chatcmpl_glm",
            object: "chat.completion",
            created: 1772516801,
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "glm-chat-completions-route-ok"
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
      assert.equal(response.headers["x-open-hax-upstream-mode"], "chat_completions");
      assert.equal(observedPath, "/v1/chat/completions");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "glm-5");
      assert.ok(Array.isArray(observedBody.messages));

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "glm-5");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "glm-chat-completions-route-ok");
    }
  );
});

test("fails over gpt responses accounts when requested reasoning trace is missing", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-no-reasoning", "key-with-reasoning"],
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        const parsedBody = JSON.parse(body);
        assert.ok(isRecord(parsedBody));
        assert.ok(isRecord(parsedBody.reasoning));

        if (auth === "Bearer key-no-reasoning") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "resp_no_reasoning",
              object: "response",
              created_at: 1772516810,
              model: "gpt-5.3-codex",
              output: [
                {
                  id: "msg_no_reasoning",
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "gpt-no-reasoning"
                    }
                  ]
                }
              ]
            })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp_with_reasoning",
            object: "response",
            created_at: 1772516811,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "rs_glm",
                type: "reasoning",
                summary: [
                  {
                    type: "summary_text",
                    text: "gpt-reasoning-ok"
                  }
                ]
              },
              {
                id: "msg_with_reasoning",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "gpt-with-reasoning"
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
          reasoning_effort: "low",
          include: ["reasoning.encrypted_content"],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(observedKeys, ["key-no-reasoning", "key-with-reasoning"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "gpt-with-reasoning");
      assert.equal(payload.choices[0].message.reasoning_content, "gpt-reasoning-ok");
    }
  );
});

test("fails over chat-completions accounts when requested reasoning trace is missing", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-kimi-no-reasoning", "key-kimi-with-reasoning"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-kimi-no-reasoning") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              id: "chatcmpl_kimi_no_reasoning",
              object: "chat.completion",
              created: 1772516812,
              model: "Kimi-K2.5",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "kimi-no-reasoning"
                  },
                  finish_reason: "stop"
                }
              ]
            })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "chatcmpl_kimi_with_reasoning",
            object: "chat.completion",
            created: 1772516813,
            model: "Kimi-K2.5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "kimi-with-reasoning",
                  reasoning_content: "kimi-reasoning-ok"
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
          model: "Kimi-K2.5",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "low",
          include: ["reasoning.encrypted_content"],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(observedKeys, ["key-kimi-no-reasoning", "key-kimi-with-reasoning"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "kimi-with-reasoning");
      assert.equal(payload.choices[0].message.reasoning_content, "kimi-reasoning-ok");
    }
  );
});

test("fails over streamed chat-completions accounts when requested reasoning trace is missing", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-kimi-stream-no-reasoning", "key-kimi-stream-with-reasoning"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-kimi-stream-no-reasoning") {
          return {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            },
            body:
              "data: {\"id\":\"chatcmpl_kimi_stream_no_reasoning\",\"object\":\"chat.completion.chunk\",\"created\":1772516814,\"model\":\"Kimi-K2.5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"stream-no-reasoning\"},\"finish_reason\":null}]}\n\n" +
              "data: {\"id\":\"chatcmpl_kimi_stream_no_reasoning\",\"object\":\"chat.completion.chunk\",\"created\":1772516814,\"model\":\"Kimi-K2.5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
              "data: [DONE]\n\n"
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          },
          body:
            "data: {\"id\":\"chatcmpl_kimi_stream_with_reasoning\",\"object\":\"chat.completion.chunk\",\"created\":1772516815,\"model\":\"Kimi-K2.5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"stream-reasoning-ok\",\"content\":\"stream-with-reasoning\"},\"finish_reason\":null}]}\n\n" +
            "data: {\"id\":\"chatcmpl_kimi_stream_with_reasoning\",\"object\":\"chat.completion.chunk\",\"created\":1772516815,\"model\":\"Kimi-K2.5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
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
          reasoning_effort: "low",
          include: ["reasoning.encrypted_content"],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(typeof response.headers["content-type"] === "string");
      assert.match(String(response.headers["content-type"]), /text\/event-stream/i);
      assert.deepEqual(observedKeys, ["key-kimi-stream-no-reasoning", "key-kimi-stream-with-reasoning"]);
      assert.ok(response.body.includes("stream-reasoning-ok"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("routes openai-prefixed models with oauth account failover", async () => {
  let observedPath = "";
  let observedBody: unknown;
  const observedAuth: string[] = [];
  const observedAccountIds: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          vivgrid: {
            auth: "api_key",
            accounts: ["vivgrid-key-1", "vivgrid-key-2"]
          },
          openai: {
            auth: "oauth_bearer",
            accounts: [
              { id: "openai-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
              { id: "openai-b", access_token: "oa-token-b", chatgpt_account_id: "chatgpt-b" }
            ]
          }
        }
      },
      upstreamHandler: async (request, body) => {
        const jsonHeaders: Record<string, string> = {
          "content-type": "application/json"
        };
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        const auth = request.headers.authorization;
        const chatgptAccountId = request.headers["chatgpt-account-id"];
        if (typeof auth === "string") {
          observedAuth.push(auth);
        }
        if (typeof chatgptAccountId === "string") {
          observedAccountIds.push(chatgptAccountId);
        }

        if (auth === "Bearer oa-token-a") {
          return {
            status: 429,
            headers: {
              ...jsonHeaders,
              "retry-after": "1"
            },
            body: JSON.stringify({ error: { message: "rate limit" } })
          };
        }

        const successHeaders: Record<string, string> = {
          "content-type": "application/json"
        };

        return {
          status: 200,
          headers: successHeaders,
          body: JSON.stringify({
            id: "resp_openai_oauth",
            object: "response",
            created_at: 1772516809,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_openai_oauth",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "openai-oauth-ok"
                  }
                ]
              }
            ],
            usage: {
              input_tokens: 7,
              output_tokens: 5,
              total_tokens: 12
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
          model: "openai/gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-open-hax-upstream-mode"], "openai_responses");
      assert.equal(observedPath, "/v1/responses");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "gpt-5.3-codex");
      assert.deepEqual(observedAuth, ["Bearer oa-token-a", "Bearer oa-token-b"]);
      assert.deepEqual(observedAccountIds, ["chatgpt-a", "chatgpt-b"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "gpt-5.3-codex");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "openai-oauth-ok");
      assert.ok(isRecord(payload.usage));
      assert.equal(payload.usage.total_tokens, 12);
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
        upstreamFallbackProviderIds: [],
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

test("returns synthetic chat-completion SSE for ollama stream requests", async () => {
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
              content: "ollama-stream-ok"
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 3,
            eval_count: 2
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
          model: "ollama:llama3.2:latest",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          num_ctx: 4096
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");

      assert.ok(isRecord(observedBody));
      assert.ok(isRecord(observedBody.options));
      assert.equal(observedBody.options.num_ctx, 4096);

      assert.ok(response.body.includes("chat.completion.chunk"));
      assert.ok(response.body.includes("ollama-stream-ok"));
      assert.ok(response.body.includes("data: [DONE]"));
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

test("serves native /api/tags from the local model catalog without an upstream request", async () => {
  let observedPath = "";
  await withProxyApp(
    {
      keys: [],
      models: ["qwen3.5:4b-q8_0", "qwen3.5:2b-bf16"],
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
      assert.equal(observedPath, "");
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
            message: { role: "assistant", content: "native-chat-ok" },
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
    }
  );
});

test("serves /v1/embeddings from local ollama-compatible upstream", async () => {
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
            embeddings: [[0.1, 0.2, 0.3]]
          })
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
      assert.equal(observedPath, "/api/embed");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "qwen3-embedding:0.6b");
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.data));
      assert.deepEqual(payload.data[0]?.embedding, [0.1, 0.2, 0.3]);
    }
  );
});

test("proxies native /api/embed and /api/embeddings to their matching upstream ollama endpoints", async () => {
  let observedPath = "";

  await withProxyApp(
    {
      keys: [],
      upstreamHandler: async (request) => {
        observedPath = request.url ?? "";
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
          model: "qwen3-embedding:0.6b",
          input: ["a", "b"]
        }
      });
      assert.equal(batchResponse.statusCode, 200);
      assert.equal(observedPath, "/api/embed");
      const batchPayload: unknown = batchResponse.json();
      assert.ok(isRecord(batchPayload));
      assert.deepEqual(batchPayload.embeddings, [[1, 2, 3], [4, 5, 6]]);

      const singleResponse = await app.inject({
        method: "POST",
        url: "/api/embeddings",
        payload: {
          model: "qwen3-embedding:0.6b",
          prompt: "a"
        }
      });
      assert.equal(singleResponse.statusCode, 200);
      assert.equal(observedPath, "/api/embed");
      const singlePayload: unknown = singleResponse.json();
      assert.ok(isRecord(singlePayload));
      assert.deepEqual(singlePayload.embedding, [1, 2, 3]);
    }
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
        streamBootstrapTimeoutMs: 50
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

test("serves model catalog from models JSON file", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      models: ["gpt-5.3-codex", "gemini-3.1-pro-preview"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
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

      const modelResponse = await app.inject({ method: "GET", url: "/v1/models/gpt-5.3-codex" });
      assert.equal(modelResponse.statusCode, 200);
      const modelPayload: unknown = modelResponse.json();
      assert.ok(isRecord(modelPayload));
      assert.equal(modelPayload.id, "gpt-5.3-codex");
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
        url: "/api/ui/sessions",
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
        url: `/api/ui/sessions/${sessionId}/cache-key`
      });

      assert.equal(cacheKeyResponse.statusCode, 200);
      const cacheKeyPayload: unknown = cacheKeyResponse.json();
      assert.ok(isRecord(cacheKeyPayload));
      assert.equal(cacheKeyPayload.promptCacheKey, promptCacheKey);

      const getSessionResponse = await app.inject({
        method: "GET",
        url: `/api/ui/sessions/${sessionId}`
      });
      const getSessionPayload: unknown = getSessionResponse.json();
      assert.ok(isRecord(getSessionPayload));
      assert.ok(isRecord(getSessionPayload.session));
      assert.equal(getSessionPayload.session.promptCacheKey, promptCacheKey);
    }
  );
});

test("includes ollama provider catalog models and largest-size aliases in /v1/models", async () => {
  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-catalog-key"]
        }
      },
      models: ["gpt-5.3-codex"],
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
        upstreamFallbackProviderIds: []
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

      assert.ok(ids.includes("gpt-5.3-codex"));
      assert.ok(ids.includes("qwen3.5:397b"));
      assert.ok(ids.includes("qwen3-coder:480b"));
      assert.ok(ids.includes("qwen3-vl:235b"));
      assert.ok(ids.includes("qwen3.5"));
      assert.ok(ids.includes("qwen3-coder"));
      assert.ok(ids.includes("qwen3-vl"));
    }
  );
});

test("rewrites largest-model alias requests for ollama catalog models", async () => {
  const observedModels: string[] = [];

  await withProxyApp(
    {
      keys: [],
      keysPayload: {
        providers: {
          "ollama-cloud": ["ollama-alias-key"]
        }
      },
      configOverrides: {
        upstreamProviderId: "ollama-cloud",
        upstreamFallbackProviderIds: []
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
