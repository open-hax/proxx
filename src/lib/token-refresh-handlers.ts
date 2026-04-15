import type { ProviderCredential } from "./key-pool.js";
import type { RuntimeCredentialStore } from "./runtime-credential-store.js";
import type { OpenAiOAuthManager, OAuthTokens } from "./openai-oauth.js";
import { isTerminalOpenAiRefreshError } from "./openai-oauth.js";
import { refreshFactoryOAuthToken, parseJwtExpiry, persistFactoryAuthV2, factoryCredentialNeedsRefresh } from "./factory-auth.js";
import { toErrorMessage } from "./errors/index.js";
import { TokenRefreshManager, type TokenRefreshManagerConfig, type Logger, type RefreshFn } from "./token-refresh-manager.js";

interface TokenRefreshKeyPool {
  updateAccountCredential(providerId: string, oldCredential: ProviderCredential, newCredential: ProviderCredential): void;
  markRateLimited(credential: ProviderCredential, retryAfterMs?: number): void;
  getExpiredAccountsWithRefreshTokens(providerId: string): ProviderCredential[];
  getAllAccounts(providerId: string): Promise<ProviderCredential[]>;
}

export interface TokenRefreshDeps {
  readonly keyPool: TokenRefreshKeyPool;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly oauthManager: OpenAiOAuthManager;
  readonly sqlCredentialStore?: unknown;
  readonly log: Logger;
  readonly config: TokenRefreshManagerConfig;
}

export interface OpenAiRefreshDeps {
  readonly keyPool: TokenRefreshKeyPool;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly oauthManager: OpenAiOAuthManager;
  readonly sqlCredentialStore?: unknown;
  readonly log: Logger;
}

export interface FactoryRefreshDeps {
  readonly keyPool: TokenRefreshKeyPool;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly sqlCredentialStore?: unknown;
  readonly log: Logger;
}

export interface EnsureFreshAccountsDeps {
  readonly keyPool: Pick<TokenRefreshKeyPool, "getExpiredAccountsWithRefreshTokens" | "getAllAccounts">;
  readonly tokenRefreshManager: Pick<TokenRefreshManager, "refresh" | "refreshBatch">;
  readonly shouldRefreshFactoryAccount?: (credential: ProviderCredential) => boolean;
}

export interface TokenRefreshRuntime {
  readonly tokenRefreshManager: TokenRefreshManager;
  readonly refreshExpiredOAuthAccount: RefreshFn;
  readonly refreshFactoryAccount: RefreshFn;
  readonly ensureFreshAccounts: (providerId: string) => Promise<void>;
}

export function createOpenAiRefreshHandler(deps: OpenAiRefreshDeps): RefreshFn {
  return async (credential) => refreshOpenAiAccount(credential, deps);
}

export function createFactoryRefreshHandler(deps: FactoryRefreshDeps): RefreshFn {
  return async (credential) => refreshFactoryAccount(credential, deps);
}

export function createEnsureFreshAccounts(deps: EnsureFreshAccountsDeps): (providerId: string) => Promise<void> {
  const shouldRefreshFactoryAccount = deps.shouldRefreshFactoryAccount ?? factoryCredentialNeedsRefresh;

  return async (providerId: string) => {
    const expired = deps.keyPool.getExpiredAccountsWithRefreshTokens(providerId);
    if (expired.length > 0) {
      await deps.tokenRefreshManager.refreshBatch(expired);
    }

    if (providerId !== "factory") {
      return;
    }

    const allFactoryAccounts = await deps.keyPool.getAllAccounts("factory").catch(() => [] as ProviderCredential[]);
    for (const account of allFactoryAccounts) {
      if (shouldRefreshFactoryAccount(account)) {
        await deps.tokenRefreshManager.refresh(account);
      }
    }
  };
}

export function createTokenRefreshManager(deps: TokenRefreshDeps): TokenRefreshManager {
  const refreshExpiredOAuthAccount = createOpenAiRefreshHandler(deps);
  const refreshFactoryAccount = createFactoryRefreshHandler(deps);

  return new TokenRefreshManager(
    async (credential) => {
      if (credential.providerId === "factory") {
        return refreshFactoryAccount(credential);
      }
      return refreshExpiredOAuthAccount(credential);
    },
    deps.log,
    deps.config,
  );
}

export function createTokenRefreshRuntime(deps: TokenRefreshDeps): TokenRefreshRuntime {
  const refreshExpiredOAuthAccount = createOpenAiRefreshHandler(deps);
  const refreshFactoryAccount = createFactoryRefreshHandler(deps);
  const tokenRefreshManager = createTokenRefreshManager(deps);
  const ensureFreshAccounts = createEnsureFreshAccounts({
    keyPool: deps.keyPool,
    tokenRefreshManager,
  });

  return {
    tokenRefreshManager,
    refreshExpiredOAuthAccount,
    refreshFactoryAccount,
    ensureFreshAccounts,
  };
}

