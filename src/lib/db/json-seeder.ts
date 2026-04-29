import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { loadFactoryAuthV2, parseJwtExpiry } from "../factory-auth.js";
import { getActiveCljsRuntime } from "../cljs-runtime.js";
import { loadModels } from "../models.js";
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

interface ParsedProviderSeed {
  readonly providerId: string;
  readonly authType: ProviderAuthType;
  readonly accounts: readonly ProviderCredential[];
}

function isProviderAuthType(value: unknown): value is ProviderAuthType {
  return value === "api_key" || value === "oauth_bearer";
}

function parseCredentialSeedWithCljs(raw: unknown, defaultProviderId: string): ParsedProviderSeed[] {
  const runtime = getActiveCljsRuntime();
  if (!runtime) {
    throw new Error("CLJS runtime must be active before provider credential seeding");
  }

  const result = runtime.parseProviderCredentials(raw, defaultProviderId);
  if (result.status !== "ok") {
    return [];
  }

  const providers = Array.isArray(result.providers) ? result.providers : [];
  return providers.flatMap((provider): ParsedProviderSeed[] => {
    if (!isRecord(provider)) {
      return [];
    }

    const providerId = asString(provider.providerId)?.trim();
    const authType = provider.authType;
    const rawAccounts = provider.accounts;
    if (!providerId || !isProviderAuthType(authType) || !Array.isArray(rawAccounts)) {
      return [];
    }

    const accounts = rawAccounts.flatMap((account): ProviderCredential[] => {
      if (!isRecord(account)) {
        return [];
      }

      const accountId = asString(account.accountId)?.trim();
      const token = asString(account.token)?.trim();
      if (!accountId || !token) {
        return [];
      }

      return [{
        providerId,
        accountId,
        token,
        authType,
        chatgptAccountId: asString(account.chatgptAccountId),
        planType: asString(account.planType),
        expiresAt: asNumber(account.expiresAt),
        refreshToken: asString(account.refreshToken),
      }];
    });

    return accounts.length > 0 ? [{ providerId, authType, accounts }] : [];
  });
}

/**
 * Parse a JSON value containing provider credentials into a map of provider entries.
 *
 * The CLJS runtime owns accepted input shapes, normalization, duplicate removal,
 * Malli validation, and removal of providers with no valid credentials. This
 * TypeScript boundary only checks the JS export payload before SQL writes.
 *
 * @param raw - The parsed JSON value containing credential seed data.
 * @param defaultProviderId - Provider id to pass to the CLJS parser for top-level key lists.
 * @returns A map keyed by provider id where each value contains `authType` and parsed accounts.
 */
function parseJsonCredentials(raw: unknown, defaultProviderId: string): Map<string, { authType: ProviderAuthType; accounts: ProviderCredential[] }> {
  return new Map(parseCredentialSeedWithCljs(raw, defaultProviderId).map((provider) => [provider.providerId, {
    authType: provider.authType,
    accounts: [...provider.accounts],
  }]));
}

function firstNonEmptyEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

