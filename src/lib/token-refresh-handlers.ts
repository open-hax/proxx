import type { ProviderCredential } from "./key-pool.js";
import type { RuntimeCredentialStore } from "./runtime-credential-store.js";
import type { OpenAiOAuthManager } from "./openai-oauth.js";
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
 * Token refresh handlers: CLJS (`proxx.auth.refresh`, `proxx.runtime.token-refresh`),
 * which also supplies the OpenAI/Factory/JWT helpers they use. These are the typed entries.
 */
export function createOpenAiRefreshHandler(deps: OpenAiRefreshDeps): RefreshFn {
  return kernels.createOpenAiRefreshHandler(deps);
}

export function createFactoryRefreshHandler(deps: FactoryRefreshDeps): RefreshFn {
  return kernels.createFactoryRefreshHandler(deps);
}

export function createEnsureFreshAccounts(deps: EnsureFreshAccountsDeps): (providerId: string) => Promise<void> {
  return kernels.createEnsureFreshAccounts(deps);
}

export function createTokenRefreshManager(deps: TokenRefreshDeps): TokenRefreshManager {
  return new TokenRefreshManager(kernels.createRefreshDispatcher(deps), deps.log, deps.config);
}

export function createTokenRefreshRuntime(deps: TokenRefreshDeps): TokenRefreshRuntime {
  return kernels.createTokenRefreshRuntime(deps);
}