async function refreshOpenAiAccount(
  credential: ProviderCredential,
  deps: OpenAiRefreshDeps,
): Promise<ProviderCredential | null> {
  const { keyPool, runtimeCredentialStore, oauthManager, log } = deps;

  if (!credential.refreshToken) {
    return null;
  }

  log.info({ accountId: credential.accountId, providerId: credential.providerId }, "refreshing expired OAuth token");

  let newTokens: OAuthTokens;
  try {
    newTokens = await oauthManager.refreshToken(credential.refreshToken);
  } catch (error) {
    if (isTerminalOpenAiRefreshError(error)) {
      const disabledCredential: ProviderCredential = {
        ...credential,
        refreshToken: undefined,
      };

      keyPool.updateAccountCredential(credential.providerId, credential, disabledCredential);
      if (typeof credential.expiresAt === "number" && credential.expiresAt <= Date.now()) {
        keyPool.markRateLimited(disabledCredential, 24 * 60 * 60 * 1000);
      }

      await runtimeCredentialStore.upsertOAuthAccount(
        credential.providerId,
        disabledCredential.accountId,
        disabledCredential.token,
        undefined,
        disabledCredential.expiresAt,
        disabledCredential.chatgptAccountId,
        undefined,
        undefined,
        disabledCredential.planType,
      );

      log.warn({
        accountId: credential.accountId,
        providerId: credential.providerId,
        code: (error as { code?: string }).code,
        status: (error as { status?: number }).status,
      }, "disabled terminally invalid OpenAI refresh token; full reauth required");
    }

    throw error;
  }

  const newCredential: ProviderCredential = {
    providerId: credential.providerId,
    accountId: newTokens.accountId,
    token: newTokens.accessToken,
    authType: "oauth_bearer",
    chatgptAccountId: newTokens.chatgptAccountId ?? credential.chatgptAccountId,
    planType: newTokens.planType,
    refreshToken: newTokens.refreshToken ?? credential.refreshToken,
    expiresAt: newTokens.expiresAt,
  };

  keyPool.updateAccountCredential(credential.providerId, credential, newCredential);

  await runtimeCredentialStore.upsertOAuthAccount(
    credential.providerId,
    newCredential.accountId,
    newCredential.token,
    newCredential.refreshToken,
    newCredential.expiresAt,
    newCredential.chatgptAccountId,
    newTokens.email,
    newTokens.subject,
    newTokens.planType,
  );

  log.info({
    accountId: newCredential.accountId,
    providerId: newCredential.providerId,
    expiresAt: newCredential.expiresAt,
  }, "OAuth token refreshed successfully");

  return newCredential;
}

async function refreshFactoryAccount(
  credential: ProviderCredential,
  deps: FactoryRefreshDeps,
): Promise<ProviderCredential | null> {
  const { keyPool, runtimeCredentialStore, log, sqlCredentialStore } = deps;

  if (!credential.refreshToken) {
    return null;
  }

  try {
    log.info({ accountId: credential.accountId, providerId: "factory" }, "refreshing Factory OAuth token via WorkOS");

    const refreshed = await refreshFactoryOAuthToken(credential.refreshToken);
    const expiresAt = refreshed.expiresAt ?? parseJwtExpiry(refreshed.accessToken) ?? undefined;

    const newCredential: ProviderCredential = {
      providerId: "factory",
      accountId: credential.accountId,
      token: refreshed.accessToken,
      authType: "oauth_bearer",
      refreshToken: refreshed.refreshToken,
      expiresAt,
    };

    keyPool.updateAccountCredential("factory", credential, newCredential);

    await runtimeCredentialStore.upsertOAuthAccount(
      "factory",
      newCredential.accountId,
      newCredential.token,
      newCredential.refreshToken,
      newCredential.expiresAt,
    );

    if (!sqlCredentialStore) {
      try {
        await persistFactoryAuthV2(refreshed.accessToken, refreshed.refreshToken);
      } catch {
        // Expected to fail on read-only container filesystems; DB has the data.
      }
    }

    log.info({
      accountId: newCredential.accountId,
      providerId: "factory",
      expiresAt: newCredential.expiresAt,
    }, "Factory OAuth token refreshed successfully");

    return newCredential;
  } catch (error) {
    log.warn({
      error: toErrorMessage(error),
      accountId: credential.accountId,
      providerId: "factory",
    }, "failed to refresh Factory OAuth token");
    return null;
  }
}
