import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderCredential } from "../lib/key-pool.js";
import {
  createEnsureFreshAccounts,
  createFactoryRefreshHandler,
  createOpenAiRefreshHandler,
} from "../lib/token-refresh-handlers.js";

function createCredential(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    providerId: "openai",
    accountId: "acct-1",
    token: "token-1",
    authType: "oauth_bearer",
    refreshToken: "refresh-1",
    ...overrides,
  };
}

function createLogger(): {
  readonly infoEntries: Array<{ readonly obj: Record<string, unknown>; readonly msg: string }>;
  readonly warnEntries: Array<{ readonly obj: Record<string, unknown>; readonly msg: string }>;
  readonly info: (obj: Record<string, unknown>, msg: string) => void;
  readonly warn: (obj: Record<string, unknown>, msg: string) => void;
} {
  const infoEntries: Array<{ readonly obj: Record<string, unknown>; readonly msg: string }> = [];
  const warnEntries: Array<{ readonly obj: Record<string, unknown>; readonly msg: string }> = [];

  return {
    infoEntries,
    warnEntries,
    info: (obj, msg) => {
      infoEntries.push({ obj, msg });
    },
    warn: (obj, msg) => {
      warnEntries.push({ obj, msg });
    },
  };
}

test("createEnsureFreshAccounts refreshes expired provider accounts and proactively refreshes factory accounts", async () => {
  const expiredFactory = createCredential({ providerId: "factory", accountId: "expired-factory" });
  const proactiveFactory = createCredential({ providerId: "factory", accountId: "proactive-factory", expiresAt: Date.now() + 60_000 });
  const skippedFactory = createCredential({ providerId: "factory", accountId: "skipped-factory", expiresAt: Date.now() + 10 * 60_000 });

  const refreshBatchCalls: ProviderCredential[][] = [];
  const refreshCalls: ProviderCredential[] = [];

  const ensureFreshAccounts = createEnsureFreshAccounts({
    keyPool: {
      getExpiredAccountsWithRefreshTokens(providerId: string): ProviderCredential[] {
        return providerId === "factory" ? [expiredFactory] : [];
      },
      async getAllAccounts(providerId: string): Promise<ProviderCredential[]> {
        return providerId === "factory" ? [proactiveFactory, skippedFactory] : [];
      },
    },
    tokenRefreshManager: {
      async refreshBatch(credentials: readonly ProviderCredential[]): Promise<(ProviderCredential | null)[]> {
        refreshBatchCalls.push([...credentials]);
        return credentials.map((credential) => credential);
      },
      async refresh(credential: ProviderCredential): Promise<ProviderCredential | null> {
        refreshCalls.push(credential);
        return credential;
      },
    },
    shouldRefreshFactoryAccount: (credential) => credential.accountId === proactiveFactory.accountId,
  });

  await ensureFreshAccounts("factory");

  assert.deepEqual(refreshBatchCalls, [[expiredFactory]]);
  assert.deepEqual(refreshCalls, [proactiveFactory]);
});

test("createEnsureFreshAccounts skips factory proactive refresh for non-factory providers", async () => {
  const expiredOpenAi = createCredential({ providerId: "openai", accountId: "expired-openai" });
  const refreshCalls: ProviderCredential[] = [];

  const ensureFreshAccounts = createEnsureFreshAccounts({
    keyPool: {
      getExpiredAccountsWithRefreshTokens(providerId: string): ProviderCredential[] {
        return providerId === "openai" ? [expiredOpenAi] : [];
      },
      async getAllAccounts(): Promise<ProviderCredential[]> {
        throw new Error("getAllAccounts should not be called for non-factory providers");
      },
    },
    tokenRefreshManager: {
      async refreshBatch(credentials: readonly ProviderCredential[]): Promise<(ProviderCredential | null)[]> {
        refreshCalls.push(...credentials);
        return credentials.map((credential) => credential);
      },
      async refresh(): Promise<ProviderCredential | null> {
        throw new Error("refresh should not be called for non-factory providers");
      },
    },
  });

  await ensureFreshAccounts("openai");

  assert.deepEqual(refreshCalls, [expiredOpenAi]);
});

test("createOpenAiRefreshHandler returns null when no refresh token exists", async () => {
  const logger = createLogger();
  const handler = createOpenAiRefreshHandler({
    keyPool: {
      updateAccountCredential() {},
      markRateLimited() {},
      getExpiredAccountsWithRefreshTokens() { return []; },
      async getAllAccounts() { return []; },
    },
    runtimeCredentialStore: {
      async upsertOAuthAccount() {
        throw new Error("upsertOAuthAccount should not be called without refresh token");
      },
    } as never,
    oauthManager: {
      async refreshToken() {
        throw new Error("refreshToken should not be called without refresh token");
      },
    } as never,
    log: logger,
  });

  const result = await handler(createCredential({ refreshToken: undefined }));
  assert.equal(result, null);
  assert.equal(logger.infoEntries.length, 0);
  assert.equal(logger.warnEntries.length, 0);
});

test("createFactoryRefreshHandler returns null when no refresh token exists", async () => {
  const logger = createLogger();
  const handler = createFactoryRefreshHandler({
    keyPool: {
      updateAccountCredential() {},
      markRateLimited() {},
      getExpiredAccountsWithRefreshTokens() { return []; },
      async getAllAccounts() { return []; },
    },
    runtimeCredentialStore: {
      async upsertOAuthAccount() {
        throw new Error("upsertOAuthAccount should not be called without refresh token");
      },
    } as never,
    log: logger,
  });

  const result = await handler(createCredential({ providerId: "factory", refreshToken: undefined }));
  assert.equal(result, null);
  assert.equal(logger.infoEntries.length, 0);
  assert.equal(logger.warnEntries.length, 0);
});
