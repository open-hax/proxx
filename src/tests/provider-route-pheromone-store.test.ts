import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderRoutePheromoneStore } from "../lib/provider-route-pheromone-store.js";

test("ProviderRoutePheromoneStore persists success and failure updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "proxx-provider-route-pheromones-"));
  const filePath = path.join(tempDir, "provider-route-pheromones.json");

  try {
    const store = new ProviderRoutePheromoneStore(filePath, 0);
    await store.warmup();
    assert.equal(store.getPheromone("ollama-a", "qwen3.5:2b-bf16"), 0.5);

    await store.noteSuccess("ollama-a", "qwen3.5:2b-bf16", 0.9);
    const boosted = store.getPheromone("ollama-a", "qwen3.5:2b-bf16");
    assert.ok(boosted > 0.5);

    await store.noteFailure("ollama-a", "qwen3.5:2b-bf16");
    const reduced = store.getPheromone("ollama-a", "qwen3.5:2b-bf16");
    assert.ok(reduced < boosted);
    await store.close();

    const reopened = new ProviderRoutePheromoneStore(filePath, 0);
    await reopened.warmup();
    assert.equal(reopened.getPheromone("ollama-a", "qwen3.5:2b-bf16"), reduced);
    await reopened.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
