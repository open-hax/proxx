import assert from "node:assert/strict";
import test from "node:test";

import type { AccountHealthStore } from "../lib/db/account-health-store.js";
import { rankAutoModels } from "../lib/auto-model-selector.js";
import type { RequestLogStore } from "../lib/request-log-store.js";

test("text mentions of images do not force vision-only auto model filtering", () => {
  const ranked = rankAutoModels(
    "auto:cheapest",
    {
      messages: [{ role: "user", content: "Please do not generate an image. Just say hello." }],
    },
    ["gpt-5.4-mini", "deepseek-v3.2"],
    "openai",
  );

  assert.deepEqual(
    ranked.map((entry) => entry.modelId).sort((left, right) => left.localeCompare(right)),
    ["deepseek-v3.2", "gpt-5.4-mini"],
  );
});

test("auto model ranking aggregates perf and health without using model ids as account ids", () => {
  const requestLogStore = {
    getModelPerfSummary(providerId: string, model: string, upstreamMode: string) {
      assert.equal(providerId, "openai");
      assert.equal(upstreamMode, "chat");

      if (model === "gpt-5.4-mini") {
        return {
          providerId,
          accountId: "*",
          model,
          upstreamMode,
          sampleCount: 4,
          ewmaTtftMs: 120,
          ewmaTps: 18,
          ewmaEndToEndTps: 15,
          updatedAt: 1,
        };
      }

      if (model === "deepseek-v3.2") {
        return {
          providerId,
          accountId: "*",
          model,
          upstreamMode,
          sampleCount: 3,
          ewmaTtftMs: 860,
          ewmaTps: 7,
          ewmaEndToEndTps: 6,
          updatedAt: 1,
        };
      }

      return undefined;
    },
    getPerfSummary() {
      throw new Error("rankAutoModels should not use per-account perf lookups here");
    },
  } as unknown as RequestLogStore;

  const accountHealthStore = {
    getAllHealthScores() {
      return [
        { providerId: "openai", accountId: "acct-a", score: 0.9, successCount: 12, failureCount: 1 },
        { providerId: "openai", accountId: "acct-b", score: 0.7, successCount: 9, failureCount: 2 },
      ];
    },
    getHealthScore() {
      throw new Error("rankAutoModels should not use model ids as account ids for health lookups");
    },
  } as unknown as AccountHealthStore;

  const ranked = rankAutoModels(
    "auto:fastest",
    {
      messages: [{ role: "user", content: "hello" }],
    },
    ["gpt-5.4-mini", "deepseek-v3.2"],
    "openai",
    requestLogStore,
    accountHealthStore,
  );

  assert.equal(ranked[0]?.modelId, "gpt-5.4-mini");
  assert.equal(ranked[0]?.observedSpeed, true);
  assert.equal(ranked[0]?.healthScore, 80);
});

test("top-level reasoning_effort marks the request as needing thinking support", () => {
  const ranked = rankAutoModels(
    "auto:cheapest",
    {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }],
      reasoning_effort: "medium",
    },
    ["gpt-5.4-nano", "gpt-5.4-mini", "deepseek-v3.2"],
    "requesty",
  );

  assert.deepEqual(
    ranked.map((entry) => entry.modelId).sort((left, right) => left.localeCompare(right)),
    ["deepseek-v3.2", "gpt-5.4-mini"],
  );
});
