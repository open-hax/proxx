import assert from "node:assert/strict";
import test from "node:test";

import {
  reorderCandidatesForAffinities,
  reorderCandidatesForAffinity,
  gptModelRequiresPaidPlan,
} from "../lib/provider-strategy/routing/credential-selector.js";

test("reorderCandidatesForAffinities moves preferred candidates to front", () => {
  const candidates = [
    { providerId: "openai", account: { providerId: "openai", accountId: "a1", token: "x", authType: "api_key" as const } },
    { providerId: "openai", account: { providerId: "openai", accountId: "a2", token: "x", authType: "api_key" as const } },
    { providerId: "openai", account: { providerId: "openai", accountId: "a3", token: "x", authType: "api_key" as const } },
  ];

  const result = reorderCandidatesForAffinities(candidates, [{ providerId: "openai", accountId: "a3" }]);
  assert.equal(result[0]!.account.accountId, "a3");
  assert.equal(result.length, 3);
});

test("reorderCandidatesForAffinities returns copy when no preferences", () => {
  const candidates = [
    { providerId: "openai", account: { providerId: "openai", accountId: "a1", token: "x", authType: "api_key" as const } },
  ];

  const result = reorderCandidatesForAffinities(candidates, []);
  assert.deepEqual(result, candidates);
  assert.notStrictEqual(result, candidates);
});

test("reorderCandidatesForAffinity delegates to reorderCandidatesForAffinities", () => {
  const candidates = [
    { providerId: "openai", account: { providerId: "openai", accountId: "a1", token: "x", authType: "api_key" as const } },
    { providerId: "openai", account: { providerId: "openai", accountId: "a2", token: "x", authType: "api_key" as const } },
  ];

  const withPref = reorderCandidatesForAffinity(candidates, { providerId: "openai", accountId: "a2" });
  assert.equal(withPref[0]!.account.accountId, "a2");

  const noPref = reorderCandidatesForAffinity(candidates, undefined);
  assert.deepEqual(noPref, candidates);
});

test("gptModelRequiresPaidPlan returns true for gpt-5.3+", () => {
  assert.ok(gptModelRequiresPaidPlan("gpt-5.3"));
  assert.ok(gptModelRequiresPaidPlan("gpt-5.4"));
  assert.ok(gptModelRequiresPaidPlan("gpt-6"));
  assert.ok(gptModelRequiresPaidPlan("gpt-5-mini"));
  assert.ok(!gptModelRequiresPaidPlan("gpt-5.4-mini"));
  assert.ok(!gptModelRequiresPaidPlan("gpt-5"));
  assert.ok(!gptModelRequiresPaidPlan("gpt-4"));
  assert.ok(!gptModelRequiresPaidPlan("claude-3"));
});
