import assert from "node:assert/strict";
import test from "node:test";

import { setActiveCljsRuntime, type ProxxCljsRuntime } from "../lib/cljs-runtime.js";
import { applyCljsProviderPolicy, shadowPreviewProviderPolicy } from "../lib/policy/cljs-shadow.js";

function createRuntime(providers: readonly string[], seenInputs?: unknown[]): ProxxCljsRuntime {
  return {
    normalizeKeys: (value) => value,
    validateEntity: () => ({ status: "ok" }),
    projectPheromone: () => 1,
    routePolicy: () => ({ status: "error", trace: [] }),
    loadPolicyEvidence: async () => ({}),
    previewPolicyDecision: (_manifestPath, input) => {
      seenInputs?.push(input);
      return {
        status: "ok",
        decision: {
          status: "ok",
          providers,
          "route-id": "gpt",
        },
      };
    },
  };
}

test("shadowPreviewProviderPolicy logs match without mutating route order", () => {
  const debug: Array<Record<string, unknown>> = [];
  const warn: Array<Record<string, unknown>> = [];
  const routes = [
    { providerId: "openai", baseUrl: "https://api.openai.com" },
    { providerId: "factory", baseUrl: "https://api.factory.ai" },
  ];

  setActiveCljsRuntime(createRuntime(["openai", "factory"]));
  try {
    shadowPreviewProviderPolicy({
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
        cljsPolicyShadowMode: true,
      },
      log: {
        debug: (bindings) => debug.push(bindings),
        warn: (bindings) => warn.push(bindings),
      },
      requestKind: "chat",
      requestedModel: "gpt-5.2",
      routedModel: "gpt-5.2",
      tenantSettings: {},
      providerRoutes: routes,
    });
  } finally {
    setActiveCljsRuntime(undefined);
  }

  assert.deepEqual(routes.map((route) => route.providerId), ["openai", "factory"]);
  assert.equal(debug.length, 1);
  assert.equal(warn.length, 0);
  assert.deepEqual(debug[0]?.cljsProviderIds, ["openai", "factory"]);
});

test("shadowPreviewProviderPolicy passes policy evidence into preview input", () => {
  const debug: Array<Record<string, unknown>> = [];
  const seenInputs: unknown[] = [];

  setActiveCljsRuntime(createRuntime(["requesty"], seenInputs));
  try {
    shadowPreviewProviderPolicy({
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
        cljsPolicyShadowMode: true,
      },
      log: {
        debug: (bindings) => debug.push(bindings),
        warn: () => undefined,
      },
      requestKind: "chat",
      requestedModel: "novel-model",
      routedModel: "novel-model",
      tenantSettings: {},
      providerRoutes: [{ providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" }],
      policyEvidence: {
        "models-dev/provider-models": {},
        "provider-model-snapshots": { requesty: { "novel-model": true } },
      },
    });
  } finally {
    setActiveCljsRuntime(undefined);
  }

  assert.equal(debug.length, 1);
  assert.deepEqual((seenInputs[0] as Record<string, unknown>)["provider-model-snapshots"], {
    requesty: { "novel-model": true },
  });
});

test("applyCljsProviderPolicy filters and reorders routes in authoritative mode", () => {
  const debug: Array<Record<string, unknown>> = [];
  const warn: Array<Record<string, unknown>> = [];
  const routes = [
    { providerId: "openai", baseUrl: "https://api.openai.com" },
    { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
    { providerId: "factory", baseUrl: "https://api.factory.ai" },
  ];

  setActiveCljsRuntime(createRuntime(["requesty", "factory"]));
  try {
    const ordered = applyCljsProviderPolicy({
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
        cljsPolicyShadowMode: false,
        cljsPolicyAuthoritative: true,
      },
      log: {
        debug: (bindings) => debug.push(bindings),
        warn: (bindings) => warn.push(bindings),
      },
      requestKind: "chat",
      requestedModel: "novel-model",
      routedModel: "novel-model",
      tenantSettings: {},
      providerRoutes: routes,
    });
    assert.deepEqual(ordered.map((route) => route.providerId), ["requesty", "factory"]);
  } finally {
    setActiveCljsRuntime(undefined);
  }

  assert.ok(debug.some((entry) => Array.isArray(entry.providerIds)));
  assert.equal(warn.length, 1);
});

test("applyCljsProviderPolicy fails closed in authoritative mode when runtime is unavailable", () => {
  setActiveCljsRuntime(undefined);
  const ordered = applyCljsProviderPolicy({
    config: {
      cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
      cljsPolicyShadowMode: false,
      cljsPolicyAuthoritative: true,
    },
    log: {
      debug: () => undefined,
      warn: () => undefined,
    },
    requestKind: "chat",
    requestedModel: "novel-model",
    routedModel: "novel-model",
    tenantSettings: {},
    providerRoutes: [{ providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" }],
  });

  assert.deepEqual(ordered, []);
});

test("shadowPreviewProviderPolicy logs mismatch only when shadow mode is enabled", () => {
  const warn: Array<Record<string, unknown>> = [];
  const config = {
    cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
    cljsPolicyShadowMode: false,
  };

  setActiveCljsRuntime(createRuntime(["factory", "openai"]));
  try {
    shadowPreviewProviderPolicy({
      config,
      log: {
        debug: () => undefined,
        warn: (bindings) => warn.push(bindings),
      },
      requestKind: "chat",
      requestedModel: "gpt-5.2",
      routedModel: "gpt-5.2",
      tenantSettings: {},
      providerRoutes: [
        { providerId: "openai", baseUrl: "https://api.openai.com" },
        { providerId: "factory", baseUrl: "https://api.factory.ai" },
      ],
    });
    assert.equal(warn.length, 0);

    shadowPreviewProviderPolicy({
      config: { ...config, cljsPolicyShadowMode: true },
      log: {
        debug: () => undefined,
        warn: (bindings) => warn.push(bindings),
      },
      requestKind: "chat",
      requestedModel: "gpt-5.2",
      routedModel: "gpt-5.2",
      tenantSettings: {},
      providerRoutes: [
        { providerId: "openai", baseUrl: "https://api.openai.com" },
        { providerId: "factory", baseUrl: "https://api.factory.ai" },
      ],
    });
  } finally {
    setActiveCljsRuntime(undefined);
  }

  assert.equal(warn.length, 1);
  assert.deepEqual(warn[0]?.inputProviderIds, ["openai", "factory"]);
  assert.deepEqual(warn[0]?.cljsProviderIds, ["factory", "openai"]);
});
