import assert from "node:assert/strict";
import test from "node:test";

import { setActiveCljsRuntime, type ProxxCljsRuntime } from "../lib/cljs-runtime.js";
import { applyCljsProviderPolicy, shadowPreviewProviderPolicy } from "../lib/policy/cljs-shadow.js";

function createRuntime(
  providers: readonly string[],
  seenInputs?: unknown[],
  providerRoutes?: readonly { readonly providerId: string; readonly baseUrl: string }[],
): ProxxCljsRuntime {
  return {
    normalizeKeys: (value) => value,
    validateEntity: () => ({ status: "ok" }),
    projectPheromone: () => 1,
    routePolicy: () => ({ status: "error", trace: [] }),
    loadPolicyEvidence: async () => ({}),
    loadModelPricingOverrides: () => ([]),
    loadProviderSeedSpecs: () => ([]),
    normalizeReasoningRequest: (_manifestPath, input) => ({ status: "ok", decision: { "request-body": (input as { readonly requestBody?: unknown }).requestBody } }),
    resolveModelAlias: () => ({ status: "ok", alias: null }),
    previewPolicyDecision: (_manifestPath, input) => {
      seenInputs?.push(input);
      return {
        status: "ok",
        decision: {
          status: "ok",
          providers,
          "provider-routes": providerRoutes,
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

test("applyCljsProviderPolicy returns exact routes from authoritative policy decision", () => {
  const debug: Array<Record<string, unknown>> = [];
  const warn: Array<Record<string, unknown>> = [];
  const routes = [
    { providerId: "openai", baseUrl: "https://api.openai.com" },
    { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
    { providerId: "factory", baseUrl: "https://api.factory.ai" },
  ];

  setActiveCljsRuntime(createRuntime(["requesty", "factory"], undefined, [
    { providerId: "requesty", baseUrl: "https://router.requesty.ai/v1" },
    { providerId: "factory", baseUrl: "https://api.factory.ai" },
  ]));
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

test("applyCljsProviderPolicy does not use ambient provider routes as authoritative inputs", () => {
  const seenInputs: unknown[] = [];
  const routes = [
    { providerId: "openai", baseUrl: "https://api.openai.com" },
    { providerId: "factory", baseUrl: "https://api.factory.ai" },
  ];

  setActiveCljsRuntime(createRuntime(["xiaomi"], seenInputs, [
    { providerId: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
  ]));
  try {
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
      requestedModel: "mimo-v2.5-pro",
      routedModel: "mimo-v2.5-pro",
      tenantSettings: {},
      providerRoutes: routes,
    });
    assert.deepEqual(ordered, [{ providerId: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" }]);
    assert.deepEqual((seenInputs[0] as Record<string, unknown>).providerIds, []);
  } finally {
    setActiveCljsRuntime(undefined);
  }
});

test("applyCljsProviderPolicy fails closed when policy omits selected provider route", () => {
  setActiveCljsRuntime(createRuntime(["xiaomi"]));
  try {
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
      requestedModel: "mimo-v2.5-pro",
      routedModel: "mimo-v2.5-pro",
      tenantSettings: {},
      providerRoutes: [{ providerId: "xiaomi", baseUrl: "https://ambient.invalid" }],
    });
    assert.deepEqual(ordered, []);
  } finally {
    setActiveCljsRuntime(undefined);
  }
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
