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
    { "provider-id": "factory", "base-url": "https://api.factory.ai", paths: { "chat-completions": "/v1/chat/completions", responses: "/v1/responses", "images-generations": "/v1/images/generations" } },
  ]);
  assert.equal(decision.account?.accountId, "plus");
  assert.equal(decision.strategy?.mode, "chat-completions");
});

test("CLJS runtime routes bare qwen3 embeddings through the declarative embedding provider order", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const result = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    modelId: "qwen3-embedding:0.6b",
    requestKind: "embeddings",
    tenantSettings: {},
    providerIds: ["openai", "ollama", "llamacpp-embed", "requesty"],
    strategies: [
      { mode: "embeddings", priority: 1 },
    ],
  });

  assert.equal(result.status, "ok");
  const decision = result.decision as {
    readonly "route-id"?: string;
    readonly providers?: readonly string[];
    readonly "provider-id"?: string;
    readonly "provider-routes"?: readonly { readonly "provider-id"?: string; readonly "base-url"?: string }[];
    readonly strategy?: { readonly mode?: string };
  };
  assert.equal(decision["route-id"], "qwen3-embedding");
  assert.equal(decision["provider-id"], "llamacpp-embed");
  assert.deepEqual(decision.providers, ["llamacpp-embed", "ollama"]);
  assert.deepEqual(decision["provider-routes"], [
    { "provider-id": "llamacpp-embed", "base-url": "http://llamacpp-embed:8081", "auth-required?": false, paths: { embeddings: "/v1/embeddings" } },
    { "provider-id": "ollama", "base-url": "http://ollama:11434", "auth-required?": false, paths: { embeddings: "/api/embed", "chat-completions": "/v1/chat/completions" } },
  ]);
  assert.equal(decision.strategy?.mode, "embeddings");
});

test("CLJS runtime constrains embeddings to requested provider facts before tenant enforcement", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  const baseInput = {
    modelId: "qwen3-embedding:0.6b",
    requestKind: "embeddings",
    providerIds: ["llamacpp-embed", "ollama", "ollama-lan"],
    requestedProviderIds: ["ollama"],
    strategiesByProvider: {
      "llamacpp-embed": [{ mode: "embeddings", priority: 0 }],
      ollama: [{ mode: "embeddings", priority: 1 }],
      "ollama-lan": [{ mode: "embeddings", priority: 1 }],
    },
  };

  const allowedResult = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    ...baseInput,
    tenantSettings: {},
  });
  const disabledResult = loaded.runtime.previewPolicyDecision("resources/policies/runtime/00-manifest.edn", {
    ...baseInput,
    tenantSettings: { disabledProviderIds: ["ollama"] },
  });

  assert.equal(allowedResult.status, "ok");
  const allowedDecision = allowedResult.decision as {
    readonly status?: string;
    readonly providers?: readonly string[];
    readonly "provider-id"?: string;
    readonly "provider-routes"?: readonly { readonly "provider-id"?: string; readonly "base-url"?: string }[];
  };
  assert.equal(allowedDecision.status, "ok");
  assert.deepEqual(allowedDecision.providers, ["ollama"]);
  assert.equal(allowedDecision["provider-id"], "ollama");
  assert.deepEqual(allowedDecision["provider-routes"], [
    { "provider-id": "ollama", "base-url": "http://ollama:11434", "auth-required?": false, paths: { embeddings: "/api/embed", "chat-completions": "/v1/chat/completions" } },
  ]);

  assert.equal(disabledResult.status, "ok");
  const disabledDecision = disabledResult.decision as {
    readonly status?: string;
    readonly reason?: string;
    readonly providers?: readonly string[];
  };
  assert.equal(disabledDecision.status, "exhausted");
  assert.equal(disabledDecision.reason, "no-provider-candidates");
  assert.deepEqual(disabledDecision.providers, []);
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
  assert.deepEqual(gptDecision.providers, ["vivgrid", "openai", "requesty", "factory"]);
  assert.deepEqual(gptDecision["provider-routes"], [
    { "provider-id": "vivgrid", "base-url": "https://api.vivgrid.com", paths: { "chat-completions": "/v1/chat/completions", responses: "/v1/responses", messages: "/v1/messages", "images-generations": "/v1/images/generations" } },
    { "provider-id": "openai", "base-url": "https://chatgpt.com/backend-api", paths: { "chat-completions": "/codex/responses/compact", responses: "/codex/responses", "images-generations": "/images/generations" } },
    { "provider-id": "requesty", "base-url": "https://router.requesty.ai/v1" },
    { "provider-id": "factory", "base-url": "https://api.factory.ai", paths: { "chat-completions": "/v1/chat/completions", responses: "/v1/responses", "images-generations": "/v1/images/generations" } },
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
  assert.deepEqual(gemma4E4bDecision.providers, ["ollama", "ollama-lan"]);
  assert.deepEqual(gemma4E4bDecision["provider-routes"], [
    { "provider-id": "ollama", "base-url": "http://ollama:11434", "auth-required?": false, paths: { embeddings: "/api/embed", "chat-completions": "/v1/chat/completions" } },
    { "provider-id": "ollama-lan", "base-url": "http://192.168.12.68:11434", "auth-required?": false, paths: { embeddings: "/api/embed", "chat-completions": "/v1/chat/completions" } },
  ]);
  assert.equal(gemma4E4bDecision.strategy?.mode, "chat_completions");
});