const ENV_API_KEY_PROVIDER_SPECS = [
  {
    providerIdEnvNames: ["GEMINI_PROVIDER_ID"],
    providerIdFallback: "gemini",
    keyEnvNames: ["GEMINI_API_KEY"],
  },
  {
    providerIdEnvNames: ["ZAI_PROVIDER_ID", "ZHIPU_PROVIDER_ID"],
    providerIdFallback: "zai",
    keyEnvNames: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
  },
  {
    providerIdEnvNames: ["ROTUSSY_PROVIDER_ID"],
    providerIdFallback: "rotussy",
    keyEnvNames: ["ROTUSSY_API_KEY"],
  },
  {
    providerIdEnvNames: ["MISTRAL_PROVIDER_ID"],
    providerIdFallback: "mistral",
    keyEnvNames: ["MISTRAL_API_KEY"],
  },
  {
    providerIdEnvNames: ["XIAOMI_PROVIDER_ID", "MIMO_PROVIDER_ID"],
    providerIdFallback: "xiaomi",
    keyEnvNames: ["XIAOMI_API_KEY", "MIMO_API_KEY"],
  },
  {
    providerIdEnvNames: ["OPENROUTER_PROVIDER_ID"],
    providerIdFallback: "openrouter",
    keyEnvNames: ["OPENROUTER_API_KEY"],
  },
  {
    providerIdEnvNames: ["REQUESTY_PROVIDER_ID"],
    providerIdFallback: "requesty",
    keyEnvNames: ["REQUESTY_API_TOKEN", "REQUESTY_API_KEY"],
  },
  {
    providerIdEnvNames: ["OLLAMA_CLOUD_PROVIDER_ID"],
    providerIdFallback: "ollama-cloud",
    keyEnvNames: ["OLLAMA_CLOUD_API_KEY"],
  },
  {
    providerIdEnvNames: ["ZEN_PROVIDER_ID"],
    providerIdFallback: "zen",
    keyEnvNames: ["ZEN_API_KEY", "ZENMUX_API_KEY"],
  },
] as const;

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

  let providerCount = 0;
  let accountCount = 0;
  for (const [providerId, { authType, accounts }] of providers) {
    if (skipExistingProviders) {
      const insertedProviders = await sql<Array<{ id: string }>>`
        INSERT INTO providers (id, auth_type)
        VALUES (${providerId}, ${authType})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      providerCount += insertedProviders.length;
    } else {
      const upsertedProviders = await sql<Array<{ id: string }>>`
        INSERT INTO providers (id, auth_type)
        VALUES (${providerId}, ${authType})
        ON CONFLICT (id) DO UPDATE SET auth_type = EXCLUDED.auth_type
        RETURNING id
      `;
      providerCount += upsertedProviders.length;
    }

    for (const account of accounts) {
      if (skipExistingProviders) {
        const insertedAccounts = await sql<Array<{ id: string }>>`
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
          ON CONFLICT (id, provider_id) DO NOTHING
          RETURNING id
        `;
        accountCount += insertedAccounts.length;
        continue;
      }

      const upsertedAccounts = await sql<Array<{ id: string }>>`
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
        RETURNING id
      `;
      accountCount += upsertedAccounts.length;
    }
  }

  return { providers: providerCount, accounts: accountCount };
}

/**
 * Seed env-backed API-key providers into the database.
 * After startup, the DB remains the runtime source of truth and these env vars
 * should no longer affect live routing directly.
 */
export async function seedApiKeyProvidersFromEnv(
  sql: Sql,
): Promise<{ providers: number; accounts: number }> {
  const providers: Record<string, { auth: "api_key"; accounts: [{ id: string; api_key: string }] }> = {};

  for (const spec of ENV_API_KEY_PROVIDER_SPECS) {
    const apiKey = firstNonEmptyEnv(spec.keyEnvNames);
    if (!apiKey) {
      continue;
    }

    const providerId = (firstNonEmptyEnv(spec.providerIdEnvNames) ?? spec.providerIdFallback).trim();
    if (!providerId) {
      continue;
    }

    providers[providerId] = {
      auth: "api_key",
      accounts: [{ id: `${providerId}-env-seed`, api_key: apiKey }],
    };
  }

  if (Object.keys(providers).length === 0) {
    return { providers: 0, accounts: 0 };
  }

  return seedFromJsonValue(sql, { providers }, "default", { skipExistingProviders: true });
}

/**
 * Seed Factory OAuth credentials from encrypted auth.v2 files into the DB.
 * Only imports if no factory accounts exist in the DB yet (seed-once behavior).
 * After seeding, the DB is the source of truth; the files are not read again.
 */
export async function seedFactoryAuthFromFiles(
  sql: Sql,
): Promise<{ seeded: boolean }> {
  const existing = await sql<Array<{ id: string }>>`
    SELECT id FROM accounts WHERE provider_id = 'factory' LIMIT 1
  `;
  if (existing.length > 0) {
    return { seeded: false };
  }

  const credentials = await loadFactoryAuthV2();
  if (!credentials) {
    return { seeded: false };
  }

  const expiresAt = parseJwtExpiry(credentials.accessToken) ?? undefined;
  const accountId = `factory-${createHash("sha256").update(credentials.accessToken).digest("hex").slice(0, 12)}`;

  await sql`
    INSERT INTO providers (id, auth_type)
    VALUES ('factory', 'oauth_bearer')
    ON CONFLICT (id) DO UPDATE SET auth_type = 'oauth_bearer'
  `;

  await sql`
    INSERT INTO accounts (id, provider_id, token, refresh_token, expires_at)
    VALUES (
      ${accountId},
      'factory',
      ${credentials.accessToken},
      ${credentials.refreshToken || null},
      ${expiresAt ?? null}
    )
    ON CONFLICT (id, provider_id) DO UPDATE SET
      token = EXCLUDED.token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at
  `;

  return { seeded: true };
}

/**
 * Seed models from a JSON file into the DB.
 * Only imports if no models exist in the DB yet (seed-once behavior).
 */
export async function seedModelsFromFile(
  sql: Sql,
  modelsFilePath: string,
  defaultModels: readonly string[],
): Promise<{ seeded: boolean; count: number }> {
  const models = await loadModels(modelsFilePath, defaultModels);
  let insertedCount = 0;
  for (const modelId of models) {
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO models (id) VALUES (${modelId})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    insertedCount += inserted.length;
  }

  return { seeded: insertedCount > 0, count: insertedCount };
}

/**
 * Load model IDs from the DB. Returns null if the models table is empty
 * (caller should use file-based loading).
 */
export async function loadModelsFromDb(
  sql: Sql,
): Promise<string[] | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM models ORDER BY id
  `;
  if (rows.length === 0) {
    return null;
  }
  return rows.map((r) => r.id);
}

/**
 * Get a config value from the DB.
 */
export async function getConfig<T = unknown>(
  sql: Sql,
  key: string,
): Promise<T | null> {
  const rows = await sql<Array<{ value: T }>>`
    SELECT value FROM config WHERE key = ${key}
  `;
  return rows.length > 0 ? rows[0]!.value : null;
}

/**
 * Set a config value in the DB.
 */
export async function setConfig(
  sql: Sql,
  key: string,
  value: unknown,
): Promise<void> {
  await sql`
    INSERT INTO config (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
  `;
}
