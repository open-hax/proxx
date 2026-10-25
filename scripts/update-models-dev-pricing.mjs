#!/usr/bin/env node
// Regenerates resources/data/models-dev-pricing.edn, the models.dev price
// snapshot the CLJS runtime loads (policy contract `:model-pricing-snapshot`).
//
//   node scripts/update-models-dev-pricing.mjs                    fetch models.dev
//   node scripts/update-models-dev-pricing.mjs --from-snapshot f  re-emit a previously
//                                                                 generated JSON snapshot
//                                                                 {generatedAt, sourceUrl, providers}
//
// Output is deterministic: providers are sorted, model order is preserved exactly
// as given (order is semantic for tie-breaking in the lookup), cost keys have a
// fixed order. Pricing facts live in EDN only; there is no TypeScript or JSON copy.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SOURCE_URL = "https://models.dev/api.json";
const EDN_OUTPUT_PATH = new URL("../resources/data/models-dev-pricing.edn", import.meta.url);
const COST_KEYS = [
  ["input", ":input"],
  ["output", ":output"],
  ["reasoning", ":reasoning"],
  ["cache_read", ":cache-read"],
  ["cache_write", ":cache-write"],
];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Compact the upstream models.dev payload to {generatedAt, sourceUrl, providers: {id: {models: {id: cost}}}}. */
export function compactUpstream(upstream, generatedAt, sourceUrl) {
  const providers = {};
  for (const [providerId, provider] of Object.entries(upstream).sort(([l], [r]) => l.localeCompare(r))) {
    const rawModels = isRecord(provider) && isRecord(provider.models) ? provider.models : {};
    const models = {};
    for (const [modelId, model] of Object.entries(rawModels).sort(([l], [r]) => l.localeCompare(r))) {
      const rawCost = isRecord(model) && isRecord(model.cost) ? model.cost : null;
      if (!rawCost) continue;
      const cost = {};
      for (const [key] of COST_KEYS) {
        const value = rawCost[key];
        if (typeof value === "number" && Number.isFinite(value)) cost[key] = value;
      }
      if (Object.keys(cost).length > 0) models[modelId] = cost;
    }
    if (Object.keys(models).length > 0) providers[providerId] = { models };
  }
  return { generatedAt, sourceUrl, providers };
}

const ednString = (value) => JSON.stringify(value);

const ednCost = (cost) =>
  `{${COST_KEYS.filter(([key]) => key in cost).map(([key, kw]) => `${kw} ${JSON.stringify(cost[key])}`).join(" ")}}`;

/** Serialize a snapshot to EDN. Pure and deterministic. */
export function snapshotToEdn(snapshot) {
  const providers = Object.entries(snapshot.providers).sort(([l], [r]) => l.localeCompare(r));
  const body = providers.map(([providerId, provider]) => {
    const models = Object.entries(provider.models)
      .map(([modelId, cost]) => `   [${ednString(modelId)} ${ednCost(cost)}]`)
      .join("\n");
    return `  ${ednString(providerId)}\n  [\n${models}]`;
  });
  return `{:generated-at ${ednString(snapshot.generatedAt)}\n :source-url ${ednString(snapshot.sourceUrl)}\n :providers\n {\n${body.join("\n")}}}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const fromIndex = args.indexOf("--from-snapshot");
  let snapshot;
  if (fromIndex >= 0) {
    snapshot = JSON.parse(await readFile(args[fromIndex + 1], "utf8"));
  } else {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status}`);
    snapshot = compactUpstream(await response.json(), new Date().toISOString(), SOURCE_URL);
  }
  await mkdir(dirname(EDN_OUTPUT_PATH.pathname), { recursive: true });
  await writeFile(EDN_OUTPUT_PATH, snapshotToEdn(snapshot), "utf8");
  console.log(`Wrote ${EDN_OUTPUT_PATH.pathname}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
