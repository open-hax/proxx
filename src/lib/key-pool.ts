import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export type ProviderAuthType = "api_key" | "oauth_bearer";

export interface KeyPoolConfig {
  readonly keysFilePath: string;
  readonly reloadIntervalMs: number;
  readonly defaultCooldownMs: number;
  readonly defaultProviderId: string;
}

export interface ProviderCredential {
  readonly providerId: string;
  readonly accountId: string;
  readonly token: string;
  readonly authType: ProviderAuthType;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
}

export interface KeyPoolStatus {
  readonly providerId: string;
  readonly authType: ProviderAuthType | "unknown";
  readonly totalAccounts: number;
  readonly availableAccounts: number;
  readonly cooldownAccounts: number;
  readonly inFlightAccounts: number;
  readonly nextReadyInMs: number;
}

export interface KeyPoolAccountStatus {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: ProviderAuthType;
  readonly available: boolean;
  readonly inFlight: boolean;
  readonly cooldownUntil?: number;
  readonly nextReadyInMs: number;
}

interface ProviderState {
  readonly authType: ProviderAuthType;
  readonly accounts: ProviderCredential[];
  nextOffset: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim();
  return normalized.length > 0 ? normalized : "default";
}

function parseAuthType(rawAuthType: unknown): ProviderAuthType {
  const authType = asString(rawAuthType)?.trim().toLowerCase();
  if (!authType || authType === "api_key" || authType === "api-key") {
    return "api_key";
  }

  if (authType === "oauth_bearer" || authType === "oauth-bearer" || authType === "oauth") {
    return "oauth_bearer";
  }

  throw new Error(`Unsupported provider auth type: ${String(rawAuthType)}`);
}

function readTokenFromAccount(account: unknown, authType: ProviderAuthType): string | undefined {
  if (typeof account === "string") {
    const token = account.trim();
    return token.length > 0 ? token : undefined;
  }

  if (!isRecord(account)) {
    return undefined;
  }

  const preferredKeys = authType === "oauth_bearer"
    ? ["access_token", "token", "bearer_token", "api_key", "key"]
    : ["api_key", "key", "token", "access_token"];

  for (const key of preferredKeys) {
    const token = asString(account[key])?.trim();
    if (token && token.length > 0) {
      return token;
    }
  }

  return undefined;
}

