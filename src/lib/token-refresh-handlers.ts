import type { ProviderCredential } from "./key-pool.js";
import type { RuntimeCredentialStore } from "./runtime-credential-store.js";
import type { OpenAiOAuthManager } from "./openai-oauth.js";
import { isTerminalOpenAiRefreshError } from "./openai-oauth.js";
import { refreshFactoryOAuthToken, parseJwtExpiry, persistFactoryAuthV2, factoryCredentialNeedsRefresh } from "./factory-auth.js";
import { toErrorMessage } from "./errors/index.js";
import { kernels } from "./cljs-kernels.js";
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

/**
 * Token refresh handlers. What a credential becomes after a refresh (or a terminal
 * refresh failure), which accounts need refreshing and the Factory/OpenAI dispatch
 * are CLJS (`proxx.auth.refresh`, `proxx.runtime.token-refresh`); the host helpers
 * below (OAuth/WorkOS calls, JWT expiry, persistence) are handed in as hooks.
 */
const hooks = {
  isTerminalOpenAiRefreshError,
  refreshFactoryOAuthToken,
  parseJwtExpiry,
  persistFactoryAuthV2,
  factoryCredentialNeedsRefresh,
  toErrorMessage,
};

export function createOpenAiRefreshHandler(deps: OpenAiRefreshDeps): RefreshFn {
  return kernels.createOpenAiRefreshHandler(deps, hooks);
}

export function createFactoryRefreshHandler(deps: FactoryRefreshDeps): RefreshFn {
  return kernels.createFactoryRefreshHandler(deps, hooks);
}

export function createEnsureFreshAccounts(deps: EnsureFreshAccountsDeps): (providerId: string) => Promise<void> {
  return kernels.createEnsureFreshAccounts(deps, hooks);
}

export function createTokenRefreshManager(deps: TokenRefreshDeps): TokenRefreshManager {
  return new TokenRefreshManager(kernels.createRefreshDispatcher(deps, hooks), deps.log, deps.config);
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
