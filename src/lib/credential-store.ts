import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProviderAuthType } from "./key-pool.js";

interface NormalizedAccount {
  id: string;
  token: string;
  authType: ProviderAuthType;
  refreshToken?: string;
  expiresAt?: number;
  chatgptAccountId?: string;
}

interface NormalizedProvider {
  id: string;
  authType: ProviderAuthType;
  accounts: NormalizedAccount[];
}

interface NormalizedCredentials {
  providers: Record<string, NormalizedProvider>;
}

export interface CredentialAccountView {
  readonly id: string;
  readonly authType: ProviderAuthType;
  readonly secretPreview: string;
  readonly secret?: string;
  readonly refreshTokenPreview?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
}

export interface CredentialProviderView {
  readonly id: string;
  readonly authType: ProviderAuthType;
  readonly accountCount: number;
  readonly accounts: CredentialAccountView[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeProviderId(providerId: string, fallback: string): string {
  const normalized = providerId.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeAuthType(raw: unknown): ProviderAuthType {
  const value = asString(raw)?.trim().toLowerCase();
  if (!value || value === "api_key" || value === "api-key") {
    return "api_key";
  }

  if (value === "oauth" || value === "oauth_bearer" || value === "oauth-bearer") {
    return "oauth_bearer";
  }

  return "api_key";
}

function accountTokenFromRaw(account: unknown, authType: ProviderAuthType): string | undefined {
  if (typeof account === "string") {
    const token = account.trim();
    return token.length > 0 ? token : undefined;
  }

  if (!isRecord(account)) {
    return undefined;
  }

  const keys = authType === "oauth_bearer"
    ? ["access_token", "token", "bearer_token", "api_key", "key"]
    : ["api_key", "key", "token", "access_token"];

  for (const key of keys) {
    const token = asString(account[key])?.trim();
    if (token && token.length > 0) {
      return token;
    }
  }

  return undefined;
}

function accountIdFromRaw(providerId: string, index: number, account: unknown): string {
  if (!isRecord(account)) {
    return `${providerId}-${index + 1}`;
  }

  const id = asString(account.id) ??
    asString(account.account_id) ??
    asString(account.name) ??
    asString(account.label);

  const normalized = id?.trim();
  if (normalized && normalized.length > 0) {
    return normalized;
  }

  return `${providerId}-${index + 1}`;
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return `${secret.slice(0, 2)}***${secret.slice(-2)}`;
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeAccounts(
  providerId: string,
  authType: ProviderAuthType,
  rawAccounts: unknown,
): NormalizedAccount[] {
  if (!Array.isArray(rawAccounts)) {
    return [];
  }

  const uniqueTokens = new Set<string>();
  const accounts: NormalizedAccount[] = [];

  for (const [index, rawAccount] of rawAccounts.entries()) {
    const token = accountTokenFromRaw(rawAccount, authType);
    if (!token || uniqueTokens.has(token)) {
      continue;
    }

    uniqueTokens.add(token);

    const refreshToken = isRecord(rawAccount)
      ? asString(rawAccount.refresh_token) ?? asString(rawAccount.refreshToken)
      : undefined;
    const expiresAt = isRecord(rawAccount)
      ? asNumber(rawAccount.expires_at) ?? asNumber(rawAccount.expiresAt)
      : undefined;
    const chatgptAccountId = isRecord(rawAccount)
      ? asString(rawAccount.chatgpt_account_id) ?? asString(rawAccount.chatgptAccountId)
      : undefined;

    accounts.push({
      id: accountIdFromRaw(providerId, index, rawAccount),
      token,
      authType,
      refreshToken,
      expiresAt,
      chatgptAccountId,
    });
  }

  return accounts;
}

function normalizeCredentials(raw: unknown, defaultProviderId: string): NormalizedCredentials {
  const providers: Record<string, NormalizedProvider> = {};
  const fallbackProviderId = normalizeProviderId(defaultProviderId, "default");

  if (Array.isArray(raw)) {
    const accounts = normalizeAccounts(fallbackProviderId, "api_key", raw);
    providers[fallbackProviderId] = {
      id: fallbackProviderId,
      authType: "api_key",
      accounts,
    };
    return { providers };
  }

  if (isRecord(raw) && Array.isArray(raw.keys)) {
    const accounts = normalizeAccounts(fallbackProviderId, "api_key", raw.keys);
    providers[fallbackProviderId] = {
      id: fallbackProviderId,
      authType: "api_key",
      accounts,
    };
    return { providers };
  }

  if (!isRecord(raw) || !isRecord(raw.providers)) {
    return { providers };
  }

  for (const [rawProviderId, rawProvider] of Object.entries(raw.providers)) {
    const providerId = normalizeProviderId(rawProviderId, fallbackProviderId);

    if (Array.isArray(rawProvider)) {
      providers[providerId] = {
        id: providerId,
        authType: "api_key",
        accounts: normalizeAccounts(providerId, "api_key", rawProvider),
      };
      continue;
    }

    if (!isRecord(rawProvider)) {
      continue;
    }

    const authType = normalizeAuthType(rawProvider.auth);
    const accounts = normalizeAccounts(providerId, authType, rawProvider.accounts ?? rawProvider.keys);
    providers[providerId] = {
      id: providerId,
      authType,
      accounts,
    };
  }

  return { providers };
}

function toPersistedJson(normalized: NormalizedCredentials): Record<string, unknown> {
  const providers: Record<string, unknown> = {};

  for (const provider of Object.values(normalized.providers)) {
    const accounts = provider.accounts.map((account) => {
      if (provider.authType === "oauth_bearer") {
        const payload: Record<string, unknown> = {
          id: account.id,
          access_token: account.token,
        };
        if (account.refreshToken) {
          payload.refresh_token = account.refreshToken;
        }
        if (typeof account.expiresAt === "number") {
          payload.expires_at = account.expiresAt;
        }
        if (account.chatgptAccountId) {
          payload.chatgpt_account_id = account.chatgptAccountId;
        }
        return payload;
      }

      return {
        id: account.id,
        api_key: account.token,
      };
    });

    providers[provider.id] = {
      auth: provider.authType,
      accounts,
    };
  }

  return { providers };
}

export class CredentialStore {
  public constructor(
    private readonly filePath: string,
    private readonly defaultProviderId: string,
  ) {}

  public async listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]> {
    const credentials = await this.readNormalized();
    const providers = Object.values(credentials.providers)
      .map((provider): CredentialProviderView => {
        const accounts = provider.accounts.map((account): CredentialAccountView => {
          return {
            id: account.id,
            authType: account.authType,
            secretPreview: maskSecret(account.token),
            secret: revealSecrets ? account.token : undefined,
            refreshTokenPreview: account.refreshToken
              ? maskSecret(account.refreshToken)
              : undefined,
            refreshToken: revealSecrets
              ? account.refreshToken
              : undefined,
            expiresAt: account.expiresAt,
            chatgptAccountId: account.chatgptAccountId,
          };
        });

        return {
          id: provider.id,
          authType: provider.authType,
          accountCount: accounts.length,
          accounts,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return providers;
  }

  public async upsertApiKeyAccount(
    providerId: string,
    accountId: string,
    apiKey: string,
  ): Promise<void> {
    const normalized = await this.readNormalized();
    const id = normalizeProviderId(providerId, this.defaultProviderId);

    const provider = normalized.providers[id] ?? {
      id,
      authType: "api_key" as const,
      accounts: [],
    };

    provider.authType = "api_key";
    provider.accounts = provider.accounts.filter(
      (account) => account.id !== accountId && account.token !== apiKey,
    );
    provider.accounts.push({
      id: accountId,
      token: apiKey,
      authType: "api_key",
    });

    normalized.providers[id] = provider;
    await this.writeNormalized(normalized);
  }

  public async upsertOAuthAccount(
    providerId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    chatgptAccountId?: string,
  ): Promise<void> {
    const normalized = await this.readNormalized();
    const id = normalizeProviderId(providerId, this.defaultProviderId);

    const provider = normalized.providers[id] ?? {
      id,
      authType: "oauth_bearer" as const,
      accounts: [],
    };

    provider.authType = "oauth_bearer";
    provider.accounts = provider.accounts.filter(
      (account) => account.id !== accountId && account.token !== accessToken,
    );
    provider.accounts.push({
      id: accountId,
      token: accessToken,
      authType: "oauth_bearer",
      refreshToken,
      expiresAt,
      chatgptAccountId,
    });

    normalized.providers[id] = provider;
    await this.writeNormalized(normalized);
  }

  private async readNormalized(): Promise<NormalizedCredentials> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(contents);
      return normalizeCredentials(parsed, this.defaultProviderId);
    } catch {
      return { providers: {} };
    }
  }

  private async writeNormalized(normalized: NormalizedCredentials): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload = toPersistedJson(normalized);
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
