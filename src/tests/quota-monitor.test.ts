import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialStoreLike } from "../lib/credential-store.js";
import type { AccountHealthStore } from "../lib/db/account-health-store.js";
import { QuotaMonitor } from "../lib/quota-monitor.js";

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