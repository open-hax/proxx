import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KeyPool } from "../lib/key-pool.js";

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
            { id: "oc-primary", api_key: "oc-key-primary" },
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
            { id: "oc-a", api_key: "oc-key-a" },
            { id: "oc-b", api_key: "oc-key-b" }
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
