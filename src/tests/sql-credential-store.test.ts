import assert from "node:assert/strict";
import test from "node:test";

import { UPSERT_PROVIDER } from "../lib/db/schema.js";
import { selectLegacyOpenAiDuplicateIds } from "../lib/db/sql-credential-store.js";

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
