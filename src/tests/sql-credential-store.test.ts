import assert from "node:assert/strict";
import test from "node:test";

import { UPSERT_PROVIDER } from "../lib/db/schema.js";
import { selectLegacyOpenAiDuplicateIds, SqlCredentialStore } from "../lib/db/sql-credential-store.js";

test("selectLegacyOpenAiDuplicateIds removes only legacy openai ids with current siblings", () => {
  const idsToDelete = selectLegacyOpenAiDuplicateIds([
    {
      id: "chatgpt-acct-legacy_1a2b3c4d",
      provider_id: "openai",
      chatgpt_account_id: "chatgpt-acct-legacy",
    },
    {
      id: "chatgpt-acct-legacy-1234abcdef56",
      provider_id: "openai",
      chatgpt_account_id: "chatgpt-acct-legacy",
    },
    {
      id: "chatgpt-acct-current-abcdef123456",
      provider_id: "openai",
      chatgpt_account_id: "chatgpt-acct-current",
    },
    {
      id: "chatgpt-acct-other_89abcdef",
      provider_id: "openai",
      chatgpt_account_id: "chatgpt-acct-other",
    },
    {
      id: "chatgpt-acct-api_01020304",
      provider_id: "requesty",
      chatgpt_account_id: "chatgpt-acct-api",
    },
  ]);

  assert.deepEqual(idsToDelete, ["chatgpt-acct-legacy_1a2b3c4d"]);
});

test("UPSERT_PROVIDER preserves an existing base_url when no replacement is provided", () => {
  assert.match(UPSERT_PROVIDER, /base_url = COALESCE\(EXCLUDED\.base_url, providers\.base_url\)/);
});

test("SqlCredentialStore loadCooldowns normalizes bigint string cooldowns", async () => {
  const store = new SqlCredentialStore({
    unsafe: async (query: string) => {
      if (query.includes("SELECT provider_id, account_id, cooldown_until FROM account_cooldown")) {
        return [{ provider_id: "openai", account_id: "acct-1", cooldown_until: "1780632049684" }];
      }
      return [];
    },
  } as never);

  const cooldowns = await store.loadCooldowns();

  assert.equal(cooldowns.get("openai\0acct-1"), 1780632049684);
  assert.equal(store.getCooldown("openai", "acct-1"), 1780632049684);
});
