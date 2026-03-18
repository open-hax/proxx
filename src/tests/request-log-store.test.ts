import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RequestLogStore } from "../lib/request-log-store.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "request-log-store-test-"));

  try {
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("warmup quarantines a corrupted request log file and starts empty", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "request-logs.json");
    const corruptJson = `{
  "entries": [
    {
      "id": "entry-1",
      "timestamp": 1773701127508,
      "providerId": "openai",
      "accountId": "acct-1",
      "authType": "api_key",
      "model": "gpt-5.4",
      "upstreamMode": "responses",
      "upstreamPath": "/v1/responses",
      "status": 200,
      "latencyMs": 125,
      "pro`;

    await writeFile(filePath, corruptJson, "utf8");

    const store = new RequestLogStore(filePath, 100);
    await store.warmup();

    assert.deepEqual(store.snapshot(), []);

    const rewrittenContents = await readFile(filePath, "utf8");
    const rewrittenDb: unknown = JSON.parse(rewrittenContents);
    assert.ok(isRecord(rewrittenDb));
    assert.deepEqual(rewrittenDb.entries, []);
    assert.deepEqual(rewrittenDb.hourlyBuckets, []);
    assert.deepEqual(rewrittenDb.dailyBuckets, []);
    assert.deepEqual(rewrittenDb.accountAccumulators, []);

    const files = await readdir(tempDir);
    const corruptFileName = files.find((file) => file.startsWith("request-logs.json.corrupt-"));
    assert.ok(corruptFileName);
    assert.equal(await readFile(path.join(tempDir, corruptFileName), "utf8"), corruptJson);

    await store.close();
  });
});

test("request log persistence reloads cleanly without leaving temp files behind", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "request-logs.json");
    const store = new RequestLogStore(filePath, 100);
    await store.warmup();

    store.record({
      providerId: "openai",
      accountId: "acct-1",
      authType: "api_key",
      model: "gpt-5.4",
      upstreamMode: "responses",
      upstreamPath: "/v1/responses",
      status: 200,
      latencyMs: 125,
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });

    await store.close();

    const files = await readdir(tempDir);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);

    const reloaded = new RequestLogStore(filePath, 100);
    await reloaded.warmup();

    const entries = reloaded.snapshot();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.providerId, "openai");
    assert.equal(entries[0]?.accountId, "acct-1");
    assert.equal(entries[0]?.model, "gpt-5.4");
    assert.equal(entries[0]?.totalTokens, 20);

    await reloaded.close();
  });
});

test("request log persistence preserves upstream error summaries and factory diagnostics", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "request-logs.json");
    const store = new RequestLogStore(filePath, 100);
    await store.warmup();

    store.record({
      providerId: "factory",
      accountId: "acct-factory",
      authType: "oauth_bearer",
      model: "gpt-5.4",
      upstreamMode: "responses_passthrough",
      upstreamPath: "/api/llm/o/v1/responses",
      status: 403,
      latencyMs: 812,
      error: "Prompt rejected by upstream policy",
      upstreamErrorCode: "policy_violation",
      upstreamErrorType: "invalid_request_error",
      upstreamErrorMessage: "Prompt rejected by upstream policy",
      factoryDiagnostics: {
        requestFormat: "responses",
        promptCacheKeyHash: "sha256:1234567890ab",
        inputItemCount: 2,
        messageCount: 1,
        userMessageCount: 1,
        hasInstructions: true,
        instructionsChars: 128,
        totalTextChars: 1024,
        maxTextBlockChars: 768,
        hasReasoning: true,
        hasCodeFence: true,
        hasXmlLikeTags: true,
        hasOpencodeMarkers: true,
        hasAgentProtocolMarkers: true,
        textFingerprint: "sha256:abcdef123456",
        instructionsFingerprint: "sha256:fedcba654321",
      },
    });

    await store.close();

    const reloaded = new RequestLogStore(filePath, 100);
    await reloaded.warmup();

    const entries = reloaded.snapshot();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.upstreamErrorCode, "policy_violation");
    assert.equal(entry.upstreamErrorType, "invalid_request_error");
    assert.equal(entry.upstreamErrorMessage, "Prompt rejected by upstream policy");
    assert.ok(entry.factoryDiagnostics);
    assert.equal(entry.factoryDiagnostics.requestFormat, "responses");
    assert.equal(entry.factoryDiagnostics.promptCacheKeyHash, "sha256:1234567890ab");
    assert.equal(entry.factoryDiagnostics.hasOpencodeMarkers, true);
    assert.equal(entry.factoryDiagnostics.hasAgentProtocolMarkers, true);
    assert.equal(entry.factoryDiagnostics.textFingerprint, "sha256:abcdef123456");

    await reloaded.close();
  });
});

test("warmup backfills missing derived cost/env estimates from token counts and persists daily model/account buckets", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "request-logs.json");
    const payload = {
      entries: [
        {
          id: "entry-1",
          timestamp: Date.UTC(2026, 2, 16, 23, 15, 0),
          providerId: "openai",
          accountId: "acct-1",
          authType: "oauth_bearer",
          model: "gpt-5.4",
          upstreamMode: "responses",
          upstreamPath: "/v1/responses",
          status: 200,
          latencyMs: 250,
          promptTokens: 1000,
          completionTokens: 200,
          totalTokens: 1200,
          costUsd: 0,
          energyJoules: 0,
          waterEvaporatedMl: 0,
        },
      ],
      hourlyBuckets: [],
      dailyBuckets: [],
      dailyModelBuckets: [],
      dailyAccountBuckets: [],
      accountAccumulators: [],
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");

    const store = new RequestLogStore(filePath, 100);
    await store.warmup();

    const entries = store.snapshot();
    assert.equal(entries.length, 1);
    assert.ok((entries[0]?.costUsd ?? 0) > 0);
    assert.ok((entries[0]?.energyJoules ?? 0) > 0);
    assert.ok((entries[0]?.waterEvaporatedMl ?? 0) > 0);

    const dailyModelBuckets = store.snapshotDailyModelBuckets();
    assert.equal(dailyModelBuckets.length, 1);
    assert.equal(dailyModelBuckets[0]?.providerId, "openai");
    assert.equal(dailyModelBuckets[0]?.model, "gpt-5.4");
    assert.equal(dailyModelBuckets[0]?.totalTokens, 1200);
    assert.ok((dailyModelBuckets[0]?.costUsd ?? 0) > 0);

    const dailyAccountBuckets = store.snapshotDailyAccountBuckets();
    assert.equal(dailyAccountBuckets.length, 1);
    assert.equal(dailyAccountBuckets[0]?.providerId, "openai");
    assert.equal(dailyAccountBuckets[0]?.accountId, "acct-1");
    assert.equal(dailyAccountBuckets[0]?.totalTokens, 1200);
    assert.ok((dailyAccountBuckets[0]?.costUsd ?? 0) > 0);

    const coverage = store.getCoverage();
    assert.equal(coverage.earliestModelBreakdownAtMs, Date.UTC(2026, 2, 16, 0, 0, 0));
    assert.equal(coverage.earliestAccountBreakdownAtMs, Date.UTC(2026, 2, 16, 0, 0, 0));

    await store.close();
  });
});
