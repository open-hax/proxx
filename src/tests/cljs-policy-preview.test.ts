import assert from "node:assert/strict";
import test from "node:test";

import { assertCljsRuntimeReady, loadCljsRuntime } from "../lib/cljs-runtime.js";

test("CLJS runtime previews declarative policy decisions from manifest", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const result = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    modelId: "gpt-5-mini",
    requestKind: "chat",
    tenantSettings: {
      allowedProviderIds: ["openai", "factory"],
    },
    providerIds: ["rotussy", "factory", "openai"],
    accountsByProvider: {
      openai: [
        { accountId: "free", planType: "free" },
        { accountId: "plus", planType: "plus" },
      ],
      factory: [
        { accountId: "team", planType: "team" },
      ],
    },
    strategiesByProvider: {
      openai: [
        { mode: "chat-completions", priority: 1 },
      ],
      factory: [
        { mode: "openai-responses", priority: 1 },
      ],
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(typeof result.decision, "object");
  assert.notEqual(result.decision, null);

  const decision = result.decision as {
    readonly status?: string;
    readonly "route-id"?: string;
    readonly "provider-id"?: string;
    readonly account?: { readonly accountId?: string };
    readonly strategy?: { readonly mode?: string };
  };

  assert.equal(decision.status, "ok");
  assert.equal(decision["route-id"], "gpt-free-blocked");
  assert.equal(decision["provider-id"], "openai");
  assert.equal(decision.account?.accountId, "plus");
  assert.equal(decision.strategy?.mode, "chat-completions");
});
