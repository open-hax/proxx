import assert from "node:assert/strict";
import test from "node:test";

import { seedApiKeyProvidersFromEnv, seedFromJsonValue } from "../lib/db/json-seeder.js";

interface ProviderRow {
  readonly id: string;
}

function createFakeSql() {
  const providers = new Map<string, string>();
  const accounts = new Map<string, {
    providerId: string;
    token: string;
    refreshToken: string | null;
    expiresAt: number | null;
  }>();

  const sql = async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const query = strings.join("?");

    if (query.includes("INSERT INTO providers")) {
      const providerId = String(values[0]);
      const authType = String(values[1]);
      const exists = providers.has(providerId);
      const doNothing = query.includes("DO NOTHING");

      if (!exists || !doNothing) {
        providers.set(providerId, authType);
        return [{ id: providerId }] as ProviderRow[];
      }

      return [] as ProviderRow[];
    }

    if (query.includes("INSERT INTO accounts")) {
      const accountId = String(values[0]);
      const providerId = String(values[1]);
      const key = `${providerId}:${accountId}`;
      const exists = accounts.has(key);
      const doNothing = query.includes("DO NOTHING");

      if (!exists || !doNothing) {
        accounts.set(key, {
          providerId,
          token: String(values[2]),
          refreshToken: values[3] === null ? null : String(values[3]),
          expiresAt: typeof values[4] === "number" ? values[4] : null,
        });
        return [{ id: accountId }] as ProviderRow[];
      }

      return [] as ProviderRow[];
    }

    throw new Error(`Unhandled SQL in test fake: ${query}`);
  };

  return {
    sql: sql as unknown,
    providers,
    accounts,
  };
}

test("seedFromJsonValue does not overwrite existing DB accounts in seed-only mode", async () => {
  const fake = createFakeSql();

  await seedFromJsonValue(
    fake.sql as never,
    {
      providers: {
        openai: {
          auth: "oauth_bearer",
          accounts: [{ id: "acct-1", access_token: "seed-token-a" }],
        },
      },
    },
    "openai",
    { skipExistingProviders: true },
  );

  await seedFromJsonValue(
    fake.sql as never,
    {
      providers: {
        openai: {
          auth: "oauth_bearer",
          accounts: [
            { id: "acct-1", access_token: "seed-token-b" },
            { id: "acct-2", access_token: "seed-token-c" },
          ],
        },
      },
    },
    "openai",
    { skipExistingProviders: true },
  );

  assert.equal(fake.providers.get("openai"), "oauth_bearer");
  assert.equal(fake.accounts.get("openai:acct-1")?.token, "seed-token-a");
  assert.equal(fake.accounts.get("openai:acct-2")?.token, "seed-token-c");
});

test("seedApiKeyProvidersFromEnv seeds supported env providers into the DB", async () => {
  const fake = createFakeSql();
  const envNames = [
    "GEMINI_API_KEY",
    "GEMINI_PROVIDER_ID",
    "ZAI_API_KEY",
    "ZHIPU_API_KEY",
    "ZAI_PROVIDER_ID",
    "ZHIPU_PROVIDER_ID",
    "ROTUSSY_API_KEY",
    "ROTUSSY_PROVIDER_ID",
    "MISTRAL_API_KEY",
    "MISTRAL_PROVIDER_ID",
    "OPENROUTER_API_KEY",
    "OPENROUTER_PROVIDER_ID",
    "REQUESTY_API_TOKEN",
    "REQUESTY_API_KEY",
    "REQUESTY_PROVIDER_ID",
    "ZEN_API_KEY",
    "ZENMUX_API_KEY",
    "ZEN_PROVIDER_ID",
  ] as const;
  const previous = new Map(envNames.map((name) => [name, process.env[name]]));

  for (const name of envNames) {
    delete process.env[name];
  }

  process.env.ROTUSSY_API_KEY = "rotussy-seed-token"; // pragma: allowlist secret
  process.env.ZAI_API_KEY = "zai-seed-token"; // pragma: allowlist secret

  try {
    const result = await seedApiKeyProvidersFromEnv(fake.sql as never);

    assert.equal(result.providers, 2);
    assert.equal(result.accounts, 2);
    assert.equal(fake.providers.get("rotussy"), "api_key");
    assert.equal(fake.providers.get("zai"), "api_key");
    assert.equal(fake.accounts.get("rotussy:rotussy-env-seed")?.token, "rotussy-seed-token");
    assert.equal(fake.accounts.get("zai:zai-env-seed")?.token, "zai-seed-token");
  } finally {
    for (const name of envNames) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
