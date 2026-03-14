import { readFile } from "node:fs/promises";

import { normalizeEpochMilliseconds } from "../epoch.js";
import type { ProviderCredential, ProviderAuthType } from "../key-pool.js";
import type { Sql } from "./index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function parseJsonCredentials(raw: unknown, defaultProviderId: string): Map<string, { authType: ProviderAuthType; accounts: ProviderCredential[] }> {
  const providers = new Map<string, { authType: ProviderAuthType; accounts: ProviderCredential[] }>();

  function addAccounts(providerId: string, authType: ProviderAuthType, rawAccounts: unknown): void {
    if (!Array.isArray(rawAccounts)) {
      return;
    }

    const seen = new Set<string>();
    const accounts: ProviderCredential[] = [];

    for (const [index, rawAccount] of rawAccounts.entries()) {
      const token = accountTokenFromRaw(rawAccount, authType);
      if (!token || seen.has(token)) {
        continue;
      }
      seen.add(token);

      accounts.push({
        providerId,
        accountId: accountIdFromRaw(providerId, index, rawAccount),
        token,
        authType,
        chatgptAccountId: isRecord(rawAccount)
          ? asString(rawAccount.chatgpt_account_id) ?? asString(rawAccount.chatgptAccountId)
          : undefined,
        planType: isRecord(rawAccount)
          ? asString(rawAccount.plan_type) ?? asString(rawAccount.planType)
          : undefined,
        expiresAt: isRecord(rawAccount)
          ? normalizeEpochMilliseconds(asNumber(rawAccount.expires_at) ?? asNumber(rawAccount.expiresAt))
          : undefined,
        refreshToken: isRecord(rawAccount)
          ? asString(rawAccount.refresh_token) ?? asString(rawAccount.refreshToken)
          : undefined,
      });
    }

    providers.set(providerId, { authType, accounts });
  }

  if (Array.isArray(raw) || (isRecord(raw) && Array.isArray(raw.keys))) {
    const accounts = Array.isArray(raw) ? raw : raw.keys;
    addAccounts(defaultProviderId, "api_key", accounts);
    return providers;
  }

  if (!isRecord(raw) || !isRecord(raw.providers)) {
    return providers;
  }

  for (const [rawProviderId, rawProvider] of Object.entries(raw.providers)) {
    const providerId = rawProviderId.trim() || defaultProviderId;

    if (Array.isArray(rawProvider)) {
      addAccounts(providerId, "api_key", rawProvider);
      continue;
    }

    if (!isRecord(rawProvider)) {
      continue;
    }

    const authType = normalizeAuthType(rawProvider.auth);
    const rawAccounts = rawProvider.accounts ?? rawProvider.keys;
    addAccounts(providerId, authType, rawAccounts);
  }

  return providers;
}

export async function seedFromJsonFile(
  sql: Sql,
  filePath: string,
  defaultProviderId: string,
  options?: { readonly skipExistingProviders?: boolean },
): Promise<{ providers: number; accounts: number }> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return { providers: 0, accounts: 0 };
  }

  const parsed: unknown = JSON.parse(contents);
  return seedFromJsonValue(sql, parsed, defaultProviderId, options);
}

export async function seedFromJsonValue(
  sql: Sql,
  parsed: unknown,
  defaultProviderId: string,
  options?: { readonly skipExistingProviders?: boolean },
): Promise<{ providers: number; accounts: number }> {
  const providers = parseJsonCredentials(parsed, defaultProviderId);
  const skipExistingProviders = options?.skipExistingProviders === true;

  let accountCount = 0;
  for (const [providerId, { authType, accounts }] of providers) {
    if (skipExistingProviders) {
      await sql`
        INSERT INTO providers (id, auth_type)
        VALUES (${providerId}, ${authType})
        ON CONFLICT (id) DO NOTHING
      `;
    } else {
      await sql`
        INSERT INTO providers (id, auth_type)
        VALUES (${providerId}, ${authType})
        ON CONFLICT (id) DO UPDATE SET auth_type = EXCLUDED.auth_type
      `;
    }

    for (const account of accounts) {
      await sql`
        INSERT INTO accounts (id, provider_id, token, refresh_token, expires_at, chatgpt_account_id, plan_type)
        VALUES (
          ${account.accountId},
          ${account.providerId},
          ${account.token},
          ${account.refreshToken ?? null},
          ${account.expiresAt ?? null},
          ${account.chatgptAccountId ?? null},
          ${account.planType ?? null}
        )
        ON CONFLICT (id, provider_id) DO UPDATE SET
          token = EXCLUDED.token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          chatgpt_account_id = EXCLUDED.chatgpt_account_id,
          plan_type = EXCLUDED.plan_type
      `;
      accountCount += 1;
    }
  }

  return { providers: providers.size, accounts: accountCount };
}
