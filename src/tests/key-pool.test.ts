import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KeyPool } from "../lib/key-pool.js";
import type { ProviderCredential, ProviderAuthType } from "../lib/key-pool.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function withKeysFile(payload: unknown, fn: (keysFilePath: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "open-hax-key-pool-test-"));
  const keysFilePath = path.join(tempDir, "keys.json");

  await writeFile(keysFilePath, JSON.stringify(payload, null, 2), "utf8");

  try {
    await fn(keysFilePath);
  } finally {
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

test("accepts provider key arrays and generates internal UUID account IDs", async () => {
  await withKeysFile(
    {
      providers: {
        "ollama-cloud": {
          auth: "api_key",
          accounts: ["oc-key-1", "oc-key-2"]
        }
      }
    },
    async (keysFilePath) => {
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 10,
        defaultCooldownMs: 1000,
        defaultProviderId: "ollama-cloud"
      });

      await keyPool.warmup();
      const accounts = await keyPool.getRequestOrder("ollama-cloud");

      assert.equal(accounts.length, 2);
      assert.ok(accounts.every((account) => account.providerId === "ollama-cloud"));
      assert.ok(accounts.every((account) => account.authType === "api_key"));
      assert.ok(accounts.every((account) => UUID_PATTERN.test(account.accountId)));
      assert.equal(new Set(accounts.map((account) => account.accountId)).size, 2);
    }
  );
});

test("keeps generated account IDs stable across automatic key reloads", async () => {
  await withKeysFile(
    {
      providers: {
        "ollama-cloud": {
          accounts: ["oc-key-a", "oc-key-b"]
        }
      }
    },
    async (keysFilePath) => {
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 1,
        defaultCooldownMs: 1000,
        defaultProviderId: "ollama-cloud"
      });

      await keyPool.warmup();

      const firstIds = (await keyPool.getRequestOrder("ollama-cloud"))
        .map((account) => account.accountId)
        .sort();

      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });

      const secondIds = (await keyPool.getRequestOrder("ollama-cloud"))
        .map((account) => account.accountId)
        .sort();

      assert.deepEqual(secondIds, firstIds);
      assert.ok(secondIds.every((accountId) => UUID_PATTERN.test(accountId)));
    }
  );
});

test("preserves explicit account IDs while auto-generating for string entries", async () => {
  await withKeysFile(
    {
      providers: {
        "ollama-cloud": {
          auth: "api_key",
          accounts: [
            { id: "oc-primary", token: "oc-token-primary" },
            "oc-key-fallback"
          ]
        }
      }
    },
    async (keysFilePath) => {
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 10,
        defaultCooldownMs: 1000,
        defaultProviderId: "ollama-cloud"
      });

      await keyPool.warmup();
      const accounts = await keyPool.getRequestOrder("ollama-cloud");

      assert.equal(accounts.length, 2);
      const ids = new Set(accounts.map((account) => account.accountId));
      assert.ok(ids.has("oc-primary"));

      const generatedId = accounts
        .map((account) => account.accountId)
        .find((accountId) => accountId !== "oc-primary");
      assert.ok(typeof generatedId === "string");
      assert.ok(UUID_PATTERN.test(generatedId!));
    }
  );
});

test("prefers non-busy accounts before reusing in-flight accounts", async () => {
  await withKeysFile(
    {
      providers: {
        "ollama-cloud": {
          auth: "api_key",
          accounts: [
            { id: "oc-a", token: "oc-token-a" },
            { id: "oc-b", token: "oc-token-b" }
          ]
        }
      }
    },
    async (keysFilePath) => {
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 10,
        defaultCooldownMs: 1000,
        defaultProviderId: "ollama-cloud"
      });

      await keyPool.warmup();
      const initial = await keyPool.getRequestOrder("ollama-cloud");
      assert.equal(initial.length, 2);

      const release = keyPool.markInFlight(initial[0]!);
      const reordered = await keyPool.getRequestOrder("ollama-cloud");
      assert.equal(reordered.length, 2);
      assert.equal(reordered[0]?.accountId, initial[1]?.accountId);
      assert.equal(reordered[1]?.accountId, initial[0]?.accountId);

      release();
      const status = await keyPool.getStatus("ollama-cloud");
      assert.equal(status.inFlightAccounts, 0);
    }
  );
});

