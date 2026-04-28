import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialStoreLike } from "../lib/credential-store.js";
import type { AccountHealthStore } from "../lib/db/account-health-store.js";
import { QuotaMonitor } from "../lib/quota-monitor.js";

function createCredentialStore(accounts: ReadonlyArray<{ readonly id: string; readonly token: string }>): CredentialStoreLike {
  return {
    async listProviders() {
      return [
        {
          id: "openai",
          authType: "oauth_bearer",
          accountCount: accounts.length,
          accounts: accounts.map((account) => ({
            id: account.id,
            authType: "oauth_bearer" as const,
            displayName: account.id,
            secretPreview: `${account.token.slice(0, 3)}***`,
            secret: account.token,
          })),
        },
      ];
    },
    async upsertApiKeyAccount() {},
    async upsertOAuthAccount() {},
    async removeAccount() {
      return false;
    },
  };
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("quota monitor continues checking all accounts after one is already exhausted", async () => {
  const credentialStore: CredentialStoreLike = {
    async listProviders() {
      return [
        {
          id: "openai",
          authType: "oauth_bearer",
          accountCount: 2,
          accounts: [
            {
              id: "acct-a",
              authType: "oauth_bearer",
              displayName: "Account A",
              secretPreview: "tok***-a",
              secret: "token-a",
            },
            {
              id: "acct-b",
              authType: "oauth_bearer",
              displayName: "Account B",
              secretPreview: "tok***-b",
              secret: "token-b",
            },
          ],
        },
      ];
    },
    async upsertApiKeyAccount() {},
    async upsertOAuthAccount() {},
    async removeAccount() {
      return false;
    },
  };

  const exhaustedAccounts: string[] = [];
  const healthStore = {
    recordQuotaExhausted(_providerId: string, accountId: string) {
      exhaustedAccounts.push(accountId);
    },
    resetQuotaExhausted() {},
  } as unknown as AccountHealthStore;

  const logger = {
    info() {},
    warn() {},
    error() {},
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const accountId = authorization === "Bearer token-a" ? "acct-a" : "acct-b";

    return new Response(JSON.stringify({
      usage: {
        primary: { used_percent: 99 },
        weekly: { used_percent: accountId === "acct-a" ? 50 : 60 },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const monitor = new QuotaMonitor(
      credentialStore,
      logger,
      {
        providerId: "openai",
        quotaWarningThreshold: 90,
        quotaCriticalThreshold: 98,
      },
      healthStore,
    );

    monitor.markAccountExhausted("acct-a");
    await monitor.checkQuotas();

    assert.equal(monitor.isAccountExhausted("acct-a"), true);
    assert.equal(monitor.isAccountExhausted("acct-b"), true);
    assert.deepEqual(exhaustedAccounts.sort((left, right) => left.localeCompare(right)), ["acct-a", "acct-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quota monitor treats OpenAI limit_reached accounts as exhausted and applies quota-reset cooldowns", async () => {
  const credentialStore = createCredentialStore([{ id: "acct-a", token: "token-a" }]);
  const exhaustedAccounts: string[] = [];
  const appliedCooldowns: Array<{ providerId: string; accountId: string; cooldownUntil: number }> = [];

  const healthStore = {
    recordQuotaExhausted(_providerId: string, accountId: string) {
      exhaustedAccounts.push(accountId);
    },
    resetQuotaExhausted() {},
  } as unknown as AccountHealthStore;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer token-a");

    return new Response(JSON.stringify({
      usage: {
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: {
            remaining_percent: 72,
            limit_window_seconds: 18000,
            reset_after_seconds: 7200,
          },
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const monitor = new QuotaMonitor(
      credentialStore,
      createLogger(),
      { providerId: "openai" },
      healthStore,
      {
        setAccountCooldownUntil(providerId: string, accountId: string, cooldownUntil: number) {
          appliedCooldowns.push({ providerId, accountId, cooldownUntil });
        },
        clearAccountCooldown() {},
      },
    );

    await monitor.checkQuotas();

    assert.equal(monitor.isAccountExhausted("acct-a"), true);
    assert.deepEqual(exhaustedAccounts, ["acct-a"]);
    assert.equal(appliedCooldowns.length, 1);
    assert.equal(appliedCooldowns[0]?.providerId, "openai");
    assert.equal(appliedCooldowns[0]?.accountId, "acct-a");
    assert.ok((appliedCooldowns[0]?.cooldownUntil ?? 0) > Date.now() + 7_100_000);
    assert.ok((monitor.getCooldownMs("acct-a") ?? 0) >= 7_100_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quota monitor clears quota cooldowns when a later scan observes a reset", async () => {
  const credentialStore = createCredentialStore([{ id: "acct-a", token: "token-a" }]);
  const resetAccounts: string[] = [];
  const clearedCooldowns: string[] = [];
  let fetchCount = 0;

  const healthStore = {
    recordQuotaExhausted() {},
    resetQuotaExhausted(_providerId: string, accountId: string) {
      resetAccounts.push(accountId);
    },
  } as unknown as AccountHealthStore;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    const payload = fetchCount === 1
      ? {
          usage: {
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: {
                remaining_percent: 65,
                reset_after_seconds: 3600,
              },
            },
          },
        }
      : {
          usage: {
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                remaining_percent: 100,
                reset_after_seconds: 0,
              },
            },
          },
        };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const monitor = new QuotaMonitor(
      credentialStore,
      createLogger(),
      { providerId: "openai" },
      healthStore,
      {
        setAccountCooldownUntil() {},
        clearAccountCooldown(providerId: string, accountId: string) {
          clearedCooldowns.push(`${providerId}:${accountId}`);
        },
      },
    );

    await monitor.checkQuotas();
    assert.equal(monitor.isAccountExhausted("acct-a"), true);

    await monitor.checkQuotas();

    assert.equal(monitor.isAccountExhausted("acct-a"), false);
    assert.deepEqual(resetAccounts, ["acct-a"]);
    assert.deepEqual(clearedCooldowns, ["openai:acct-a"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quota monitor refreshAccountQuota fetches only the targeted account", async () => {
  const credentialStore = createCredentialStore([
    { id: "acct-a", token: "token-a" },
    { id: "acct-b", token: "token-b" },
  ]);
  const observedAuth: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    if (auth) {
      observedAuth.push(auth);
    }

    return new Response(JSON.stringify({
      usage: {
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: {
            reset_after_seconds: 5400,
          },
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const monitor = new QuotaMonitor(
      credentialStore,
      createLogger(),
      { providerId: "openai" },
    );

    const record = await monitor.refreshAccountQuota("acct-b");

    assert.equal(record?.accountId, "acct-b");
    assert.deepEqual(observedAuth, ["Bearer token-b"]);
    assert.ok((monitor.getCooldownMs("acct-b") ?? 0) >= 5_300_000);
    assert.equal(monitor.getQuotaStatus("acct-a"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
