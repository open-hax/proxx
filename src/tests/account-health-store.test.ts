import assert from "node:assert/strict";
import test from "node:test";

import { AccountHealthStore } from "../lib/db/account-health-store.js";
import type { Sql } from "../lib/db/index.js";
import type { ProviderCredential } from "../lib/key-pool.js";

test("new accounts start with a full health score and sort ahead of degraded accounts", () => {
  const sql = {
    unsafe: async () => [],
  } as unknown as Sql;
  const store = new AccountHealthStore(sql);

  const degraded: ProviderCredential = {
    providerId: "openai",
    accountId: "acct-degraded",
    token: "tok-degraded",
    authType: "oauth_bearer",
  };
  const fresh: ProviderCredential = {
    providerId: "openai",
    accountId: "acct-fresh",
    token: "tok-fresh",
    authType: "oauth_bearer",
  };

  store.recordFailure(degraded, 429, "rate_limit");

  assert.equal(store.getHealthScore("openai", "acct-fresh"), 1);
  assert.ok(store.getHealthScore("openai", "acct-degraded") < 1);
  assert.deepEqual(
    store.sortCredentialsByHealth([degraded, fresh]).map((credential) => credential.accountId),
    ["acct-fresh", "acct-degraded"],
  );
});
