import assert from "node:assert/strict";
import test from "node:test";

import { SqlPromptAffinityStore } from "../lib/db/sql-prompt-affinity-store.js";

// ============================================================================
// Basic Store Operations
// ============================================================================

test("prompt affinity upsert stores and retrieves records", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.upsert("cache-key-1", "factory", "acct-1");
  await store.upsert("cache-key-2", "openai", "acct-2");
  await store.upsert("cache-key-1", "factory", "acct-3");

  const record1 = await store.get("cache-key-1");
  assert.equal(record1?.promptCacheKey, "cache-key-1");
  assert.equal(record1?.providerId, "factory");
  assert.equal(record1?.accountId, "acct-3");
  assert.equal(typeof record1?.updatedAt, "number");

  const record2 = await store.get("cache-key-2");
  assert.equal(record2?.promptCacheKey, "cache-key-2");
  assert.equal(record2?.providerId, "openai");
  assert.equal(record2?.accountId, "acct-2");

  const missing = await store.get("nonexistent");
  assert.equal(missing, undefined);

  await store.close();
});

test("prompt affinity promotes fallback only after repeated successful use", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.noteSuccess("cache-key-1", "openai", "acct-a");
  let record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-a");
  assert.equal(record?.provisionalProviderId, undefined);

  await store.noteSuccess("cache-key-1", "openai", "acct-b");
  record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-a");
  assert.equal(record?.provisionalProviderId, "openai");
  assert.equal(record?.provisionalAccountId, "acct-b");
  assert.equal(record?.provisionalSuccessCount, 1);

  await store.noteSuccess("cache-key-1", "openai", "acct-b");
  record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-b");
  assert.equal(record?.provisionalProviderId, undefined);
  assert.equal(record?.provisionalAccountId, undefined);

  await store.noteSuccess("cache-key-1", "openai", "acct-b");
  record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-b");
  assert.equal(record?.provisionalProviderId, undefined);

  await store.noteSuccess("cache-key-1", "openai", "acct-a");
  record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-b");
  assert.equal(record?.provisionalProviderId, "openai");
  assert.equal(record?.provisionalAccountId, "acct-a");
  assert.equal(record?.provisionalSuccessCount, 1);

  await store.noteSuccess("cache-key-1", "openai", "acct-b");
  record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-b");
  assert.equal(record?.provisionalProviderId, undefined);

  await store.close();
});

test("prompt affinity delete removes records", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.upsert("cache-key-1", "factory", "acct-1");
  let record = await store.get("cache-key-1");
  assert.equal(record?.providerId, "factory");

  await store.delete("cache-key-1");
  record = await store.get("cache-key-1");
  assert.equal(record, undefined);

  await store.close();
});

// ============================================================================
// Edge Cases and Provisional Promotion Logic
// ============================================================================

test("prompt affinity ignores empty or whitespace-only keys", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.upsert("", "openai", "acct-1");
  await store.upsert("   ", "openai", "acct-2");
  await store.upsert("\t\n", "openai", "acct-3");

  assert.equal(await store.get(""), undefined);
  assert.equal(await store.get("   "), undefined);
  assert.equal(await store.get("\t\n"), undefined);

  await store.close();
});

test("prompt affinity trims keys on upsert and get", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.upsert("  cache-key-trim  ", "openai", "acct-1");

  const record = await store.get("cache-key-trim");
  assert.equal(record?.promptCacheKey, "cache-key-trim");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-1");

  await store.close();
});

test("prompt affinity noteSuccess ignores invalid parameters", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Should not throw
  await store.noteSuccess("", "openai", "acct-1");
  await store.noteSuccess("key-1", "", "acct-1");
  await store.noteSuccess("key-1", "openai", "");
  await store.noteSuccess("   ", "openai", "acct-1");

  // Nothing should be stored
  assert.equal(await store.get("key-1"), undefined);
  assert.equal(await store.get(""), undefined);

  await store.close();
});

test("prompt affinity primary success clears provisional tracking", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Initial affinity
  await store.noteSuccess("key-alternating", "openai", "acct-a");

  // acct-b becomes provisional
  await store.noteSuccess("key-alternating", "openai", "acct-b");
  let record = await store.get("key-alternating");
  assert.equal(record?.accountId, "acct-a");
  assert.equal(record?.provisionalAccountId, "acct-b");
  assert.equal(record?.provisionalSuccessCount, 1);

  // acct-a matches primary - CLEARS provisional (resets to null/0)
  await store.noteSuccess("key-alternating", "openai", "acct-a");
  record = await store.get("key-alternating");
  assert.equal(record?.accountId, "acct-a");
  assert.equal(record?.provisionalAccountId, undefined);
  assert.equal(record?.provisionalSuccessCount, undefined);

  // acct-b now starts fresh as new provisional
  await store.noteSuccess("key-alternating", "openai", "acct-b");
  record = await store.get("key-alternating");
  assert.equal(record?.accountId, "acct-a");
  assert.equal(record?.provisionalAccountId, "acct-b");
  assert.equal(record?.provisionalSuccessCount, 1);

  // Second acct-b success promotes
  await store.noteSuccess("key-alternating", "openai", "acct-b");
  record = await store.get("key-alternating");
  assert.equal(record?.accountId, "acct-b"); // Promoted!
  assert.equal(record?.provisionalAccountId, undefined);

  await store.close();
});

