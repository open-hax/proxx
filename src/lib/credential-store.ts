import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProviderAuthType } from "./key-pool.js";
import { normalizeEpochMilliseconds } from "./epoch.js";

interface NormalizedAccount {
  id: string;
  token: string;
  authType: ProviderAuthType;
  refreshToken?: string;
  expiresAt?: number;
  chatgptAccountId?: string;
  email?: string;
  subject?: string;
  planType?: string;
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
  readonly displayName: string;
  readonly secretPreview: string;
  readonly secret?: string;
  readonly refreshTokenPreview?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}

export interface CredentialProviderView {
  readonly id: string;
  readonly authType: ProviderAuthType;
  readonly accountCount: number;
  readonly accounts: CredentialAccountView[];
}

export interface CredentialStoreLike {
  listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]>;
  upsertApiKeyAccount(providerId: string, accountId: string, apiKey: string): Promise<void>;
  upsertOAuthAccount(
    providerId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    chatgptAccountId?: string,
    email?: string,
    subject?: string,
    planType?: string,
  ): Promise<void>;
  removeAccount(providerId: string, accountId: string): Promise<boolean>;
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

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function deriveOAuthMetadataFromToken(token: string): {
  readonly email?: string;
  readonly subject?: string;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
} {
  const claims = parseJwtClaims(token);
  if (!claims) {
    return {};
  }

  const profile = isRecord(claims["https://api.openai.com/profile"])
    ? claims["https://api.openai.com/profile"]
    : undefined;
  const auth = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : undefined;

  const email = (asString(claims.email) ?? asString(profile?.email))?.trim().toLowerCase();
  const subject = asString(claims.sub)?.trim();
  const chatgptAccountId = (asString(claims.chatgpt_account_id)
    ?? asString(auth?.chatgpt_account_id))?.trim();
  const planType = asString(auth?.chatgpt_plan_type)?.trim().toLowerCase();

  return {
    email: email && email.length > 0 ? email : undefined,
    subject: subject && subject.length > 0 ? subject : undefined,
    chatgptAccountId: chatgptAccountId && chatgptAccountId.length > 0 ? chatgptAccountId : undefined,
    planType: planType && planType.length > 0 ? planType : undefined,
  };
}

function accountDisplayName(account: Pick<NormalizedAccount, "email" | "chatgptAccountId" | "id">): string {
  return account.email ?? account.chatgptAccountId ?? account.id;
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
      ? normalizeEpochMilliseconds(asNumber(rawAccount.expires_at) ?? asNumber(rawAccount.expiresAt))
      : undefined;
    const derivedOauthMetadata = authType === "oauth_bearer"
      ? deriveOAuthMetadataFromToken(token)
      : {};
    const chatgptAccountId = isRecord(rawAccount)
      ? asString(rawAccount.chatgpt_account_id) ?? asString(rawAccount.chatgptAccountId) ?? derivedOauthMetadata.chatgptAccountId
      : derivedOauthMetadata.chatgptAccountId;
    const email = isRecord(rawAccount)
      ? asString(rawAccount.email) ?? derivedOauthMetadata.email
      : derivedOauthMetadata.email;
    const subject = isRecord(rawAccount)
      ? asString(rawAccount.subject) ?? asString(rawAccount.sub) ?? derivedOauthMetadata.subject
      : derivedOauthMetadata.subject;
    const planType = isRecord(rawAccount)
      ? asString(rawAccount.plan_type) ?? asString(rawAccount.planType) ?? derivedOauthMetadata.planType
      : derivedOauthMetadata.planType;

    accounts.push({
      id: accountIdFromRaw(providerId, index, rawAccount),
      token,
      authType,
      refreshToken,
      expiresAt,
      chatgptAccountId,
      email,
      subject,
      planType,
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
        if (account.email) {
          payload.email = account.email;
        }
        if (account.subject) {
          payload.subject = account.subject;
        }
        if (account.planType) {
          payload.plan_type = account.planType;
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
            displayName: accountDisplayName(account),
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
            email: account.email,
            subject: account.subject,
            planType: account.planType,
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
    email?: string,
    subject?: string,
    planType?: string,
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
      email,
      subject,
      planType,
    });

    normalized.providers[id] = provider;
    await this.writeNormalized(normalized);
  }

  public async removeAccount(providerId: string, accountId: string): Promise<boolean> {
    const normalized = await this.readNormalized();
    const id = normalizeProviderId(providerId, this.defaultProviderId);
    const provider = normalized.providers[id];
    if (!provider) {
      return false;
    }

    const before = provider.accounts.length;
    provider.accounts = provider.accounts.filter((account) => account.id !== accountId);

    if (provider.accounts.length === before) {
      return false;
    }

    if (provider.accounts.length === 0) {
      delete normalized.providers[id];
    }

    await this.writeNormalized(normalized);
    return true;
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