test("random walk excludes accounts that are still cooling down", async () => {
  await withKeysFile(
    {
      providers: {
        "ollama-cloud": {
          auth: "api_key",
          accounts: [
            { id: "oc-a", token: "oc-token-a" },
            { id: "oc-b", token: "oc-token-b" },
          ],
        },
      },
    },
    async (keysFilePath) => {
      const originalNow = Date.now;
      let now = 1_700_000_000_000;
      Date.now = () => now;

      try {
        const keyPool = new KeyPool({
          keysFilePath,
          reloadIntervalMs: 10,
          defaultCooldownMs: 1_000,
          defaultProviderId: "ollama-cloud",
          cooldownJitterFactor: 0,
          enableRandomWalk: true,
        }, () => 0.5);

        await keyPool.warmup();
        const initial = await keyPool.getRequestOrder("ollama-cloud");
        assert.equal(initial.length, 2);

        keyPool.markRateLimited(initial[0]!, 60_000);

        const duringCooldown = await keyPool.getRequestOrder("ollama-cloud");
        assert.deepEqual(duringCooldown.map((account) => account.accountId), [initial[1]!.accountId]);

        now += 60_001;
        const afterCooldown = await keyPool.getRequestOrder("ollama-cloud");
        assert.equal(afterCooldown.length, 2);
      } finally {
        Date.now = originalNow;
      }
    },
  );
});

test("refresh ordering omits accounts that are still cooling down", async () => {
  await withKeysFile(
    {
      providers: {
        openai: {
          auth: "oauth_bearer",
          accounts: [
            { id: "oa-a", access_token: "oa-token-a", chatgpt_account_id: "chatgpt-a" },
            { id: "oa-b", access_token: "oa-token-b", chatgpt_account_id: "chatgpt-b" },
          ],
        },
      },
    },
    async (keysFilePath) => {
      const originalNow = Date.now;
      const now = 1_700_000_000_000;
      Date.now = () => now;

      try {
        const keyPool = new KeyPool({
          keysFilePath,
          reloadIntervalMs: 10,
          defaultCooldownMs: 1_000,
          defaultProviderId: "openai",
        });

        await keyPool.warmup();
        const initial = await keyPool.getRequestOrder("openai");
        assert.equal(initial.length, 2);

        keyPool.markRateLimited(initial[0]!, 60_000);

        const ordered = await keyPool.getRequestOrderWithRefresh("openai", async () => null);
        assert.deepEqual(ordered.map((account) => account.accountId), [initial[1]!.accountId]);
      } finally {
        Date.now = originalNow;
      }
    },
  );
});

test("weighted shuffle rescales remaining weight mass between picks", async () => {
  await withKeysFile(
    {
      providers: {
        "ollama-cloud": {
          auth: "api_key",
          accounts: [
            { id: "oc-a", token: "oc-token-a" },
            { id: "oc-b", token: "oc-token-b" },
            { id: "oc-c", token: "oc-token-c" },
          ],
        },
      },
    },
    async (keysFilePath) => {
      const rngValues = [0, 0, 1, 0.95, 0.95, 0.95];
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 10,
        defaultCooldownMs: 1_000,
        defaultProviderId: "ollama-cloud",
        cooldownJitterFactor: 0,
        enableRandomWalk: true,
      }, () => rngValues.shift() ?? 0.5);

      await keyPool.warmup();
      const ordered = await keyPool.getRequestOrder("ollama-cloud");
      assert.deepEqual(ordered.map((account) => account.accountId), ["oc-c", "oc-b", "oc-a"]);
    },
  );
});