function deterministicAccountId(providerId: string, token: string): string {
  const chars = createHash("sha256")
    .update(providerId)
    .update("\0")
    .update(token)
    .digest("hex")
    .slice(0, 32)
    .split("");

  chars[12] = "5";
  const variantNibble = Number.parseInt(chars[16] ?? "0", 16);
  chars[16] = ((variantNibble & 0x3) | 0x8).toString(16);

  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readAccountId(providerId: string, index: number, account: unknown, token?: string): string {
  if (!isRecord(account)) {
    return token ? deterministicAccountId(providerId, token) : `${providerId}-${index + 1}`;
  }

  const rawId = asString(account["id"]) ??
    asString(account["name"]) ??
    asString(account["account_id"]) ??
    asString(account["label"]);

  const cleaned = rawId?.trim();
  if (cleaned && cleaned.length > 0) {
    return cleaned;
  }

  return token ? deterministicAccountId(providerId, token) : `${providerId}-${index + 1}`;
}

function readChatgptAccountId(account: unknown): string | undefined {
  if (!isRecord(account)) {
    return undefined;
  }

  const rawAccountId = asString(account["chatgpt_account_id"])
    ?? asString(account["chatgptAccountId"])
    ?? asString(account["upstream_account_id"])
    ?? asString(account["upstreamAccountId"]);
  const normalized = rawAccountId?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function readPlanType(account: unknown): string | undefined {
  if (!isRecord(account)) {
    return undefined;
  }

  const rawPlanType = asString(account["plan_type"])
    ?? asString(account["planType"]);
  const normalized = rawPlanType?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderAccounts(
  providerId: string,
  authType: ProviderAuthType,
  rawAccounts: unknown
): ProviderCredential[] {
  if (!Array.isArray(rawAccounts)) {
    return [];
  }

  const uniqueTokens = new Set<string>();
  const normalized: ProviderCredential[] = [];

  for (const [index, rawAccount] of rawAccounts.entries()) {
    const token = readTokenFromAccount(rawAccount, authType);
    if (!token || uniqueTokens.has(token)) {
      continue;
    }

    uniqueTokens.add(token);
    normalized.push({
      providerId,
      accountId: readAccountId(providerId, index, rawAccount, token),
      token,
      authType,
      chatgptAccountId: readChatgptAccountId(rawAccount),
      planType: readPlanType(rawAccount),
    });
  }

  return normalized;
}

function parseProviderState(providerId: string, rawProvider: unknown): ProviderState {
  if (Array.isArray(rawProvider)) {
    const accounts = normalizeProviderAccounts(providerId, "api_key", rawProvider);
    return {
      authType: "api_key",
      accounts,
      nextOffset: 0
    };
  }

  if (!isRecord(rawProvider)) {
    return {
      authType: "api_key",
      accounts: [],
      nextOffset: 0
    };
  }

  const authType = parseAuthType(rawProvider["auth"]);
  const rawAccounts = rawProvider["accounts"] ?? rawProvider["keys"];
  const accounts = normalizeProviderAccounts(providerId, authType, rawAccounts);
  return {
    authType,
    accounts,
    nextOffset: 0
  };
}

function parseProviders(raw: unknown, defaultProviderId: string): Map<string, ProviderState> {
  const providers = new Map<string, ProviderState>();

  const normalizedDefaultProviderId = normalizeProviderId(defaultProviderId);

  if (Array.isArray(raw) || (isRecord(raw) && Array.isArray(raw["keys"]))) {
    const state = parseProviderState(normalizedDefaultProviderId, Array.isArray(raw) ? raw : raw["keys"]);
    if (state.accounts.length > 0) {
      providers.set(normalizedDefaultProviderId, state);
    }
    return providers;
  }

  if (!isRecord(raw)) {
    throw new Error("Invalid keys JSON: expected an array, {\"keys\": []}, or {\"providers\": {...}}.");
  }

  const rawProviders = isRecord(raw["providers"]) ? raw["providers"] : null;
  if (!rawProviders) {
    throw new Error("Invalid keys JSON: missing top-level \"providers\" object.");
  }

  for (const [rawProviderId, rawProvider] of Object.entries(rawProviders)) {
    const providerId = normalizeProviderId(rawProviderId);
    const state = parseProviderState(providerId, rawProvider);
    if (state.accounts.length === 0) {
      continue;
    }

    providers.set(providerId, state);
  }

  return providers;
}

async function readProvidersFile(path: string, defaultProviderId: string): Promise<Map<string, ProviderState>> {
  const contents = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(contents);
  const providers = parseProviders(parsed, defaultProviderId);

  if (providers.size === 0) {
    throw new Error("No provider accounts found in keys file");
  }

  return providers;
}

function accountCooldownKey(credential: ProviderCredential): string {
  return `${credential.providerId}\0${credential.token}`;
}

export class KeyPool {
  private readonly cooldownByAccountKey = new Map<string, number>();
  private readonly inFlightByAccountKey = new Map<string, number>();
  private providers = new Map<string, ProviderState>();
  private lastReloadAt = 0;
  private reloadInFlight: Promise<void> | null = null;

  public constructor(private readonly config: KeyPoolConfig) {}

  public async warmup(): Promise<void> {
    await this.ensureFreshProviders(true);
  }

  public async getRequestOrder(providerId: string = this.config.defaultProviderId): Promise<ProviderCredential[]> {
    await this.ensureFreshProviders(false);

    const normalizedProviderId = normalizeProviderId(providerId);
    const providerState = this.providers.get(normalizedProviderId);
    if (!providerState || providerState.accounts.length === 0) {
      throw new Error(`No accounts configured for provider: ${normalizedProviderId}`);
    }

    const accountCount = providerState.accounts.length;
    const now = Date.now();
    const startOffset = providerState.nextOffset % accountCount;
    providerState.nextOffset = (providerState.nextOffset + 1) % accountCount;

    const idle: ProviderCredential[] = [];
    const busy: ProviderCredential[] = [];
    for (let index = 0; index < accountCount; index += 1) {
      const credential = providerState.accounts[(startOffset + index) % accountCount];
      if (!credential) {
        continue;
      }

      const cooldownUntil = this.cooldownByAccountKey.get(accountCooldownKey(credential)) ?? 0;
      if (cooldownUntil <= now) {
        if ((this.inFlightByAccountKey.get(accountCooldownKey(credential)) ?? 0) > 0) {
          busy.push(credential);
        } else {
          idle.push(credential);
        }
      }
    }

    return [...idle, ...busy];
  }

  public markInFlight(credential: ProviderCredential): () => void {
    const key = accountCooldownKey(credential);
    const current = this.inFlightByAccountKey.get(key) ?? 0;
    this.inFlightByAccountKey.set(key, current + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = (this.inFlightByAccountKey.get(key) ?? 1) - 1;
      if (next <= 0) {
        this.inFlightByAccountKey.delete(key);
      } else {
        this.inFlightByAccountKey.set(key, next);
      }
    };
  }

  public markRateLimited(credential: ProviderCredential, retryAfterMs?: number): void {
    const cooldown = Math.max(retryAfterMs ?? this.config.defaultCooldownMs, 1000);
    this.cooldownByAccountKey.set(accountCooldownKey(credential), Date.now() + cooldown);
  }

  public async msUntilAnyKeyReady(providerId: string = this.config.defaultProviderId): Promise<number> {
    const status = await this.getStatus(providerId);
    return status.nextReadyInMs;
  }

  public async getStatus(providerId: string = this.config.defaultProviderId): Promise<KeyPoolStatus> {
    await this.ensureFreshProviders(false);

    const normalizedProviderId = normalizeProviderId(providerId);
    const providerState = this.providers.get(normalizedProviderId);
    if (!providerState) {
      return {
        providerId: normalizedProviderId,
        authType: "unknown",
        totalAccounts: 0,
        availableAccounts: 0,
        cooldownAccounts: 0,
        inFlightAccounts: 0,
        nextReadyInMs: 0
      };
    }

    const now = Date.now();
    let availableAccounts = 0;
    let inFlightAccounts = 0;
    let minDelay = Number.POSITIVE_INFINITY;

    for (const credential of providerState.accounts) {
      const cooldownUntil = this.cooldownByAccountKey.get(accountCooldownKey(credential)) ?? 0;
      if ((this.inFlightByAccountKey.get(accountCooldownKey(credential)) ?? 0) > 0) {
        inFlightAccounts += 1;
      }
      if (cooldownUntil <= now) {
        availableAccounts += 1;
        continue;
      }

      minDelay = Math.min(minDelay, cooldownUntil - now);
    }

    const totalAccounts = providerState.accounts.length;
    const nextReadyInMs = availableAccounts > 0
      ? 0
      : Number.isFinite(minDelay)
        ? Math.max(minDelay, 0)
        : 0;

    return {
      providerId: normalizedProviderId,
        authType: providerState.authType,
        totalAccounts,
        availableAccounts,
        cooldownAccounts: Math.max(totalAccounts - availableAccounts, 0),
        inFlightAccounts,
        nextReadyInMs
      };
  }

  public async getAllStatuses(): Promise<Record<string, KeyPoolStatus>> {
    await this.ensureFreshProviders(false);

    const statuses: Record<string, KeyPoolStatus> = {};
    for (const providerId of this.providers.keys()) {
      statuses[providerId] = await this.getStatus(providerId);
    }

    return statuses;
  }

  public async getAllAccountStatuses(): Promise<Record<string, readonly KeyPoolAccountStatus[]>> {
    await this.ensureFreshProviders(false);

    const now = Date.now();
    const statuses: Record<string, readonly KeyPoolAccountStatus[]> = {};

    for (const [providerId, providerState] of this.providers.entries()) {
      statuses[providerId] = providerState.accounts.map((credential) => {
        const key = accountCooldownKey(credential);
        const cooldownUntil = this.cooldownByAccountKey.get(key);
        const inFlight = (this.inFlightByAccountKey.get(key) ?? 0) > 0;
        const available = (cooldownUntil ?? 0) <= now;
        return {
          providerId,
          accountId: credential.accountId,
          authType: credential.authType,
          available,
          inFlight,
          cooldownUntil,
          nextReadyInMs: available || cooldownUntil === undefined ? 0 : Math.max(cooldownUntil - now, 0),
        };
      });
    }

    return statuses;
  }

  private async ensureFreshProviders(forceReload: boolean): Promise<void> {
    const now = Date.now();
    const needsReload =
      forceReload ||
      this.providers.size === 0 ||
      now - this.lastReloadAt >= this.config.reloadIntervalMs;

    if (!needsReload) {
      return;
    }

    if (this.reloadInFlight) {
      await this.reloadInFlight;
      return;
    }

    this.reloadInFlight = this.reloadProviders().finally(() => {
      this.reloadInFlight = null;
    });

    await this.reloadInFlight;
  }

  private async reloadProviders(): Promise<void> {
    this.lastReloadAt = Date.now();

    try {
      const providers = await readProvidersFile(this.config.keysFilePath, this.config.defaultProviderId);
      const previousOffsets = new Map<string, number>();
      for (const [providerId, state] of this.providers.entries()) {
        previousOffsets.set(providerId, state.nextOffset);
      }

      for (const [providerId, state] of providers.entries()) {
        const previousOffset = previousOffsets.get(providerId) ?? 0;
        state.nextOffset = state.accounts.length > 0 ? previousOffset % state.accounts.length : 0;
      }

      this.providers = providers;
      this.pruneCooldownMap();
    } catch (error) {
      if (this.providers.size === 0) {
        throw error;
      }
    }
  }

  private pruneCooldownMap(): void {
    const activeKeys = new Set<string>();

    for (const providerState of this.providers.values()) {
      for (const credential of providerState.accounts) {
        activeKeys.add(accountCooldownKey(credential));
      }
    }

    for (const key of this.cooldownByAccountKey.keys()) {
      if (!activeKeys.has(key)) {
        this.cooldownByAccountKey.delete(key);
      }
    }

    for (const key of this.inFlightByAccountKey.keys()) {
      if (!activeKeys.has(key)) {
        this.inFlightByAccountKey.delete(key);
      }
    }
  }
}
