import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFileMigrations, type MigrationContext } from "../lib/migrations.js";

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function makeCtx(dataDir: string): MigrationContext {
  const logs: string[] = [];
  return { dataDir, log: (msg) => logs.push(msg) };
}

test("migrates legacy request-logs.json to JSONL directory", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "migration-test-"));
  const legacyPath = path.join(tmpDir, "request-logs.json");

  await writeFile(legacyPath, JSON.stringify({
    entries: [
      { id: "a", timestamp: 1, providerId: "p", accountId: "a", model: "m", upstreamMode: "chat_completions", upstreamPath: "/v1/chat/completions", status: 200, latencyMs: 10, authType: "api_key", serviceTierSource: "none" },
    ],
    hourlyBuckets: [
      { startMs: 0, requestCount: 1, errorCount: 0, totalTokens: 10, promptTokens: 5, completionTokens: 5, cachedPromptTokens: 0, cacheHitCount: 0, cacheKeyUseCount: 0, fastModeRequestCount: 0, priorityRequestCount: 0, standardRequestCount: 1 },
    ],
    accountAccumulators: [
      { providerId: "p", accountId: "a", authType: "api_key", requestCount: 1, totalTokens: 10, promptTokens: 5, completionTokens: 5, cachedPromptTokens: 0, cacheHitCount: 0, cacheKeyUseCount: 0, ttftSum: 10, ttftCount: 1, tpsSum: 1, tpsCount: 1, lastUsedAtMs: 1 },
    ],
  }, null, 2), "utf8");

  await runFileMigrations(makeCtx(tmpDir));

  assert.ok(await fileExists(path.join(tmpDir, "request-logs", "entries.jsonl")));
  assert.ok(await fileExists(path.join(tmpDir, "request-logs", "hourly-buckets.jsonl")));
  assert.ok(await fileExists(path.join(tmpDir, "request-logs", "account-accumulators.jsonl")));
  assert.ok(await fileExists(path.join(tmpDir, "request-logs.json.migrated")));
  assert.ok(!await fileExists(legacyPath));

  const entries = (await readFile(path.join(tmpDir, "request-logs", "entries.jsonl"), "utf8")).trim().split("\n");
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(entries[0]).id, "a");

  const stateRaw = await readFile(path.join(tmpDir, ".migrations.json"), "utf8");
  const state = JSON.parse(stateRaw);
  assert.ok(state.applied.includes("001-request-logs-json-to-jsonl"));
});

test("skips already-applied migrations", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "migration-test-"));

  await writeFile(path.join(tmpDir, ".migrations.json"), JSON.stringify({
    applied: ["001-request-logs-json-to-jsonl"],
  }), "utf8");

  await writeFile(path.join(tmpDir, "request-logs.json"), JSON.stringify({ entries: [{ id: "should-not-migrate" }] }), "utf8");

  await runFileMigrations(makeCtx(tmpDir));

  assert.ok(await fileExists(path.join(tmpDir, "request-logs.json")), "legacy file should remain untouched");
  assert.ok(!await fileExists(path.join(tmpDir, "request-logs")), "JSONL dir should not be created");
});

test("handles missing legacy file gracefully", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "migration-test-"));

  await runFileMigrations(makeCtx(tmpDir));

  const stateRaw = await readFile(path.join(tmpDir, ".migrations.json"), "utf8");
  const state = JSON.parse(stateRaw);
  assert.ok(state.applied.includes("001-request-logs-json-to-jsonl"));
});
