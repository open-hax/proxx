import { kernels } from "./cljs-kernels.js";

export type ProviderAuthType = "api_key" | "oauth_bearer";

export interface CooldownStore {
  loadCooldowns(): Promise<Map<string, number>>;
  persistCooldown(providerId: string, accountId: string, cooldownUntil: number): Promise<void>;
  clearCooldown(providerId: string, accountId: string): Promise<void>;
}

export interface DisabledStore {
  loadDisabledAccounts(): Promise<Set<string>>;
  setAccountDisabled(providerId: string, accountId: string, disabled: boolean): Promise<void>;
}

export interface KeyPoolConfig {
  readonly keysFilePath: string;
  readonly reloadIntervalMs: number;
  readonly defaultCooldownMs: number;
  readonly defaultProviderId: string;
  readonly accountStore?: ProviderAccountStore;
  readonly cooldownStore?: CooldownStore;
  readonly disabledStore?: DisabledStore;
  readonly preferAccountStoreProviders?: boolean;
  readonly expiryBufferMs?: number;
  readonly cooldownJitterFactor?: number;
  readonly enableRandomWalk?: boolean;
  /** Policy manifest whose `:provider-seed` contracts name the environment seeds. */
  readonly policyManifestPath?: string;
}

export interface ProviderCredential {
  readonly providerId: string;
  readonly accountId: string;
  readonly token: string;
  readonly authType: ProviderAuthType;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

export interface KeyPoolStatus {
  readonly providerId: string;
  readonly authType: ProviderAuthType | "unknown";
  readonly totalAccounts: number;
  readonly availableAccounts: number;
  readonly cooldownAccounts: number;
  readonly disabledAccounts: number;
  readonly expiredAccounts: number;
  readonly inFlightAccounts: number;
  readonly nextReadyInMs: number;
}

export interface KeyPoolAccountStatus {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: ProviderAuthType;
  readonly available: boolean;
  readonly disabled: boolean;
  readonly expired: boolean;
  readonly inFlight: boolean;
  readonly cooldownUntil?: number;
  readonly expiresAt?: number;
  readonly nextReadyInMs: number;
}

export interface ProviderAccountStore {
  getAllProviders(): Promise<Map<string, { authType: ProviderAuthType }>>;
  getAllAccounts(): Promise<Map<string, ProviderCredential[]>>;
}

/**
 * Provider account rotation. All decisions are made by the immutable pool state
 * machine in CLJS (`proxx.keypool.pool`); this class is the stable entry point
 * and supplies the host collaborators (hashing, telemetry, Factory OAuth).
 */
export interface KeyPoolApi {
  warmup(): Promise<void>;
  getRequestOrder(providerId?: string): Promise<ProviderCredential[]>;
  getAllAccounts(providerId?: string): Promise<ProviderCredential[]>;
  updateAccountCredential(providerId: string, oldCredential: ProviderCredential, newCredential: ProviderCredential): void;
  getRequestOrderWithRefresh(
    providerId: string | undefined,
    refreshExpiredToken: (credential: ProviderCredential) => Promise<ProviderCredential | null>,
  ): Promise<ProviderCredential[]>;
  isAccountExpired(credential: ProviderCredential): boolean;
  getExpiredAccountsWithRefreshTokens(providerId?: string): ProviderCredential[];
  getExpiringAccounts(windowMs: number): ProviderCredential[];
  getAllExpiredWithRefreshTokens(): ProviderCredential[];
  markInFlight(credential: ProviderCredential): () => void;
  markRateLimited(credential: ProviderCredential, retryAfterMs?: number): void;
  markModelUnsupported(credential: ProviderCredential, modelId: string, retryAfterMs?: number): void;
  setAccountCooldownUntil(providerId: string, accountId: string, cooldownUntil: number): void;
  clearAccountCooldown(providerId: string, accountId: string): void;
  isModelUnsupported(providerId: string, accountId: string, modelId: string): boolean;
  clearModelUnsupported(providerId: string, accountId: string, modelId: string): void;
  clearProviderCooldowns(providerId: string): void;
  msUntilAnyKeyReady(providerId?: string): Promise<number>;
  getStatus(providerId?: string): Promise<KeyPoolStatus>;
  getAllStatuses(): Promise<Record<string, KeyPoolStatus>>;
  getAllAccountStatuses(): Promise<Record<string, readonly KeyPoolAccountStatus[]>>;
  disableAccount(providerId: string, accountId: string): void;
  enableAccount(providerId: string, accountId: string): void;
  isAccountDisabled(providerId: string, accountId: string): boolean;
  getDisabledAccounts(): Array<{ providerId: string; accountId: string }>;
}

export type KeyPool = KeyPoolApi;

/**
 * `new KeyPool(config, rng?)` builds the CLJS pool (`proxx.runtime.keypool`, which
 * owns the policy seeds, hashing, telemetry and Factory auth defaults); a
 * constructor that returns an object yields that object.
 */
export const KeyPool = function KeyPool(config: KeyPoolConfig, rng?: () => number): KeyPoolApi {
  return kernels.createKeyPoolDefault(config, rng) as KeyPoolApi;
} as unknown as new (config: KeyPoolConfig, rng?: () => number) => KeyPoolApi;