test("rate-limit cooldown survives OAuth token refresh for the same account", async () => {
  await withKeysFile(
    {
      providers: {
        openai: {
          auth: "oauth_bearer",
          accounts: [
            { id: "oa-1", access_token: "oa-token-old", chatgpt_account_id: "chatgpt-a" },
          ],
        },
      },
    },
    async (keysFilePath) => {
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 100000,
        defaultCooldownMs: 60_000,
        defaultProviderId: "openai",
      });

      await keyPool.warmup();
      const credential = (await keyPool.getRequestOrder("openai"))[0]!;

      keyPool.markRateLimited(credential, 60_000);

      const refreshedCredential: ProviderCredential = {
        ...credential,
        token: "oa-token-new",
      };
      keyPool.updateAccountCredential("openai", credential, refreshedCredential);

      const afterRefresh = await keyPool.getRequestOrder("openai");
      assert.deepEqual(afterRefresh, []);
    },
  );
});

test("loads env-backed openrouter and requesty providers alongside file accounts", { concurrency: false }, async () => {
  await withEnv(
    {
      OPENROUTER_API_KEY: "or-token-1", // pragma: allowlist secret
      REQUESTY_API_TOKEN: "req-key-1", // pragma: allowlist secret
      OPENROUTER_PROVIDER_ID: undefined,
      REQUESTY_PROVIDER_ID: undefined,
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            "ollama-cloud": {
              accounts: ["oc-key-1"],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "ollama-cloud",
          });

          await keyPool.warmup();
          const openrouterAccounts = await keyPool.getRequestOrder("openrouter");
          const requestyAccounts = await keyPool.getRequestOrder("requesty");

          assert.equal(openrouterAccounts.length, 1);
          assert.equal(openrouterAccounts[0]?.providerId, "openrouter");
          assert.equal(openrouterAccounts[0]?.token, "or-token-1");
          assert.ok(UUID_PATTERN.test(openrouterAccounts[0]?.accountId ?? ""));

          assert.equal(requestyAccounts.length, 1);
          assert.equal(requestyAccounts[0]?.providerId, "requesty");
          assert.equal(requestyAccounts[0]?.token, "req-key-1");
          assert.ok(UUID_PATTERN.test(requestyAccounts[0]?.accountId ?? ""));
        },
      );
    },
  );
});

test("warmup clears stale provider accounts when the account store becomes empty", async () => {
  let providers = new Map<string, { authType: ProviderAuthType }>([
    ["openai", { authType: "oauth_bearer" }],
  ]);
  let accounts = new Map<string, ProviderCredential[]>([
    ["openai", [{
      providerId: "openai",
      accountId: "chatgpt-a1-account",
      token: "access-a1",
      authType: "oauth_bearer",
      chatgptAccountId: "chatgpt-a1",
    }]],
  ]);

  const keyPool = new KeyPool({
    keysFilePath: "/tmp/nonexistent-keys.json",
    reloadIntervalMs: 1,
    defaultCooldownMs: 1000,
    defaultProviderId: "openai",
    accountStore: {
      getAllProviders: async () => new Map(providers),
      getAllAccounts: async () => new Map(accounts),
    },
    preferAccountStoreProviders: true,
  });

  await keyPool.warmup();
  assert.equal((await keyPool.getAllAccounts("openai")).length, 1);

  providers = new Map();
  accounts = new Map();

  await keyPool.warmup();
  assert.equal((await keyPool.getAllAccounts("openai")).length, 0);
  await assert.rejects(() => keyPool.getRequestOrder("openai"), /No accounts configured for provider: openai/);
});

test("loads env-backed gemini provider via GEMINI_API_KEY", { concurrency: false }, async () => {
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
      await withKeysFile(
        {
          providers: {
            "ollama-cloud": {
              accounts: ["oc-key-1"],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "ollama-cloud",
          });

          await keyPool.warmup();
          const geminiAccounts = await keyPool.getRequestOrder("gemini");

          assert.equal(geminiAccounts.length, 1);
          assert.equal(geminiAccounts[0]?.providerId, "gemini");
          assert.equal(geminiAccounts[0]?.token, "gem-key-1");
          assert.ok(UUID_PATTERN.test(geminiAccounts[0]?.accountId ?? ""));
        },
      );
    },
  );
});

