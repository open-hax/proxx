import assert from "node:assert/strict";
import test from "node:test";

import { SqlPromptAffinityStore } from "../lib/db/sql-prompt-affinity-store.js";

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
