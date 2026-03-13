import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderCredential } from "../lib/key-pool.js";
import { createPolicyEngine, DEFAULT_POLICY_CONFIG } from "../lib/policy/index.js";
import { orderAccountsByPolicy } from "../lib/provider-policy.js";

test("gpt-5.4 policy constraints exclude unsupported free accounts", () => {
  const policy = createPolicyEngine(DEFAULT_POLICY_CONFIG);
  const accounts: readonly ProviderCredential[] = [
    {
      providerId: "openai",
      accountId: "oa-free",
      token: "free-token",
      authType: "oauth_bearer",
      chatgptAccountId: "cgpt-free",
      planType: "free",
    },
    {
      providerId: "openai",
      accountId: "oa-plus",
      token: "plus-token",
      authType: "oauth_bearer",
      chatgptAccountId: "cgpt-plus",
      planType: "plus",
    },
  ];

  const ordered = orderAccountsByPolicy(policy, "openai", accounts, "gpt-5.4", {
    openAiPrefixed: false,
    localOllama: false,
    explicitOllama: false,
  });

  assert.deepEqual(ordered.map((account) => account.accountId), ["oa-plus"]);
});