test("CLJS runtime orders federation projected accounts from declarative policy", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  assert.equal(typeof loaded.runtime.resolveFederationRouteCandidates, "function");
  const result = loaded.runtime.resolveFederationRouteCandidates?.("resources/policies/runtime/00-manifest.edn", {
    requestKind: "responses",
    providerIds: ["openai"],
    nowMs: 1000,
    localProviderAccountKeys: ["openai\u0000local-account"],
    projectedAccounts: [
      { sourcePeerId: "peer-b", providerId: "openai", accountId: "descriptor-hot", availabilityState: "descriptor", warmRequestCount: 10, metadata: {} },
      { sourcePeerId: "peer-a", providerId: "openai", accountId: "remote-cold", availabilityState: "remote_route", warmRequestCount: 0, metadata: {} },
      { sourcePeerId: "peer-c", providerId: "openai", accountId: "remote-hot", availabilityState: "remote_route", warmRequestCount: 5, metadata: {} },
      { sourcePeerId: "peer-d", providerId: "openai", accountId: "cooling", availabilityState: "remote_route", warmRequestCount: 99, metadata: { cooldownUntilMs: 2000 } },
      { sourcePeerId: "peer-e", providerId: "openai", accountId: "local-account", availabilityState: "remote_route", warmRequestCount: 99, metadata: {} },
    ],
  });

  assert.equal(result?.status, "ok");
  const candidates = result?.candidates as readonly { readonly accountId?: string; readonly account_id?: string }[] | undefined;
  assert.deepEqual(candidates?.map((candidate) => candidate.accountId ?? candidate.account_id), [
    "remote-hot",
    "remote-cold",
    "descriptor-hot",
  ]);
});

test("CLJS runtime authorizes tenant-provider share modes from federation policy", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }
  await assertCljsRuntimeReady(loaded.runtime);

  assert.equal(typeof loaded.runtime.authorizeTenantProviderPolicy, "function");
  const basePolicy = {
    ownerSubject: "did:plc:owner",
    providerKind: "peer_proxx",
    shareMode: "warm_import",
    allowedModels: ["gpt-5.5"],
  };

  const relayResult = loaded.runtime.authorizeTenantProviderPolicy?.("resources/policies/runtime/00-manifest.edn", {
    policy: basePolicy,
    ownerSubject: "did:plc:owner",
    providerKind: "peer_proxx",
    requestedModel: "gpt-5.5",
    requiredShareMode: "relay",
  });
  const projectionResult = loaded.runtime.authorizeTenantProviderPolicy?.("resources/policies/runtime/00-manifest.edn", {
    policy: basePolicy,
    ownerSubject: "did:plc:owner",
    providerKind: "peer_proxx",
    requestedModel: "gpt-5.5",
    requiredShareMode: "project_credentials",
  });

  assert.equal(relayResult?.status, "ok");
  assert.equal(relayResult?.allowed, true);
  assert.equal(projectionResult?.status, "ok");
  assert.equal(projectionResult?.allowed, false);
});