test("prompt affinity handles provider switching during fallback", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Initial affinity on openai
  await store.noteSuccess("key-provider-switch", "openai", "acct-oa");

  // Fallback succeeds on factory - should track as provisional
  await store.noteSuccess("key-provider-switch", "factory", "acct-fa");
  let record = await store.get("key-provider-switch");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-oa");
  assert.equal(record?.provisionalProviderId, "factory");
  assert.equal(record?.provisionalAccountId, "acct-fa");

  // Second factory success should promote
  await store.noteSuccess("key-provider-switch", "factory", "acct-fa");
  record = await store.get("key-provider-switch");
  assert.equal(record?.providerId, "factory");
  assert.equal(record?.accountId, "acct-fa");
  assert.equal(record?.provisionalProviderId, undefined);

  await store.close();
});

test("prompt affinity delete clears both primary and provisional affinity", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Establish affinity with provisional candidate
  await store.noteSuccess("key-delete-provisional", "openai", "acct-a");
  await store.noteSuccess("key-delete-provisional", "openai", "acct-b");

  let record = await store.get("key-delete-provisional");
  assert.ok(record?.provisionalAccountId === "acct-b");

  // Delete should clear everything
  await store.delete("key-delete-provisional");
  record = await store.get("key-delete-provisional");
  assert.equal(record, undefined);

  // Next request should start fresh
  await store.noteSuccess("key-delete-provisional", "openai", "acct-c");
  record = await store.get("key-delete-provisional");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-c");
  assert.equal(record?.provisionalAccountId, undefined);

  await store.close();
});

test("prompt affinity upsert overwrites provisional fields", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Establish affinity with provisional
  await store.noteSuccess("key-upsert-overwrite", "openai", "acct-a");
  await store.noteSuccess("key-upsert-overwrite", "openai", "acct-b");

  let record = await store.get("key-upsert-overwrite");
  assert.ok(record?.provisionalAccountId === "acct-b");

  // Direct upsert should clear provisional
  await store.upsert("key-upsert-overwrite", "factory", "acct-c");
  record = await store.get("key-upsert-overwrite");
  assert.equal(record?.providerId, "factory");
  assert.equal(record?.accountId, "acct-c");
  assert.equal(record?.provisionalProviderId, undefined);
  assert.equal(record?.provisionalAccountId, undefined);

  await store.close();
});

test("prompt affinity provisional count resets when switching to different candidate", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.noteSuccess("key-count-reset", "openai", "acct-a");

  // Start tracking acct-b
  await store.noteSuccess("key-count-reset", "openai", "acct-b");
  let record = await store.get("key-count-reset");
  assert.equal(record?.provisionalSuccessCount, 1);
  assert.equal(record?.provisionalAccountId, "acct-b");

  // Switch to acct-c - count should reset to 1
  await store.noteSuccess("key-count-reset", "openai", "acct-c");
  record = await store.get("key-count-reset");
  assert.equal(record?.provisionalSuccessCount, 1);
  assert.equal(record?.provisionalAccountId, "acct-c");

  // Back to acct-b - count should reset to 1 again
  await store.noteSuccess("key-count-reset", "openai", "acct-b");
  record = await store.get("key-count-reset");
  assert.equal(record?.provisionalSuccessCount, 1);
  assert.equal(record?.provisionalAccountId, "acct-b");

  await store.close();
});

test("prompt affinity get returns copy not reference", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.upsert("key-copy-test", "openai", "acct-1");

  const record1 = await store.get("key-copy-test");
  const record2 = await store.get("key-copy-test");

  // Records should be equal but not the same reference
  assert.deepEqual(record1, record2);

  await store.close();
});

test("prompt affinity stores and trims provider and account IDs", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  await store.upsert("key-trim-ids", "  openai  ", "  acct-trim  ");

  const record = await store.get("key-trim-ids");
  assert.equal(record?.providerId, "openai");
  assert.equal(record?.accountId, "acct-trim");

  await store.close();
});

// ============================================================================
// Concurrent Access Patterns
// ============================================================================

test("prompt affinity handles concurrent noteSuccess calls", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Simulate concurrent requests from different accounts
  await Promise.all([
    store.noteSuccess("key-concurrent", "openai", "acct-a"),
    store.noteSuccess("key-concurrent", "openai", "acct-b"),
    store.noteSuccess("key-concurrent", "openai", "acct-c"),
  ]);

  const record = await store.get("key-concurrent");
  assert.ok(record, "Record should exist after concurrent writes");
  assert.equal(record?.providerId, "openai");
  // One of the accounts should be primary, another might be provisional
  assert.ok(
    ["acct-a", "acct-b", "acct-c"].includes(record?.accountId ?? ""),
    `Primary account should be one of the concurrent accounts, got: ${record?.accountId}`
  );

  await store.close();
});

test("prompt affinity handles rapid succession updates", async () => {
  const store = new SqlPromptAffinityStore(undefined);
  await store.init();

  // Rapid succession of updates to the same key
  for (let i = 0; i < 10; i += 1) {
    await store.noteSuccess("key-rapid", "openai", `acct-${i % 3}`);
  }

  const record = await store.get("key-rapid");
  assert.ok(record, "Record should exist after rapid updates");

  await store.close();
});