test("loads env-backed zai, rotussy, and mistral providers", { concurrency: false }, async () => {
  await withEnv(
    {
      ZAI_API_KEY: "zai-key-1", // pragma: allowlist secret
      ROTUSSY_API_KEY: "rotussy-key-1", // pragma: allowlist secret
      MISTRAL_API_KEY: "mistral-key-1", // pragma: allowlist secret
      ZAI_PROVIDER_ID: undefined,
      ROTUSSY_PROVIDER_ID: undefined,
      MISTRAL_PROVIDER_ID: undefined,
      GEMINI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      REQUESTY_API_TOKEN: undefined,
      REQUESTY_API_KEY: undefined,
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            "ollama-cloud": {
              accounts: ["oc-key-1"],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "ollama-cloud",
          });

          await keyPool.warmup();
          const zaiAccounts = await keyPool.getRequestOrder("zai");
          const rotussyAccounts = await keyPool.getRequestOrder("rotussy");
          const mistralAccounts = await keyPool.getRequestOrder("mistral");

          assert.equal(zaiAccounts.length, 1);
          assert.equal(zaiAccounts[0]?.providerId, "zai");
          assert.equal(zaiAccounts[0]?.token, "zai-key-1");

          assert.equal(rotussyAccounts.length, 1);
          assert.equal(rotussyAccounts[0]?.providerId, "rotussy");
          assert.equal(rotussyAccounts[0]?.token, "rotussy-key-1");

          assert.equal(mistralAccounts.length, 1);
          assert.equal(mistralAccounts[0]?.providerId, "mistral");
          assert.equal(mistralAccounts[0]?.token, "mistral-key-1");
        },
      );
    },
  );
});

test("treats epoch-second OAuth expirations as future timestamps", async () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;

  await withKeysFile(
    {
      providers: {
        openai: {
          auth: "oauth_bearer",
          accounts: [{
            id: "oa-plus",
            access_token: "oa-token",
            refresh_token: "oa-refresh",
            expires_at: expiresAtSeconds,
            chatgpt_account_id: "cgpt-plus",
            plan_type: "plus",
          }],
        },
      },
    },
    async (keysFilePath) => {
      const keyPool = new KeyPool({
        keysFilePath,
        reloadIntervalMs: 10,
        defaultCooldownMs: 1000,
        defaultProviderId: "openai",
      });

      await keyPool.warmup();
      const accounts = await keyPool.getRequestOrder("openai");

      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.accountId, "oa-plus");
      assert.equal(accounts[0]?.expiresAt, expiresAtSeconds * 1000);
      assert.equal(keyPool.isAccountExpired(accounts[0]!), false);
    },
  );
});

test("loads inline JSON credentials from env without a keys file", { concurrency: false }, async () => {
  await withEnv(
    {
      PROXY_KEYS_JSON: JSON.stringify({
        providers: {
          vivgrid: {
            auth: "api_key",
            accounts: [{ id: "env-vg", token: "vg-inline-token" }],
          },
        },
      }),
    },
    async () => {
      const keyPool = new KeyPool({
        keysFilePath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        reloadIntervalMs: 10,
        defaultCooldownMs: 1000,
        defaultProviderId: "vivgrid",
      });

      await keyPool.warmup();
      const accounts = await keyPool.getRequestOrder("vivgrid");

      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.providerId, "vivgrid");
      assert.equal(accounts[0]?.accountId, "env-vg");
      assert.equal(accounts[0]?.token, "vg-inline-token");
    },
  );
});

