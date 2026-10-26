import type { ProviderCredential } from "./key-pool.js";
import { kernels } from "./cljs-kernels.js";

export interface TokenRefreshManagerConfig {
  readonly maxConcurrency: number;
  readonly backgroundIntervalMs: number;
  readonly expiryBufferMs: number;
  readonly proactiveRefreshWindowMs: number;
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_REFRESH_CONFIG: TokenRefreshManagerConfig = kernels.tokenRefreshDefaultConfig();

export type RefreshFn = (credential: ProviderCredential) => Promise<ProviderCredential | null>;

export type Logger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
};

export interface RefreshFailureRecord {
  consecutiveFailures: number;
  lastFailureAt: number;
  backoffUntil: number;
}

/**
 * Coalesces concurrent refreshes per account, backs accounts off after repeated
 * failures and refreshes expiring accounts in the background. Backoff and
 * batching decisions are CLJS (`proxx.auth.refresh`); the in-flight map, failure
 * records and timer are `proxx.runtime.token-refresh`.
 */
export interface TokenRefreshManagerApi {
  refresh(credential: ProviderCredential): Promise<ProviderCredential | null>;
  refreshBatch(credentials: readonly ProviderCredential[]): Promise<(ProviderCredential | null)[]>;
  startBackgroundRefresh(getExpiringAccounts: () => ProviderCredential[]): void;
  stopBackgroundRefresh(): void;
  stopAndWait(): Promise<void>;
  readonly pendingCount: number;
  isAccountBackedOff(credential: ProviderCredential): boolean;
  getFailureRecord(credential: ProviderCredential): RefreshFailureRecord | undefined;
  clearFailures(credential: ProviderCredential): void;
}

export type TokenRefreshManager = TokenRefreshManagerApi;

/** `new TokenRefreshManager(doRefresh, logger, config?)`; a constructor returning an object yields it. */
export const TokenRefreshManager = function TokenRefreshManager(
  doRefresh: RefreshFn,
  logger: Logger,
  config: Partial<TokenRefreshManagerConfig> = {},
): TokenRefreshManagerApi {
  return kernels.createTokenRefreshManager(doRefresh, logger, config);
} as unknown as new (
  doRefresh: RefreshFn,
  logger: Logger,
  config?: Partial<TokenRefreshManagerConfig>,
) => TokenRefreshManagerApi;
