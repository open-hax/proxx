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
    readonly "provider-routes"?: readonly { readonly "provider-id"?: string; readonly "base-url"?: string }[];
    readonly account?: { readonly accountId?: string };
    readonly strategy?: { readonly mode?: string };
  };

  assert.equal(decision.status, "ok");
  assert.equal(decision["route-id"], "gpt-free-blocked");
  assert.equal(decision["provider-id"], "openai");
  assert.deepEqual(decision["provider-routes"], [
    { "provider-id": "openai", "base-url": "https://chatgpt.com/backend-api", paths: { "chat-completions": "/codex/responses/compact", responses: "/codex/responses", "images-generations": "/images/generations" } },
  ]);
  assert.equal(decision.account?.accountId, "plus");
  assert.equal(decision.strategy?.mode, "chat-completions");
});

test("CLJS runtime keeps gpt and mimo routes pinned to their canonical providers", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const gptResult = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    modelId: "gpt-5.4",
    requestKind: "chat",
    tenantSettings: {},
    providerIds: ["openai", "factory", "requesty", "vivgrid"],
  });
  assert.equal(gptResult.status, "ok");
  const gptDecision = gptResult.decision as {
    readonly "route-id"?: string;
    readonly providers?: readonly string[];
    readonly "provider-routes"?: readonly { readonly "provider-id"?: string; readonly "base-url"?: string }[];
  };
  assert.equal(gptDecision["route-id"], "gpt");
  assert.deepEqual(gptDecision.providers, ["openai"]);
  assert.deepEqual(gptDecision["provider-routes"], [
    { "provider-id": "openai", "base-url": "https://chatgpt.com/backend-api", paths: { "chat-completions": "/codex/responses/compact", responses: "/codex/responses", "images-generations": "/images/generations" } },
  ]);

  const mimoResult = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    modelId: "mimo-v2.5-pro",
    requestKind: "chat",
    tenantSettings: {},
    providerIds: ["openai", "xiaomi", "requesty", "vivgrid"],
  });
  assert.equal(mimoResult.status, "ok");
  const mimoDecision = mimoResult.decision as {
    readonly "route-id"?: string;
    readonly providers?: readonly string[];
    readonly "provider-routes"?: readonly { readonly "provider-id"?: string; readonly "base-url"?: string }[];
  };
  assert.equal(mimoDecision["route-id"], "mimo-v2-5-pro");
  assert.deepEqual(mimoDecision.providers, ["xiaomi"]);
  assert.deepEqual(mimoDecision["provider-routes"], [
    { "provider-id": "xiaomi", "base-url": "https://api.xiaomimimo.com/v1" },
  ]);

  const gemma4E4bResult = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    modelId: "gemma4:e4b",
    requestKind: "chat",
    tenantSettings: {},
    providerIds: ["ollama", "ollama-cloud", "ollama-lan"],
    strategies: [
      { mode: "chat_completions", priority: 1 },
      { mode: "ollama_chat", priority: 2 },
    ],
  });
  assert.equal(gemma4E4bResult.status, "ok");
  const gemma4E4bDecision = gemma4E4bResult.decision as {
    readonly "route-id"?: string;
    readonly providers?: readonly string[];
    readonly "provider-routes"?: readonly { readonly "provider-id"?: string; readonly "base-url"?: string }[];
    readonly strategy?: { readonly mode?: string };
  };
  assert.equal(gemma4E4bDecision["route-id"], "gemma4-e4b");
  assert.deepEqual(gemma4E4bDecision.providers, ["ollama-lan"]);
  assert.deepEqual(gemma4E4bDecision["provider-routes"], [
    { "provider-id": "ollama-lan", "base-url": "http://192.168.12.68:11434", "auth-required?": false, paths: { "chat-completions": "/v1/chat/completions" } },
  ]);
  assert.equal(gemma4E4bDecision.strategy?.mode, "chat_completions");
});