test("ignores malformed inline JSON credentials from env when another source is available", { concurrency: false }, async () => {
  await withEnv(
    {
      PROXY_KEYS_JSON: "{not-valid-json",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            vivgrid: {
              auth: "api_key",
              accounts: [{ id: "file-vg", token: "vg-file-token" }],
            },
          },
        },
        async (keysFilePath) => {
          const warnings: string[] = [];
          const originalWarn = console.warn;
          console.warn = (message?: unknown, ...args: unknown[]) => {
            warnings.push([message, ...args].map((value) => String(value)).join(" "));
          };

          try {
            const keyPool = new KeyPool({
              keysFilePath,
              reloadIntervalMs: 10,
              defaultCooldownMs: 1000,
              defaultProviderId: "vivgrid",
            });

            await keyPool.warmup();
            const accounts = await keyPool.getRequestOrder("vivgrid");

            assert.equal(accounts.length, 1);
            assert.equal(accounts[0]?.accountId, "file-vg");
            assert.equal(accounts[0]?.token, "vg-file-token");
            assert.ok(warnings.some((entry) => entry.includes("Failed to parse inline keys JSON from env")));
          } finally {
            console.warn = originalWarn;
          }
        },
      );
    },
  );
});

test("loads credentials from account store when database-backed source is configured", async () => {
  const accountStore = {
    async getAllProviders(): Promise<Map<string, { authType: ProviderAuthType }>> {
      return new Map([
        ["openai", { authType: "oauth_bearer" }],
      ]);
    },
    async getAllAccounts(): Promise<Map<string, ProviderCredential[]>> {
      return new Map([
        ["openai", [{
          providerId: "openai",
          accountId: "db-openai-1",
          token: "db-token-1",
          authType: "oauth_bearer",
          refreshToken: "db-refresh-1",
          chatgptAccountId: "cgpt-db-1",
        }]],
      ]);
    },
  };

  const keyPool = new KeyPool({
    keysFilePath: path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}.json`),
    reloadIntervalMs: 10,
    defaultCooldownMs: 1000,
    defaultProviderId: "openai",
    accountStore,
  });

  await keyPool.warmup();
  const accounts = await keyPool.getRequestOrder("openai");

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.providerId, "openai");
  assert.equal(accounts[0]?.accountId, "db-openai-1");
  assert.equal(accounts[0]?.token, "db-token-1");
  assert.equal(accounts[0]?.authType, "oauth_bearer");
});

// ─── Disable/Enable Account Tests ──────────────────────────────────────────

test("disableAccount excludes account from getRequestOrder", async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            factory: {
              auth: "api_key",
              accounts: [
                { id: "acct-1", api_key: "fk-key-1" }, // pragma: allowlist secret
                { id: "acct-2", api_key: "fk-key-2" }, // pragma: allowlist secret
                { id: "acct-3", api_key: "fk-key-3" }, // pragma: allowlist secret
              ],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "factory",
          });

          await keyPool.warmup();

          // All accounts should be available initially
          const initial = await keyPool.getRequestOrder("factory");
          assert.equal(initial.length, 3);

          // Disable one account
          keyPool.disableAccount("factory", "acct-2");

          // Only 2 accounts should be available now
          const afterDisable = await keyPool.getRequestOrder("factory");
          assert.equal(afterDisable.length, 2);
          assert.ok(afterDisable.every((a) => a.accountId !== "acct-2"), "Disabled account should not be in results");
        }
      );
    }
  );
});

test("enableAccount re-includes disabled account in getRequestOrder", async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            factory: {
              auth: "api_key",
              accounts: [
                { id: "acct-1", api_key: "fk-key-1" }, // pragma: allowlist secret
                { id: "acct-2", api_key: "fk-key-2" }, // pragma: allowlist secret
              ],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "factory",
          });

          await keyPool.warmup();

          // Disable an account
          keyPool.disableAccount("factory", "acct-1");
          const afterDisable = await keyPool.getRequestOrder("factory");
          assert.equal(afterDisable.length, 1);
          assert.equal(afterDisable[0]?.accountId, "acct-2");

          // Enable the account
          keyPool.enableAccount("factory", "acct-1");
          const afterEnable = await keyPool.getRequestOrder("factory");
          assert.equal(afterEnable.length, 2);
          assert.ok(afterEnable.some((a) => a.accountId === "acct-1"));
          assert.ok(afterEnable.some((a) => a.accountId === "acct-2"));
        }
      );
    }
  );
});

test("isAccountDisabled returns correct state", async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            factory: {
              auth: "api_key",
              accounts: [
                { id: "acct-1", api_key: "fk-key-1" }, // pragma: allowlist secret
                { id: "acct-2", api_key: "fk-key-2" }, // pragma: allowlist secret
              ],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "factory",
          });

          await keyPool.warmup();

          // Initially not disabled
          assert.equal(keyPool.isAccountDisabled("factory", "acct-1"), false);
          assert.equal(keyPool.isAccountDisabled("factory", "acct-2"), false);

          // Disable acct-1
          keyPool.disableAccount("factory", "acct-1");
          assert.equal(keyPool.isAccountDisabled("factory", "acct-1"), true);
          assert.equal(keyPool.isAccountDisabled("factory", "acct-2"), false);

          // Enable acct-1
          keyPool.enableAccount("factory", "acct-1");
          assert.equal(keyPool.isAccountDisabled("factory", "acct-1"), false);
          assert.equal(keyPool.isAccountDisabled("factory", "acct-2"), false);
        }
      );
    }
  );
});

test("getDisabledAccounts returns list of disabled accounts", async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            factory: {
              auth: "api_key",
              accounts: [
                { id: "acct-1", api_key: "fk-key-1" }, // pragma: allowlist secret
                { id: "acct-2", api_key: "fk-key-2" }, // pragma: allowlist secret
                { id: "acct-3", api_key: "fk-key-3" }, // pragma: allowlist secret
              ],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "factory",
          });

          await keyPool.warmup();

          // Initially no disabled accounts
          assert.deepEqual(keyPool.getDisabledAccounts(), []);

          // Disable some accounts
          keyPool.disableAccount("factory", "acct-1");
          keyPool.disableAccount("factory", "acct-3");

          const disabled = keyPool.getDisabledAccounts();
          assert.equal(disabled.length, 2);
          assert.ok(disabled.some((a) => a.providerId === "factory" && a.accountId === "acct-1"));
          assert.ok(disabled.some((a) => a.providerId === "factory" && a.accountId === "acct-3"));
          assert.ok(!disabled.some((a) => a.accountId === "acct-2"));
        }
      );
    }
  );
});

test("disabled accounts are excluded from getRequestOrderWithRefresh", async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            factory: {
              auth: "api_key",
              accounts: [
                { id: "acct-1", api_key: "fk-key-1" }, // pragma: allowlist secret
                { id: "acct-2", api_key: "fk-key-2" }, // pragma: allowlist secret
              ],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "factory",
          });

          await keyPool.warmup();

          // Both accounts should be available initially
          const initialAccounts = await keyPool.getRequestOrder("factory");
          assert.equal(initialAccounts.length, 2);

          // Disable acct-1
          keyPool.disableAccount("factory", "acct-1");

          const refreshFn = async () => null;
          const accounts = await keyPool.getRequestOrderWithRefresh("factory", refreshFn);
          assert.equal(accounts.length, 1);
          assert.equal(accounts[0]?.accountId, "acct-2");
        }
      );
    }
  );
});

test("disabling all accounts returns empty array when requesting order", async () => {
  await withEnv(
    {
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_V2_FILE: "/tmp/nonexistent-auth-v2-file",
      FACTORY_AUTH_V2_KEY: "/tmp/nonexistent-auth-v2-key",
    },
    async () => {
      await withKeysFile(
        {
          providers: {
            factory: {
              auth: "api_key",
              accounts: [
                { id: "acct-1", api_key: "fk-key-1" }, // pragma: allowlist secret
                { id: "acct-2", api_key: "fk-key-2" }, // pragma: allowlist secret
              ],
            },
          },
        },
        async (keysFilePath) => {
          const keyPool = new KeyPool({
            keysFilePath,
            reloadIntervalMs: 10,
            defaultCooldownMs: 1000,
            defaultProviderId: "factory",
          });

          await keyPool.warmup();

          // Disable all accounts
          keyPool.disableAccount("factory", "acct-1");
          keyPool.disableAccount("factory", "acct-2");

          // Should return empty array when all accounts are disabled
          const accounts = await keyPool.getRequestOrder("factory");
          assert.equal(accounts.length, 0);
        }
      );
    }
  );
});
